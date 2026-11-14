// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using Xunit;

namespace LLMContextLib.Tests;

public sealed class PartitionedIndexTests
{
    private static Guid Id(int n) => ContextTests.Id(n);
    private static ContextIndexKeys Keys(params string[] values) => new(values);
    private static LLMSessionContext Session(int count = 4) => ContextTests.Session(count: 0) with
    {
        Segments = Enumerable.Range(0, (count + 1) / 2).ToImmutableSortedDictionary(
            n => (long)n, n => new ContextSegment(n, 0,
                Enumerable.Range(n * 2, Math.Min(2, count - n * 2)).Select(i =>
                    new ContextEntry(Id(1000 + i), i, ContextRole.User, DateTimeOffset.UnixEpoch,
                        new TextContent($"entry {i}"))
                    { IndexKeys = Keys("shared", $"key:{i}") }).ToImmutableArray()))
    };

    private static ILLMContextPolymorphicArray Create(LLMContextOptions? options = null,
        PartitionedContextIndexOptions? partitions = null, LLMSessionContext? session = null) =>
        LLMContextFactory.Create(options).WithPartitionedIndexing(partitions).Initialize([session ?? Session()]);
    private static ReplaceEntry Replace(int n, params string[] keys) =>
        new(Id(1000 + n), new TextContent($"replacement {n}")) { IndexKeys = Keys(keys) };
    private static IContextMutationResult Apply(ILLMContextPolymorphicArray owner, long revision,
        params ContextChange[] changes) => owner.Apply(new(Id(1), revision, changes.ToImmutableArray()));

    [Fact]
    public void WriteOptimizedStartupRequiresPreparedKeysAndUsesSmallPartitions()
    {
        using var owner = LLMContextFactory.Create(LLMContextOptions.WriteOptimized).Initialize([Session(0)]);
        Assert.Equal(ContextMutationStatus.InvalidOperation, Apply(owner, 0,
            new AppendEntries([new(Id(9999), ContextRole.User, DateTimeOffset.UnixEpoch,
                new TextContent("missing keys"))])).Status);
        var entries = Enumerable.Range(0, 9).Select(n => new ContextEntryDraft(
            Id(1000 + n), ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent($"entry {n}"))
        { IndexKeys = Keys("shared", $"key:{n}") }).ToImmutableArray();
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, new AppendEntries(entries)).Status);
        owner.WithCurrent(Id(1), read =>
        {
            Assert.Equal(1, read.Session.Revision);
            Assert.Equal([8, 1], read.Session.Segments.Values.Select(segment => segment.Entries.Length));
            Assert.Equal(9, read.SearchKeys(Keys("shared"), 16).Length);
            Assert.Equal(Id(1008), Assert.Single(read.SearchKeys(Keys("key:8"), 16)).EntryId);
        });
        Assert.Equal(0, owner.GetStatistics().RetainedReads);
    }

    [Fact]
    public async Task WriteOptimizedStartupSupportsTargetedTuningAndRejectsDuringSynchronization()
    {
        using var started = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var preset = LLMContextOptions.WriteOptimized;
        var options = preset with
        {
            PartitionedIndex = preset.PartitionedIndex! with { MaximumWorkingSetEntries = 1 },
            BeforePartitionSynchronization = token =>
            {
                started.Set();
                Assert.True(release.Wait(TimeSpan.FromSeconds(10), token));
            }
        };
        using var owner = LLMContextFactory.Create(options).Initialize([Session()]);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Replace(0, "fresh")).Status);
        Task<ContextIndexSynchronization>? synchronization = null;
        try
        {
            Assert.Equal(ContextMutationStatus.SynchronizationRequired,
                Apply(owner, 1, Replace(1, "next")).Status);
            Assert.True(started.Wait(TimeSpan.FromSeconds(10)));
            synchronization = owner.SynchronizeIndexAsync(Id(1));
            Assert.Equal(ContextMutationStatus.Synchronizing, Apply(owner, 1, Replace(1, "next")).Status);
            owner.WithCurrent(Id(1), read => Assert.Single(read.SearchKeys(Keys("fresh"), 16)));
        }
        finally { release.Set(); }
        Assert.True((await synchronization!).Succeeded);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, Replace(1, "next")).Status);
        owner.WithCurrent(Id(1), read => Assert.Single(read.SearchKeys(Keys("next"), 16)));
        Assert.Equal(0, owner.GetStatistics().EstimatedPreparationBytes);
    }

    [Fact]
    public async Task OverridesShadowWholeContributionsAndCompactionPreservesCapturedReads()
    {
        using var owner = Create();
        using var old = owner.OpenRead(Id(1));
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0,
            Replace(0, "fresh"), new DeleteEntry(Id(1001))).Status);
        using var partial = owner.OpenRead(Id(1));
        long retained = owner.GetStatistics().EstimatedRetainedBytes;
        Assert.Equal(4, old.SearchKeys(Keys("shared"), 10).Length);
        Assert.Equal(2, partial.SearchKeys(Keys("shared"), 10).Length);
        Assert.Empty(partial.SearchKeys(Keys("shared", "fresh"), 10));
        Assert.Empty(partial.SearchKeys(Keys("key:0"), 10));
        Assert.Equal(Id(1000), Assert.Single(partial.SearchKeys(Keys("fresh"), 10)).EntryId);
        var result = await owner.SynchronizeIndexAsync(Id(1));
        Assert.True(result.Succeeded, result.Error);
        Assert.Equal(1, result.ContentRevision);
        Assert.Equal(1, result.PartitionsCompacted);
        Assert.Equal(retained, owner.GetStatistics().EstimatedRetainedBytes);
        using var current = owner.OpenRead(Id(1));
        Assert.Equal<ContextSearchHit>(partial.SearchKeys(Keys("fresh"), 10), current.SearchKeys(Keys("fresh"), 10));
        Assert.Equal(4, old.SearchKeys(Keys("shared"), 10).Length);
        Assert.Equal(2, partial.SearchKeys(Keys("shared"), 10).Length);
        Assert.Equal(0, owner.GetStatistics().EstimatedPreparationBytes);
    }

    [Fact]
    public async Task DeletingWholePartitionDropsItsDebtButPinnedSnapshotStaysValid()
    {
        using var owner = Create();
        using var old = owner.OpenRead(Id(1));
        long before = owner.GetStatistics().EstimatedActiveBytes;
        Assert.Equal(ContextMutationStatus.Applied,
            Apply(owner, 0, new DeleteEntry(Id(1000)), new DeleteEntry(Id(1001))).Status);
        Assert.True(owner.GetStatistics().EstimatedActiveBytes < before);
        Assert.Equal(0, (await owner.SynchronizeIndexAsync(Id(1))).PartitionsCompacted);
        Assert.Equal(4, old.SearchKeys(Keys("shared"), 10).Length);
        owner.WithCurrent(Id(1), read => Assert.Equal(2, read.SearchKeys(Keys("shared"), 10).Length));
    }

    [Fact]
    public async Task SynchronizationRejectsWritesButNotReadsAndCompletionCannotBeMissed()
    {
        using var started = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = Create(new()
        {
            BeforePartitionSynchronization = token =>
            {
                started.Set();
                Assert.True(release.Wait(TimeSpan.FromSeconds(10), token));
            }
        });
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Replace(0, "fresh")).Status);
        Task<ContextIndexSynchronization> sync = owner.SynchronizeIndexAsync(Id(1));
        try
        {
            Assert.True(started.Wait(TimeSpan.FromSeconds(10)));
            Assert.Equal(ContextMutationStatus.Synchronizing, Apply(owner, 1, Replace(1, "later")).Status);
            Assert.Equal(ContextMutationStatus.Synchronizing, owner.RemoveSession(Id(1), 1).Status);
            owner.WithCurrent(Id(1), read => Assert.Single(read.SearchKeys(Keys("fresh"), 10)));
            using var cancel = new CancellationTokenSource();
            var wait = owner.SynchronizeIndexAsync(Id(1), cancel.Token);
            cancel.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => wait);
            Assert.False(sync.IsCompleted);
        }
        finally { release.Set(); }
        var receipt = await sync;
        Assert.True(receipt.Succeeded, receipt.Error);
        Assert.Equal(receipt, await sync);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, Replace(1, "later")).Status);
        Assert.Equal(ContextMutationStatus.RevisionConflict, Apply(owner, 1, Replace(2, "stale")).Status);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task WaitPolicyIsBoundedAndNeverRebases(bool finishBeforeTimeout)
    {
        using var started = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = Create(new()
        {
            BeforePartitionSynchronization = token =>
            {
                started.Set();
                Assert.True(release.Wait(TimeSpan.FromSeconds(10), token));
            }
        }, new()
        {
            WriteBehavior = ContextSynchronizationWriteBehavior.Wait,
            SynchronizationWaitTimeout = finishBeforeTimeout ? TimeSpan.FromSeconds(10) : TimeSpan.Zero
        });
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Replace(0, "fresh")).Status);
        var sync = owner.SynchronizeIndexAsync(Id(1));
        try
        {
            Assert.True(started.Wait(TimeSpan.FromSeconds(10)));
            var write = Task.Run(() => Apply(owner, 1, Replace(1, "next")));
            if (finishBeforeTimeout) release.Set();
            var result = await write;
            Assert.Equal(finishBeforeTimeout ? ContextMutationStatus.Applied : ContextMutationStatus.Synchronizing,
                result.Status);
        }
        finally { release.Set(); }
        Assert.True((await sync).Succeeded);
    }

    [Fact]
    public async Task FailedSynchronizationPreservesAuthoritativeStateAndAllowsRetry()
    {
        int failures = 1;
        using var owner = Create(new()
        {
            BeforePartitionSynchronization = _ =>
            {
                if (Interlocked.Exchange(ref failures, 0) == 1) throw new InvalidOperationException("injected");
            }
        });
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Replace(0, "fresh")).Status);
        var failed = await owner.SynchronizeIndexAsync(Id(1));
        Assert.False(failed.Succeeded);
        Assert.Contains("injected", failed.Error);
        owner.WithCurrent(Id(1), read =>
        {
            Assert.Single(read.SearchKeys(Keys("fresh"), 10));
            Assert.Empty(read.SearchKeys(Keys("key:0"), 10));
        });
        var retry = await owner.SynchronizeIndexAsync(Id(1));
        Assert.True(retry.Succeeded, retry.Error);
        Assert.True(retry.Generation > failed.Generation);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, Replace(1, "next")).Status);
    }

    [Fact]
    public async Task SpeculativePreparationCannotCrossSynchronizationFence()
    {
        using var preparing = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = Create(new()
        {
            EntrySizeEstimator = entry =>
            {
                if (entry.Content is TextContent { Text: "blocked" })
                {
                    preparing.Set();
                    Assert.True(release.Wait(TimeSpan.FromSeconds(10)));
                }
                return 256;
            }
        });
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Replace(0, "fresh")).Status);
        var write = Task.Run(() => Apply(owner, 1,
            new ReplaceEntry(Id(1001), new TextContent("blocked")) { IndexKeys = Keys("blocked") }));
        Task<ContextIndexSynchronization>? sync = null;
        try
        {
            Assert.True(preparing.Wait(TimeSpan.FromSeconds(10)));
            Assert.True(owner.GetStatistics().EstimatedPreparationBytes > 0);
            sync = owner.SynchronizeIndexAsync(Id(1));
            Assert.False(sync.IsCompleted);
        }
        finally { release.Set(); }
        Assert.Equal(ContextMutationStatus.SynchronizationRequired, (await write).Status);
        Assert.True((await sync!).Succeeded);
        Assert.Equal(0, owner.GetStatistics().EstimatedPreparationBytes);
        owner.WithCurrent(Id(1), read => Assert.Empty(read.SearchKeys(Keys("blocked"), 10)));
    }

    [Fact]
    public void PreconstructionRejectionDoesNotRunEstimatorsOrLeakReservations()
    {
        int calls = 0;
        using var owner = Create(new() { EntrySizeEstimator = _ => { calls++; return 128; } },
            new() { MaximumEstimatedPreparationBytes = 1 });
        calls = 0;
        Assert.Equal(ContextMutationStatus.AdmissionRejected, Apply(owner, 0, Replace(0, "large")).Status);
        Assert.Equal(0, calls);
        Assert.Equal(0, owner.GetStatistics().EstimatedPreparationBytes);
        owner.WithCurrent(Id(1), read => Assert.Equal(0, read.Session.Revision));
    }

    [Fact]
    public async Task FullWorkingSetRejectsAtomicallyAndRequestsSynchronization()
    {
        using var owner = Create(partitions: new() { MaximumWorkingSetEntries = 1 });
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Replace(0, "first")).Status);
        Assert.Equal(ContextMutationStatus.SynchronizationRequired, Apply(owner, 1, Replace(1, "second")).Status);
        Assert.True((await owner.SynchronizeIndexAsync(Id(1))).Succeeded);
        owner.WithCurrent(Id(1), read =>
        {
            Assert.Equal(1, read.Session.Revision);
            Assert.Single(read.SearchKeys(Keys("first"), 10));
            Assert.Empty(read.SearchKeys(Keys("second"), 10));
        });
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, Replace(1, "second")).Status);
    }

    [Fact]
    public async Task MixedMutationsMatchIndependentKeyModelAcrossPartitions()
    {
        using var owner = Create(partitions: new() { MaximumWorkingSetEntries = 16 });
        var model = Enumerable.Range(0, 4).ToDictionary(n => Id(1000 + n),
            n => Keys("shared", $"key:{n}"));
        var random = new Random(1984);
        for (int revision = 0; revision < 60; revision++)
        {
            int n = random.Next(4);
            var keys = Keys($"group:{random.Next(3)}", $"other:{random.Next(3)}");
            Assert.Equal(ContextMutationStatus.Applied, Apply(owner, revision,
                new ReplaceEntry(Id(1000 + n), new TextContent("same")) { IndexKeys = keys }).Status);
            model[Id(1000 + n)] = keys;
            if (revision % 7 == 0) Assert.True((await owner.SynchronizeIndexAsync(Id(1))).Succeeded);
            owner.WithCurrent(Id(1), read =>
            {
                foreach (string key in Enumerable.Range(0, 3).Select(i => $"group:{i}"))
                {
                    var expected = model.Where(pair => pair.Value.Keys.Contains(key))
                        .OrderBy(pair => pair.Key).Select(pair => pair.Key);
                    Assert.Equal(expected, read.SearchKeys(Keys(key), 10).Select(hit => hit.EntryId).Order());
                }
            });
        }
        Assert.Equal(ContextMutationStatus.InvalidOperation,
            Apply(owner, 60, Replace(0, "discarded"), new DeleteEntry(Id(9999))).Status);
        owner.WithCurrent(Id(1), read => Assert.Empty(read.SearchKeys(Keys("discarded"), 10)));
    }

    [Fact]
    public async Task GrowthUsesNewPartitionAndOversizedReplacementCannotSpendReclamationDebt()
    {
        using var owner = Create(partitions: new()
        {
            MaximumEstimatedPartitionBytes = 3600,
            MaximumEstimatedWorkingSetBytes = 3600
        });
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0,
            new AppendEntries([new(Id(2000), ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent("growth"))
            { IndexKeys = Keys("grown") }])).Status);
        owner.WithCurrent(Id(1), read =>
        {
            Assert.Single(read.SearchKeys(Keys("grown"), 10));
            Assert.Equal(3, read.Session.Segments.Count);
        });
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, new DeleteEntry(Id(1000))).Status);
        var growth = Replace(1, new string('x', 256));
        Assert.Equal(ContextMutationStatus.SynchronizationRequired, Apply(owner, 2, growth).Status);
        Assert.True((await owner.SynchronizeIndexAsync(Id(1))).Succeeded);
        // Even a clean partition cannot admit an individually oversized atomic contribution.
        Assert.Equal(ContextMutationStatus.AdmissionRejected, Apply(owner, 2, growth).Status);
        owner.WithCurrent(Id(1), read =>
        {
            Assert.Equal(2, read.Session.Revision);
            Assert.Single(read.SearchKeys(Keys("key:1"), 10));
        });
        Assert.Equal(0, owner.GetStatistics().EstimatedPreparationBytes);
    }

    [Fact]
    public async Task AnchorsRemainSeparateAndLateErrorsDoNotPublishMixedCommands()
    {
        using var owner = Create();
        var anchor = new ConversationAnchor(Id(3000), Id(1000), Id(1001), "bookmark", "metadata", [],
            AnchorKind.Manual, 0, null)
        { IndexKeys = Keys("anchor") };
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, new PutAnchor(anchor),
            Replace(0, "entry")).Status);
        owner.WithCurrent(Id(1), read =>
        {
            Assert.Empty(read.SearchKeys(Keys("entry", "anchor"), 10));
            Assert.Equal(Id(3000), Assert.Single(read.SearchKeys(Keys("anchor"), 10)).AnchorId);
        });
        Assert.Equal(ContextMutationStatus.InvalidOperation, Apply(owner, 1,
            new RemoveAnchor(Id(3000)), Replace(0, "discarded"), new DeleteEntry(Id(9000))).Status);
        Assert.True((await owner.SynchronizeIndexAsync(Id(1))).Succeeded);
        owner.WithCurrent(Id(1), read =>
        {
            Assert.Single(read.SearchKeys(Keys("anchor"), 10));
            Assert.Single(read.SearchKeys(Keys("entry"), 10));
            Assert.Empty(read.SearchKeys(Keys("discarded"), 10));
        });
    }

    [Fact]
    public async Task OwnerDisposalCancelsSynchronizationWithoutInvalidatingCapturedRead()
    {
        using var started = new ManualResetEventSlim();
        var owner = Create(new()
        {
            BeforePartitionSynchronization = token =>
            {
                started.Set();
                token.WaitHandle.WaitOne();
                token.ThrowIfCancellationRequested();
            }
        });
        using var cleanup = owner;
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Replace(0, "fresh")).Status);
        using var read = owner.OpenRead(Id(1));
        var sync = owner.SynchronizeIndexAsync(Id(1));
        Assert.True(started.Wait(TimeSpan.FromSeconds(10)));
        owner.Dispose();
        Assert.False((await sync).Succeeded);
        Assert.Single(read.SearchKeys(Keys("fresh"), 10));
        Assert.Throws<ObjectDisposedException>(() => owner.OpenRead(Id(1)));
    }

    [Fact]
    public async Task SynchronizationBacklogIsBoundedAndOtherSessionsKeepWriting()
    {
        using var started = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = LLMContextFactory.Create(new LLMContextOptions
        {
            BeforePartitionSynchronization = token =>
            {
                started.Set();
                Assert.True(release.Wait(TimeSpan.FromSeconds(10), token));
            }
        }).WithPartitionedIndexing(new() { MaximumPendingSynchronizations = 1 })
            .Initialize([Session(), Session() with { SessionId = Id(2) }]);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Replace(0, "first")).Status);
        Assert.Equal(ContextMutationStatus.Applied,
            owner.Apply(new(Id(2), 0, [Replace(0, "second")])).Status);
        var first = owner.SynchronizeIndexAsync(Id(1));
        try
        {
            Assert.True(started.Wait(TimeSpan.FromSeconds(10)));
            var full = await owner.SynchronizeIndexAsync(Id(2));
            Assert.False(full.Succeeded);
            Assert.Contains("backlog", full.Error);
            Assert.Equal(1, owner.GetStatistics().PendingSynchronizations);
            Assert.Equal(ContextMutationStatus.Applied,
                owner.Apply(new(Id(2), 1, [Replace(1, "other")])).Status);
        }
        finally { release.Set(); }
        Assert.True((await first).Succeeded);
        Assert.True((await owner.SynchronizeIndexAsync(Id(2))).Succeeded);
        Assert.Equal(0, owner.GetStatistics().PendingSynchronizations);
    }

    [Fact]
    public async Task PartitionFactoryPreservesRecipesAndRejectsIncompatibleStrategies()
    {
        var original = LLMContextFactory.Create();
        using var text = original.Initialize([ContextTests.Session()]);
        using var partitions = original.WithPartitionedIndexing().Initialize([Session()]);
        text.WithCurrent(Id(1), read => Assert.Equal(ContextIndexingMode.Text, read.IndexingMode));
        partitions.WithCurrent(Id(1), read => Assert.Equal(ContextIndexingMode.ProducerOwned, read.IndexingMode));
        Assert.Throws<ArgumentException>(() => original.WithLuceneTermCollection().WithPartitionedIndexing());
        Assert.Throws<ArgumentException>(() => original.WithPartitionedIndexing().WithBitFasterTermMemoization());
        Assert.Throws<ArgumentException>(() =>
            LLMContextFactory.Create(new() { DeferredIndexing = new() }).WithPartitionedIndexing());
        Assert.Throws<ArgumentOutOfRangeException>(() => original.WithPartitionedIndexing(new()
        { MaximumWorkingSetEntries = 0 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => LLMContextFactory.Create(new()
        { EstimatedResidentByteBudget = 1024 }).WithPartitionedIndexing());
        await Assert.ThrowsAsync<NotSupportedException>(() => text.SynchronizeIndexAsync(Id(1)));
    }

    [Fact]
    public async Task OversizedBatchCannotRequestEndlessSynchronizationOfItsPrivateWorkingSet()
    {
        using var owner = Create(partitions: new() { MaximumWorkingSetEntries = 1 });
        Assert.Equal(ContextMutationStatus.AdmissionRejected,
            Apply(owner, 0, Replace(0, "first"), Replace(1, "second")).Status);
        Assert.Equal(0, (await owner.SynchronizeIndexAsync(Id(1))).PartitionsCompacted);
        Assert.Equal(0, owner.GetStatistics().EstimatedPreparationBytes);
        owner.WithCurrent(Id(1), read =>
        {
            Assert.Equal(0, read.Session.Revision);
            Assert.Empty(read.SearchKeys(Keys("first"), 10));
        });
        Assert.Equal(ContextMutationStatus.Applied,
            Apply(owner, 0, new DeleteEntry(Id(1000)), new DeleteEntry(Id(1001))).Status);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ThousandIndependentPacketsStillHaveOnlyOneRevisionWinner(bool serialized)
    {
        using var owner = Create(new() { SerializeSessionPreparation = serialized });
        var commands = Enumerable.Range(0, 1000).Select(n =>
            new ContextChangeSet(Id(1), 0, [Replace(0, $"winner:{n}")])).ToArray();
        var results = await Task.WhenAll(commands.Select(command => Task.Run(() => owner.Apply(command))));
        int winner = Array.FindIndex(results, result => result.Status == ContextMutationStatus.Applied);
        Assert.Single(results, result => result.Status == ContextMutationStatus.Applied);
        Assert.All(results.Where(result => result.Status != ContextMutationStatus.Applied), result =>
            Assert.True(result.Status is ContextMutationStatus.RevisionConflict or ContextMutationStatus.AdmissionRejected));
        owner.WithCurrent(Id(1), read =>
        {
            Assert.Equal(1, read.Session.Revision);
            Assert.Single(read.SearchKeys(Keys($"winner:{winner}"), 10));
            Assert.Empty(read.SearchKeys(Keys("key:0"), 10));
        });
        Assert.Equal(0, owner.GetStatistics().EstimatedPreparationBytes);
    }
}
