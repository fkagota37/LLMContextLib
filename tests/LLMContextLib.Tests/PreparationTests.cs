// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using LLMContextLib.Benchmarks;
using Xunit;

namespace LLMContextLib.Tests;

public sealed class PreparationTests
{
    [Fact]
    public void SerializedPreparationMatchesIndependentOracleAcrossExistingTraces()
    {
        var fixture = ContextFixture.Create("Interactive", entryCount: 64, sessionCount: 2);
        fixture = fixture with { Options = fixture.Options with { SerializeSessionPreparation = true } };
        foreach (var scenario in Enum.GetValues<ContextScenario>())
            ReplayChecks.Verify(fixture, ContextTraces.Create(fixture, scenario));
    }

    private static ILLMContextPolymorphicArray Create(bool serialized, LLMContextOptions? options = null) =>
        LLMContextFactory.Create((options ?? new()) with { SerializeSessionPreparation = serialized })
            .Initialize([ContextTests.Session(), ContextTests.Session(2)]);

    private static IContextMutationResult Apply(ILLMContextPolymorphicArray owner, MutationDiagnostics diagnostic,
        long revision, string text)
    {
        MutationDiagnostics.Current = diagnostic;
        try { return owner.Apply(new(ContextTests.Id(1), revision, [new ReplaceEntry(ContextTests.Id(1000), new TextContent(text))])); }
        finally { MutationDiagnostics.Current = null; }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task GatePolicyAvoidsDiscardedPreparationWithoutRebasingOrBlockingReaders(bool serialized)
    {
        using var preparing = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = Create(serialized, new()
        {
            AdmissionTimeout = TimeSpan.FromSeconds(3),
            EntrySizeEstimator = entry =>
            {
                if (entry.Content is TextContent { Text: "first" })
                {
                    preparing.Set();
                    if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Test preparation was not released.");
                }
                return ContextPolicies.EstimateEntryBytes(entry);
            }
        });
        using var old = owner.OpenRead(ContextTests.Id(1));
        var firstTrace = new MutationDiagnostics();
        var secondTrace = new MutationDiagnostics();
        var first = Task.Factory.StartNew(() => Apply(owner, firstTrace, 0, "first"),
            CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        Task<IContextMutationResult>? second = null;
        try
        {
            Assert.True(preparing.Wait(TimeSpan.FromSeconds(2)));
            second = Task.Factory.StartNew(() => Apply(owner, secondTrace, 0, "second"),
                CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            if (serialized)
                Assert.True(SpinWait.SpinUntil(() => Volatile.Read(ref secondTrace.GateAttempted), TimeSpan.FromSeconds(2)));
            else
                Assert.Equal(ContextMutationStatus.Applied, (await second.WaitAsync(TimeSpan.FromSeconds(2))).Status);

            // Same-session readers and another session's writer make progress while the
            // first estimator is stopped inside preparation, even under the serial policy.
            using var read = owner.OpenRead(ContextTests.Id(1));
            Assert.Equal(serialized ? 0 : 1, read.Session.Revision);
            Assert.Equal(ContextMutationStatus.Applied, owner.Apply(new(ContextTests.Id(2), 0,
                [new ReplaceEntry(ContextTests.Id(2000), new TextContent("independent"))])).Status);
            Assert.Equal("message topic0", ((TextContent)old.ReadRange(0, 1)[0].Content).Text);
        }
        finally
        {
            release.Set();
            await first.WaitAsync(TimeSpan.FromSeconds(5));
            if (second is not null) await second.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.NotNull(second);
        Assert.Equal(serialized ? ContextMutationStatus.Applied : ContextMutationStatus.RevisionConflict, (await first).Status);
        Assert.Equal(serialized ? ContextMutationStatus.RevisionConflict : ContextMutationStatus.Applied, (await second).Status);
        var loser = serialized ? secondTrace : firstTrace;
        Assert.Equal(serialized ? MutationDisposition.GatedRevisionConflict : MutationDisposition.PreparedRevisionConflict, loser.Disposition);
        Assert.Equal(!serialized, loser.Prepared);
        Assert.Equal(serialized ? 0 : firstTrace.PreparationBytes, loser.PreparationBytes);
        Assert.True(firstTrace.PreparationBytes > 0);
        Assert.True(secondTrace.StorageBytes >= secondTrace.PreparationBytes);
        using var final = owner.OpenRead(ContextTests.Id(1));
        Assert.Equal(1, final.Session.Revision);
        Assert.Single(final.Search(serialized ? "first" : "second", 10));
        Assert.Empty(final.Search(serialized ? "second" : "first", 10));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DiagnosticsDistinguishInvalidPreparationFromAlreadyStaleRequests(bool serialized)
    {
        using var owner = Create(serialized);
        var invalid = new MutationDiagnostics();
        var before = owner.GetStatistics();
        MutationDiagnostics.Current = invalid;
        try
        {
            Assert.Equal(ContextMutationStatus.InvalidOperation, owner.Apply(new(ContextTests.Id(1), 0,
                [new ReplaceEntry(ContextTests.Id(1000), new ToolCallContent("call", "tool", "{}"))])).Status);
        }
        finally { MutationDiagnostics.Current = null; }
        Assert.Equal(MutationDisposition.InvalidPreparation, invalid.Disposition);
        Assert.True(invalid.PreparationStarted);
        Assert.False(invalid.Prepared);
        Assert.True(invalid.PreparationBytes > 0);
        Assert.Equal(before, owner.GetStatistics());
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, new(), 0, "accepted").Status);
        var stale = new MutationDiagnostics();
        Assert.Equal(ContextMutationStatus.RevisionConflict, Apply(owner, stale, 0, "stale").Status);
        Assert.Equal(MutationDisposition.InitialRevisionConflict, stale.Disposition);
        Assert.False(stale.PreparationStarted);
        Assert.Equal(0, stale.PreparationBytes);
        Assert.False(stale.GateAttempted);
        Assert.Null(MutationDiagnostics.Current);
    }

    [Fact]
    public async Task SerialGateTimeoutDoesNotPrepareOrPublishWaitingRequest()
    {
        using var preparing = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = Create(true, new()
        {
            AdmissionTimeout = TimeSpan.FromMilliseconds(20),
            EntrySizeEstimator = entry =>
            {
                if (entry.Content is TextContent { Text: "first" })
                {
                    preparing.Set();
                    if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException();
                }
                return ContextPolicies.EstimateEntryBytes(entry);
            }
        });
        var first = Task.Factory.StartNew(() => Apply(owner, new(), 0, "first"),
            CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        try
        {
            Assert.True(preparing.Wait(TimeSpan.FromSeconds(2)));
            var trace = new MutationDiagnostics();
            Assert.Equal(ContextMutationStatus.AdmissionRejected, Apply(owner, trace, 0, "waiting").Status);
            Assert.Equal(MutationDisposition.GateRejected, trace.Disposition);
            Assert.False(trace.Prepared);
            Assert.False(trace.PreparationStarted);
            Assert.Equal(0, trace.PreparationBytes);
            using var read = owner.OpenRead(ContextTests.Id(1));
            Assert.Equal(0, read.Session.Revision);
        }
        finally { release.Set(); await first.WaitAsync(TimeSpan.FromSeconds(5)); }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RemovalCannotResurrectAPreparingSessionUnderEitherPolicy(bool serialized)
    {
        using var preparing = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = Create(serialized, new()
        {
            AdmissionTimeout = TimeSpan.FromMilliseconds(20),
            EntrySizeEstimator = entry =>
            {
                if (entry.Content is TextContent { Text: "first" })
                {
                    preparing.Set();
                    if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException();
                }
                return ContextPolicies.EstimateEntryBytes(entry);
            }
        });
        using var lease = owner.OpenRead(ContextTests.Id(1));
        var trace = new MutationDiagnostics();
        var preparingWrite = Task.Factory.StartNew(() => Apply(owner, trace, 0, "first"),
            CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        try
        {
            Assert.True(preparing.Wait(TimeSpan.FromSeconds(2)));
            Assert.Equal(serialized ? ContextMutationStatus.AdmissionRejected : ContextMutationStatus.Applied,
                owner.RemoveSession(ContextTests.Id(1), 0).Status);
        }
        finally { release.Set(); await preparingWrite.WaitAsync(TimeSpan.FromSeconds(5)); }
        Assert.Equal(serialized ? ContextMutationStatus.Applied : ContextMutationStatus.NotFound, (await preparingWrite).Status);
        if (serialized) Assert.Equal(ContextMutationStatus.Applied, owner.RemoveSession(ContextTests.Id(1), 1).Status);
        Assert.False(owner.TryFind(ContextTests.Id(1), out _));
        Assert.Equal("message topic0", ((TextContent)lease.ReadRange(0, 1)[0].Content).Text);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ResourceRejectionAccountsForPreparationWithoutPublishing(bool serialized)
    {
        long initial;
        using (var calibration = Create(serialized)) initial = calibration.GetStatistics().EstimatedActiveBytes;
        using var owner = Create(serialized, new() { EstimatedResidentByteBudget = initial + 1 });
        var trace = new MutationDiagnostics();
        var before = owner.GetStatistics();
        Assert.Equal(ContextMutationStatus.AdmissionRejected, Apply(owner, trace, 0, new string('x', 8192)).Status);
        Assert.Equal(MutationDisposition.ResourceRejected, trace.Disposition);
        Assert.True(trace.Prepared);
        Assert.True(trace.PreparationBytes > 0);
        Assert.Equal(before, owner.GetStatistics());
        Assert.True(owner.TryFind(ContextTests.Id(1), out var session));
        Assert.Equal(0, session.Revision);
    }

    [Fact]
    public void MemoryMutationDiagnosticsRemainSeparateFromSessionPreparationPolicy()
    {
        using var owner = Create(true);
        var record = new ContextMemory(ContextTests.Id(80), new(SessionId: ContextTests.Id(1)), "memory", 0,
            MemoryStatus.Proposed, null, []);
        var applied = new MutationDiagnostics();
        MutationDiagnostics.Current = applied;
        try { Assert.Equal(ContextMutationStatus.Applied, owner.ApplyMemory(new(0, [record], [])).Status); }
        finally { MutationDiagnostics.Current = null; }
        Assert.Equal(MutationDisposition.Applied, applied.Disposition);
        Assert.True(applied.Prepared);
        var stale = new MutationDiagnostics();
        MutationDiagnostics.Current = stale;
        try { Assert.Equal(ContextMutationStatus.RevisionConflict, owner.ApplyMemory(new(0, [record], [])).Status); }
        finally { MutationDiagnostics.Current = null; }
        Assert.Equal(MutationDisposition.InitialRevisionConflict, stale.Disposition);
        Assert.Equal(0, stale.PreparationBytes);
        Assert.True(owner.TryFind(ContextTests.Id(1), out var session));
        Assert.Equal(0, session.Revision);
    }
}
