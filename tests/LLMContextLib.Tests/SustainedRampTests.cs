// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using LLMContextLib.Benchmarks;
using Xunit;

namespace LLMContextLib.Tests;

public sealed class SustainedRampTests
{
    [Theory]
    [InlineData(PreparationPolicy.Speculative)]
    [InlineData(PreparationPolicy.Serialized)]
    public async Task PreparationComparisonRetainsPerMutationEvidenceAndStrictStaleFailures(PreparationPolicy policy)
    {
        var options = new RampOptions
        {
            Rates = [320],
            StageMilliseconds = 250,
            TotalEntries = 128,
            PostReleaseMilliseconds = 0
        };
        var result = await SustainedRamp.Run(new(ParticipantKind.LLMPolymorphic, false, false, 0, options, policy, true));
        Assert.Equal(80, result.Requests.Length);
        var mutations = result.Requests.Where(request => request.Mutation is not null).ToArray();
        Assert.Contains(mutations, request => request.Mutation!.Target == "Session");
        Assert.Contains(mutations, request => request.Mutation!.Target == "Memory");
        Assert.All(mutations.Where(request => request.Category == "StaleCorrect"),
            request => Assert.Equal("InitialRevisionConflict", request.Mutation!.Disposition));
        if (policy == PreparationPolicy.Serialized)
            Assert.DoesNotContain(mutations.Where(request => request.Mutation!.Target == "Session"),
                request => request.Mutation!.Disposition == "PreparedRevisionConflict");
        Assert.All(mutations, request => Assert.True(request.Mutation!.StorageBytes >= request.Mutation.PreparationBytes));
    }

    [Theory]
    [InlineData(ParticipantKind.ConventionalScan, false)]
    [InlineData(ParticipantKind.ConventionalIndexed, true)]
    [InlineData(ParticipantKind.LLMPolymorphic, false)]
    [InlineData(ParticipantKind.LLMPolymorphic, true)]
    public async Task MixedRampExplainsHistoriesAndReleasesReaders(ParticipantKind kind, bool distributed)
    {
        var options = new RampOptions
        {
            Rates = [160, 320],
            StageMilliseconds = 250,
            TotalEntries = 128,
            Workers = 3,
            QueueCapacity = 8,
            PostReleaseMilliseconds = 0
        };
        var result = await SustainedRamp.Run(new(kind, distributed, true, 0, options));
        Assert.Equal("Duration", result.StopReason);
        Assert.Equal(120, result.Requests.Length);
        Assert.All(result.Stages, stage =>
        {
            Assert.Equal(stage.Offered, stage.Completed + stage.Cancelled + stage.QueueRejected);
            Assert.Equal(stage.Admitted, stage.Completed + stage.Cancelled);
            Assert.Equal(stage.Completed, stage.Succeeded + stage.Conflicted + stage.StorageRejected);
            Assert.InRange(stage.QueueAtBoundary, 0, options.QueueCapacity);
        });
        Assert.Contains(result.Requests, request => request.Category == "StaleCorrect" && request.Outcome == "RevisionConflict");
        Assert.Contains(result.Requests, request => request.Category == "MemoryWrite");
        Assert.Contains(result.Requests, request => request.Category == "Delete");
        Assert.Equal(0, result.Memory[^1].HeldLeases);
        if (kind == ParticipantKind.LLMPolymorphic) Assert.Equal(0, result.Memory[^1].EstimatedRetainedBytes);
        Assert.All(result.Latencies, sample => Assert.Null(sample.P99EndToEndMs));
    }

    [Fact]
    public async Task MemoryStopCancelsRatherThanLosingQueuedRequests()
    {
        var options = new RampOptions
        {
            Rates = [100],
            StageMilliseconds = 50,
            TotalEntries = 128,
            MaximumManagedBytes = 1,
            PostReleaseMilliseconds = 0
        };
        var result = await SustainedRamp.Run(new(ParticipantKind.LLMPolymorphic, false, true, 0, options));
        Assert.Equal("ManagedMemoryLimit", result.StopReason);
        Assert.Empty(result.Requests);
        Assert.Equal(0, result.Memory[^1].HeldLeases);
    }

    [Fact]
    public async Task CancellationTerminatesAStartedRampAndDrainsActiveCalls()
    {
        using var cancel = new CancellationTokenSource();
        var options = new RampOptions
        {
            Rates = [500],
            StageMilliseconds = 1000,
            TotalEntries = 128,
            QueueCapacity = 1,
            Workers = 1,
            PostReleaseMilliseconds = 0
        };
        var run = Task.Run(() => SustainedRamp.Run(new(ParticipantKind.LLMPolymorphic, true, true, 0, options), cancel.Token));
        await Task.Delay(150);
        cancel.Cancel();
        var result = await run.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("Cancelled", result.StopReason);
        Assert.Equal(result.Requests.Length, result.Stages.Sum(stage => stage.Completed + stage.Cancelled + stage.QueueRejected));
        Assert.Equal(0, result.Memory[^1].HeldLeases);
    }

    [Fact]
    public async Task SaturatedQueueReportsOverflowWithoutLosingAcceptedHistory()
    {
        var options = new RampOptions
        {
            Rates = [10_000],
            StageMilliseconds = 100,
            TotalEntries = 128,
            QueueCapacity = 1,
            Workers = 1,
            PostReleaseMilliseconds = 0
        };
        var result = await SustainedRamp.Run(new(ParticipantKind.ConventionalScan, true, true, 0, options));
        Assert.Equal(1000, result.Requests.Length);
        Assert.True(result.Stages[0].QueueRejected > 0);
        Assert.Equal(1000, result.Stages[0].Completed + result.Stages[0].QueueRejected);
    }

    [Fact]
    public async Task OwnerDisposalDrainsBlockedAdmissionWithoutInvalidatingIssuedLease()
    {
        var fixture = ContextFixture.Create("Interactive", 32);
        using var clock = new AdmissionClock();
        using var owner = LLMContextFactory.Create(fixture.Options with
        {
            MaximumRetainedReads = 1,
            AdmissionTimeout = TimeSpan.FromMilliseconds(150),
            TimeProvider = clock
        })
            .Initialize(fixture.Sessions);
        using var lease = owner.OpenRead(fixture.Sessions[0].SessionId);
        var first = lease.ReadRange(0, 1).Single();
        clock.Armed = true;
        var waiting = Task.Run(() =>
        {
            Assert.Throws<InvalidOperationException>(() => owner.OpenRead(fixture.Sessions[0].SessionId));
        });
        Assert.True(clock.Entered.Wait(TimeSpan.FromSeconds(2)));
        var closing = Task.Run(owner.Dispose);
        await Task.WhenAll(waiting, closing).WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal(first, lease.ReadRange(0, 1).Single());
        Assert.Throws<ObjectDisposedException>(() => owner.OpenRead(fixture.Sessions[0].SessionId));
    }

    private sealed class AdmissionClock : TimeProvider, IDisposable
    {
        internal volatile bool Armed;
        internal ManualResetEventSlim Entered { get; } = new();
        public override DateTimeOffset GetUtcNow()
        {
            if (Armed) Entered.Set();
            return ContextFixture.Now;
        }
        public void Dispose() => Entered.Dispose();
    }
}
