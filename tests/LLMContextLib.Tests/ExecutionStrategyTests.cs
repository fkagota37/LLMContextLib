// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using LLMContextLib.Benchmarks;
using Xunit;

namespace LLMContextLib.Tests;

public sealed class ExecutionStrategyTests
{
    private static Guid Id(int value) => ContextTests.Id(value);
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);
    private static readonly BitFasterTermMemoOptions SmallMemo = new()
    {
        Capacity = 3,
        MaximumTextCharacters = 2048,
        MaximumEstimatedBytes = 32 * 1024
    };

    private static IContextMutationResult Apply(ILLMContextPolymorphicArray owner, long revision,
        params ContextChange[] changes) => owner.Apply(new(Id(1), revision, changes.ToImmutableArray()));

    private static AppendEntries Append(int id, string text) =>
        new([new(Id(id), ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent(text))]);

    public static IEnumerable<object[]> Compositions()
    {
        foreach (int collector in new[] { 0, 1, 2 })
            foreach (bool memo in new[] { false, true })
                foreach (var indexing in Enum.GetValues<ContextIndexingStrategy>())
                    yield return [collector, memo, indexing];
    }

    [Theory]
    [MemberData(nameof(Compositions))]
    public void ComposedStrategiesMatchIndependentOracleAcrossEveryExistingTrace(
        int collector, bool memo, ContextIndexingStrategy indexing)
    {
        var fixture = ContextFixture.Create("Interactive", entryCount: 32, sessionCount: 2);
        fixture = fixture with
        {
            Options = fixture.Options with
            {
                DeferredIndexing = new() { ForegroundWords = 1, MaximumPendingEntries = 256 }
            }
        };
        var builder = LLMContextFactory.Create(fixture.Options).WithExecutionStrategies(new()
        {
            Indexing = indexing,
            MinimumDeferredCharacters = 32,
            Preparation = memo ? ContextPreparationStrategy.Serialized : ContextPreparationStrategy.Speculative
        });
        if (collector != 0)
            builder = builder.WithLuceneTermCollection(collector == 1
                ? LuceneTermCollection.RangeBuffer : LuceneTermCollection.CharTerm);
        if (memo) builder = builder.WithBitFasterTermMemoization();
        foreach (var scenario in Enum.GetValues<ContextScenario>())
        {
            using var participant = BenchmarkParticipants.Create(builder, fixture);
            ReplayChecks.Verify(fixture, ContextTraces.Create(fixture, scenario), participant,
                $"{collector}/{memo}/{indexing}/{scenario}");
        }
    }

    [Theory]
    [InlineData(LuceneTermCollection.RangeBuffer)]
    [InlineData(LuceneTermCollection.CharTerm)]
    public void LuceneCollectorsPreserveUtf16PolicyAndDoNotShareMutableScratch(LuceneTermCollection collection)
    {
        var collector = new LuceneContextTermCollector(collection);
        var texts = new List<string>
        {
            "", " ,.! ", "SAME same Same rare", "a-b a_b 42",
            "\u00c9CLAIR \u0130 \ud800 caf\u00e9 123 \udc00 \u212a",
            new('x', 20_000)
        };
        var random = new Random(1729);
        for (int i = 0; i < 128; i++)
            texts.Add(new string(Enumerable.Range(0, random.Next(300))
                .Select(_ => (char)random.Next(char.MaxValue + 1)).ToArray()));
        var expected = texts.Select(ContextPolicies.Terms).ToArray();
        Parallel.For(0, texts.Count, i =>
        {
            Assert.Equal<string>(expected[i], collector.Collect(texts[i], CancellationToken.None));
            Assert.Equal<string>(expected[i], collector.Collect(texts[i], CancellationToken.None));
        });
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => collector.Collect("text", cancelled.Token));
    }

    [Fact]
    public void BuilderRecipesAndMemoStateAreIndependentAcrossOwners()
    {
        var original = LLMContextFactory.Create();
        var configured = original.WithLuceneTermCollection().WithBitFasterTermMemoization(SmallMemo);
        using var unchanged = original.Initialize([ContextTests.Session(count: 0)]);
        using var first = configured.Initialize([ContextTests.Session(count: 0)]);
        using var second = configured.Initialize([ContextTests.Session(count: 0)]);
        using var unconfigured = configured.WithNativeTermCollection().WithoutTermMemoization()
            .Initialize([ContextTests.Session(count: 0)]);
        Assert.Null(unchanged.GetStatistics().Execution);
        Assert.Equal("Native", unconfigured.GetStatistics().Execution!.TermCollector);
        Assert.Equal("None", unconfigured.GetStatistics().Execution!.TermMemo);
        Assert.Equal(ContextExecutionRecipe.InfrastructureBytes,
            unconfigured.GetStatistics().Execution!.EstimatedReservedBytes);
        Assert.Equal(ContextMutationStatus.Applied, Apply(first, 0, Append(2000, "Alpha beta")).Status);
        Assert.Equal(ContextMutationStatus.Applied, Apply(first, 1, Append(2001, "Alpha beta")).Status);
        Assert.Equal(ContextMutationStatus.Applied, Apply(first, 2, Append(2002, "ALPHA BETA")).Status);
        var state = first.GetStatistics().Execution!;
        Assert.Equal(1, state.MemoHits);
        Assert.Equal(2, state.MemoMisses);
        Assert.Equal(2, state.TermCollections);
        Assert.Equal(0, second.GetStatistics().Execution!.MemoEntries);
        Assert.Equal(0, second.GetStatistics().Execution!.MemoHits);
        first.Dispose();
        Assert.Equal(ContextMutationStatus.Applied, Apply(second, 0, Append(2000, "Alpha beta")).Status);
        Assert.Equal(1, second.GetStatistics().Execution!.MemoMisses);
        Assert.Equal(0, second.GetStatistics().Execution!.MemoHits);
    }

    [Fact]
    public void MemoReservationIsChargedOnceAndCombinedInfrastructureMustFit()
    {
        using var baseline = LLMContextFactory.Create().Initialize([ContextTests.Session()]);
        using var owner = LLMContextFactory.Create().WithBitFasterTermMemoization(SmallMemo)
            .Initialize([ContextTests.Session()]);
        long reservation = SmallMemo.MaximumEstimatedBytes + ContextExecutionRecipe.InfrastructureBytes;
        Assert.Equal(reservation, owner.GetStatistics().EstimatedActiveBytes - baseline.GetStatistics().EstimatedActiveBytes);
        using var originalRead = baseline.OpenRead(Id(1));
        using var composedRead = owner.OpenRead(Id(1));
        Assert.Equal(baseline.GetStatistics().EstimatedRetainedBytes, owner.GetStatistics().EstimatedRetainedBytes);
        Assert.Equal(reservation, owner.GetStatistics().Execution!.EstimatedReservedBytes);
        using var limited = LLMContextFactory.Create(new()
        {
            EstimatedResidentByteBudget = reservation + baseline.GetStatistics().EstimatedActiveBytes - 1
        }).WithBitFasterTermMemoization(SmallMemo).Initialize([]);
        Assert.Equal(ContextMutationStatus.AdmissionRejected, limited.CreateSession(ContextTests.Session()).Status);
        Assert.Equal(0, limited.GetStatistics().Sessions);
        Assert.Equal(reservation, limited.GetStatistics().EstimatedActiveBytes);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            LLMContextFactory.Create(new() { EstimatedResidentByteBudget = reservation - 1 })
                .WithBitFasterTermMemoization(SmallMemo));

        var deferred = new DeferredIndexingOptions();
        long combined = reservation + ContextIndexTokenizer.InfrastructureReservation(deferred.MaximumPendingEntries);
        Assert.Throws<ArgumentOutOfRangeException>(() => LLMContextFactory.Create(new()
        {
            DeferredIndexing = deferred,
            EstimatedResidentByteBudget = combined - 1
        }).WithBitFasterTermMemoization(SmallMemo));
    }

    [Fact]
    public void OversizedMemoInputsAndValuesBypassWithoutChangingExactResults()
    {
        var memo = new BitFasterTermMemoOptions
        {
            Capacity = 3,
            MaximumTextCharacters = 16,
            MaximumEstimatedBytes = 4096 + 512 * 4 + 160 * 4
        };
        using var owner = LLMContextFactory.Create().WithBitFasterTermMemoization(memo)
            .Initialize([ContextTests.Session(count: 0)]);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Append(2000, "alpha")).Status);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, Append(2001, "alpha")).Status);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 2, Append(2002, "oversized lookup text")).Status);
        var stats = owner.GetStatistics().Execution!;
        Assert.Equal(0, stats.MemoEntries);
        Assert.Equal(2, stats.MemoMisses);
        Assert.Equal(1, stats.MemoBypasses);
        Assert.Equal(2, stats.MemoAdmissionBypasses);
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(2, read.Search("ALPHA", 10).Length);
        Assert.Single(read.Search("oversized", 10));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AppendRouterKeepsCorrectionsSynchronousAndFallsBackUnderBacklog(bool lucene)
    {
        using var entered = new ManualResetEventSlim();
        var options = new LLMContextOptions
        {
            DeferredIndexing = new() { ForegroundWords = 1, MaximumPendingEntries = 1 },
            BeforeDeferredIndexing = token => { entered.Set(); token.WaitHandle.WaitOne(); token.ThrowIfCancellationRequested(); }
        };
        var builder = LLMContextFactory.Create(options).WithExecutionStrategies(new()
        {
            Indexing = ContextIndexingStrategy.AppendOptimized,
            MinimumDeferredCharacters = 20
        });
        if (lucene) builder = builder.WithLuceneTermCollection();
        using var owner = builder.Initialize([ContextTests.Session(count: 1)]);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Append(2000, "prefix firstbackgroundsuffix")).Status);
        Assert.True(entered.Wait(Timeout));
        using var old = owner.OpenRead(Id(1));
        Assert.False(old.IndexStatus.IsComplete);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1,
            new ReplaceEntry(Id(1000), new TextContent("correction synchronoustail"))).Status);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 2, Append(2001, "second capacityfallbacktail")).Status);
        using (var read = owner.OpenRead(Id(1)))
        {
            Assert.Single(read.SearchIndexed("synchronoustail", 10).Hits);
            Assert.Single(read.SearchIndexed("capacityfallbacktail", 10).Hits);
            Assert.Single(read.Search("firstbackgroundsuffix", 10));
            Assert.Empty(read.SearchIndexed("firstbackgroundsuffix", 10).Hits);
        }
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 3,
            new ReplaceEntry(Id(2000), new TextContent("replacement ofpendingentrytail"))).Status);
        using var current = owner.OpenRead(Id(1));
        Assert.True(current.IndexStatus.IsComplete);
        Assert.Single(current.SearchIndexed("ofpendingentrytail", 10).Hits);
        Assert.Empty(current.Search("firstbackgroundsuffix", 10));
        Assert.Single(old.Search("firstbackgroundsuffix", 10));
        var stats = owner.GetStatistics().Execution!;
        Assert.Equal(1, stats.DeferredEntries);
        Assert.Equal(1, stats.DeferredCapacityFallbacks);
        Assert.Equal(4, stats.SynchronousEntries);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => owner.WaitForIndexingAsync(Id(1), 4, cancelled.Token));
        // Disposal cancels/joins the blocked stale job before clearing execution resources.
        owner.Dispose();
        Assert.Single(old.Search("firstbackgroundsuffix", 10));
        Assert.Single(current.Search("ofpendingentrytail", 10));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DeferredCompletionSeedsMemoAndLaterHitNeedsNoBackgroundJob(bool lucene)
    {
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var builder = LLMContextFactory.Create(new()
        {
            DeferredIndexing = new() { ForegroundWords = 1 },
            BeforeDeferredIndexing = token => { entered.Set(); release.Wait(token); }
        }).WithExecutionStrategies(new()
        {
            Indexing = ContextIndexingStrategy.AppendOptimized,
            MinimumDeferredCharacters = 8
        }).WithBitFasterTermMemoization(SmallMemo);
        if (lucene) builder = builder.WithLuceneTermCollection(LuceneTermCollection.CharTerm);
        using var owner = builder.Initialize([ContextTests.Session(count: 0)]);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Append(2000, "prefix complete suffix")).Status);
        Assert.True(entered.Wait(Timeout));
        using var old = owner.OpenRead(Id(1));
        release.Set();
        await owner.WaitForIndexingAsync(Id(1), 1).WaitAsync(Timeout);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, Append(2001, "prefix complete suffix")).Status);
        using var current = owner.OpenRead(Id(1));
        Assert.True(current.IndexStatus.IsComplete);
        Assert.Equal(2, current.SearchIndexed("suffix", 10).Hits.Length);
        Assert.False(old.IndexStatus.IsComplete);
        Assert.Single(old.Search("suffix", 10));
        var stats = owner.GetStatistics();
        Assert.Equal(1, stats.Execution!.DeferredEntries);
        Assert.Equal(1, stats.Execution.MemoHits);
        Assert.Equal(1, stats.Execution.TermCollections);
        Assert.Equal(1, stats.CompletedIndexJobs);
        Assert.Equal(0, stats.PendingIndexWork);
    }

    [Fact]
    public void SynchronousPinDoesNotStartDeferredWorkerOrChargeItsInfrastructure()
    {
        using var baseline = LLMContextFactory.Create().Initialize([ContextTests.Session()]);
        using var owner = LLMContextFactory.Create(new()
        {
            DeferredIndexing = new() { ForegroundWords = 1 },
            BeforeDeferredIndexing = _ => throw new InvalidOperationException("No worker should run.")
        }).WithExecutionStrategies(new() { Indexing = ContextIndexingStrategy.Synchronous })
            .WithLuceneTermCollection().Initialize([ContextTests.Session()]);
        using var read = owner.OpenRead(Id(1));
        Assert.True(read.IndexStatus.IsComplete);
        Assert.Equal(ContextExecutionRecipe.InfrastructureBytes,
            owner.GetStatistics().EstimatedActiveBytes - baseline.GetStatistics().EstimatedActiveBytes);
        Assert.Equal(0, owner.GetStatistics().PendingIndexWork);
        Assert.True(owner.WaitForIndexingAsync(Id(1), 0).IsCompletedSuccessfully);
    }

    [Fact]
    public async Task ConcurrentSessionsAndEvictionPreserveCapturedTerms()
    {
        var sessions = Enumerable.Range(1, 8).Select(id => ContextTests.Session(id, count: 0)).ToArray();
        using var owner = LLMContextFactory.Create().WithLuceneTermCollection()
            .WithBitFasterTermMemoization(SmallMemo).Initialize(sessions);
        await Task.WhenAll(sessions.Select(session => Task.Run(() =>
        {
            for (int i = 0; i < 24; i++)
            {
                var result = owner.Apply(new(session.SessionId, i, [
                    new AppendEntries([new(Guid.NewGuid(), ContextRole.User, DateTimeOffset.UnixEpoch,
                        new TextContent($"shared{i % 8} lexical suffix"))])
                ]));
                Assert.Equal(ContextMutationStatus.Applied, result.Status);
            }
            using var read = owner.OpenRead(session.SessionId);
            Assert.Equal(24, read.Search("suffix", 100).Length);
        }))).WaitAsync(Timeout);
        using var retained = owner.OpenRead(Id(1));
        Assert.InRange(owner.GetStatistics().Execution!.MemoEntries, 1, SmallMemo.Capacity);
        owner.Dispose();
        Assert.Equal(24, retained.Search("suffix", 100).Length);
    }

    [Fact]
    public void FailedInitializationDisposesOwnerPrivateMemoBeforeRecipeReuse()
    {
        TrackingMemo? created = null;
        var builder = LLMContextFactory.Create().WithTermMemo(4096, () => created = new());
        var session = ContextTests.Session();
        Assert.Throws<ArgumentException>(() => builder.Initialize([session, session]));
        Assert.NotNull(created);
        Assert.True(created.Disposed);
        using var owner = builder.Initialize([session]);
        Assert.False(created.Disposed);
        owner.Dispose();
        Assert.True(created.Disposed);
    }

    [Fact]
    public void DisposedOwnerReleasesMemoOnlyKeysEvenWhenOwnerAndLeaseStayReachable()
    {
        using var owner = LLMContextFactory.Create().WithBitFasterTermMemoization(SmallMemo)
            .Initialize([ContextTests.Session(count: 1)]);
        var weak = CacheThenDelete(owner);
        using var retained = owner.OpenRead(Id(1));
        Assert.True(IsAlive(weak));
        owner.Dispose();
        Assert.True(SpinWait.SpinUntil(() =>
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            return !IsAlive(weak);
        }, Timeout));
        Assert.Single(retained.Search("topic0", 10));
        GC.KeepAlive(owner);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    // Keep probe temporaries off the frame that forces collection.
    private static bool IsAlive(WeakReference<string> weak) => weak.TryGetTarget(out _);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference<string> CacheThenDelete(ILLMContextPolymorphicArray owner)
    {
        string text = new string('q', 1000) + " deletedmemo";
        var weak = new WeakReference<string>(text);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Append(2000, text)).Status);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, new DeleteEntry(Id(2000))).Status);
        return weak;
    }

    [Fact]
    public void InvalidSelectionsAreRejectedWithoutInitializingAnOwner()
    {
        var builder = LLMContextFactory.Create();
        Assert.Throws<ArgumentException>(() => builder.WithExecutionStrategies(new()
        { Indexing = ContextIndexingStrategy.AppendOptimized }));
        Assert.Throws<ArgumentOutOfRangeException>(() => builder.WithExecutionStrategies(new()
        { Indexing = (ContextIndexingStrategy)100 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => builder.WithExecutionStrategies(new()
        { Preparation = (ContextPreparationStrategy)100 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => builder.WithExecutionStrategies(new()
        { MinimumDeferredCharacters = 0 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => builder.WithLuceneTermCollection((LuceneTermCollection)100));
        Assert.Throws<ArgumentOutOfRangeException>(() => builder.WithBitFasterTermMemoization(new() { Capacity = 2 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => builder.WithBitFasterTermMemoization(new() { MaximumEstimatedBytes = 1 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => builder.WithBitFasterTermMemoization(new() { MaximumEstimatedBytes = long.MaxValue }));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RejectedCandidateCannotPublishContentOrJobsEvenIfMemoOrCountersChange(bool defer)
    {
        var builder = LLMContextFactory.Create(new()
        {
            DeferredIndexing = defer ? new() { ForegroundWords = 1 } : null
        }).WithLuceneTermCollection().WithBitFasterTermMemoization(SmallMemo);
        using var owner = builder.Initialize([ContextTests.Session(count: 0)]);
        var before = owner.GetStatistics();
        Assert.Equal(ContextMutationStatus.InvalidOperation, Apply(owner, 0,
            Append(2000, "private tentative suffix"), new DeleteEntry(Id(9999))).Status);
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(0, read.Session.Revision);
        Assert.Empty(read.ReadRange(0, 10));
        Assert.Empty(read.Search("tentative", 10));
        var after = owner.GetStatistics();
        Assert.Equal(before.EstimatedActiveBytes, after.EstimatedActiveBytes);
        Assert.Equal(before.PublishedMutations, after.PublishedMutations);
        Assert.Equal(0, after.PendingIndexWork);
        Assert.Equal(defer ? 0 : 1, after.Execution!.MemoEntries);
    }

    private sealed class TrackingMemo : IContextTermMemo
    {
        internal bool Disposed;
        public string Name => "Tracking";
        public int MaximumTextCharacters => 1024;
        public int Count => 0;
        public bool TryGet(string text, out ImmutableArray<string> terms) { terms = default; return false; }
        public bool TryAdd(string text, ImmutableArray<string> terms) => true;
        public void Dispose() => Disposed = true;
    }
}
