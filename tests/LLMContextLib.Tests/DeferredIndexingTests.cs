// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using Xunit;

namespace LLMContextLib.Tests;

public sealed class DeferredIndexingTests
{
    private static Guid Id(int value) => ContextTests.Id(value);
    private static readonly DateTimeOffset Now = DateTimeOffset.UnixEpoch;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private static LLMSessionContext Session(params string[] texts)
    {
        var entries = texts.Select((text, i) =>
            new ContextEntry(Id(1000 + i), i, ContextRole.User, Now, new TextContent(text))).ToImmutableArray();
        return new(Id(1), Id(2), Id(3), 0, SessionStatus.Active,
            entries.IsEmpty ? ImmutableSortedDictionary<long, ContextSegment>.Empty :
                ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, new(0, 0, entries)),
            ImmutableDictionary<Guid, ConversationAnchor>.Empty);
    }

    private static LLMContextOptions Options(Action<CancellationToken>? before = null) => new()
    {
        MaximumEntriesPerSegment = 16,
        AdmissionTimeout = TimeSpan.FromSeconds(2),
        DeferredIndexing = new() { ForegroundWords = 1, ForegroundCharacters = 64 },
        BeforeDeferredIndexing = before
    };

    private static ILLMContextPolymorphicArray Create(LLMSessionContext session, LLMContextOptions options) =>
        LLMContextFactory.Create(options).Initialize([session]);

    private static IContextMutationResult Apply(ILLMContextPolymorphicArray owner, long revision,
        params ContextChange[] changes) => owner.Apply(new(Id(1), revision, changes.ToImmutableArray()));

    [Theory]
    [InlineData(1, 1)]
    [InlineData(1, 7)]
    [InlineData(2, 8)]
    [InlineData(3, 64)]
    public void PrefixAndResumedPassPreserveExactLexicalSemantics(int words, int characters)
    {
        var inputs = new List<ContextContent>
        {
            new TextContent(""), new TextContent(" ,.! "), new TextContent("same same same rare"),
            new TextContent("alphabet soup"), new TextContent("\u00c9CLAIR \u0130 \ud800 caf\u00e9 123"),
            new ToolCallContent("call-id", "build_tool", "{\"file\":\"last match\"}"),
            new ToolResultContent("call-id", "{\"output\":\"last match\"}", false),
            new SummaryContent("first summary last", 0)
        };
        var random = new Random(1729);
        for (int i = 0; i < 128; i++)
            inputs.Add(new TextContent(new string(Enumerable.Range(0, random.Next(200))
                .Select(_ => (char)random.Next(char.MaxValue + 1)).ToArray())));
        foreach (var input in inputs)
        {
            var expected = ContextPolicies.Terms(ContextPolicies.Text(input));
            var prefix = ContextIndexTokenizer.Prefix(input,
                new() { ForegroundWords = words, ForegroundCharacters = characters });
            var pending = new PendingEntryIndex(input, prefix.Terms, prefix.ResumeOffset, 0, 0);
            Assert.Equal<string>(expected, ContextIndexTokenizer.Full(input));
            Assert.Equal<string>(expected, prefix.Complete ? prefix.Terms :
                ContextIndexTokenizer.Complete(pending, CancellationToken.None));
            Assert.Equal(ContextPolicies.Text(input).Length, ContextIndexTokenizer.TextLength(input));
        }
        var cut = ContextIndexTokenizer.Prefix(new TextContent("alphabet soup"),
            new() { ForegroundWords = 1, ForegroundCharacters = 3 });
        Assert.Empty(cut.Terms);
        Assert.Equal(0, cut.ResumeOffset);
        var repeated = ContextIndexTokenizer.Prefix(new TextContent("same same same rare"),
            new() { ForegroundWords = 2 });
        Assert.Equal<string>(["same"], repeated.Terms);
        Assert.False(repeated.Complete);
    }

    [Fact]
    public async Task ExactFallbackFindsAdditionalMatchesAndOldLeaseNeverRefreshes()
    {
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = Create(Session("late first", "prefix late"),
            Options(token => { entered.Set(); release.Wait(token); }));
        Assert.True(entered.Wait(Timeout));
        using var old = owner.OpenRead(Id(1));
        Assert.Equal(2, old.IndexStatus.PendingEntries);
        Assert.Equal(2, old.Search("late", 10).Length);
        Assert.Single(old.Search("prefix late", 10));
        var indexed = old.SearchIndexed("late", 10);
        Assert.False(indexed.IndexStatus.IsComplete);
        Assert.Single(indexed.Hits);
        Assert.Empty(old.SearchIndexed("prefix late", 10).Hits);
        var charged = owner.GetStatistics();
        Assert.Equal(2, charged.PendingIndexWork);
        Assert.True(charged.EstimatedIndexWorkBytes > 0);
        release.Set();
        await owner.WaitForIndexingAsync(Id(1), 0).WaitAsync(Timeout);
        var settled = owner.GetStatistics();
        using var current = owner.OpenRead(Id(1));
        Assert.True(current.IndexStatus.IsComplete);
        Assert.True(current.IndexStatus.IndexGeneration > old.IndexStatus.IndexGeneration);
        Assert.Equal(old.Session, current.Session);
        Assert.Equal<ContextSearchHit>(old.Search("late", 10), current.SearchIndexed("late", 10).Hits);
        Assert.Equal(2, old.IndexStatus.PendingEntries);
        Assert.Single(old.SearchIndexed("late", 10).Hits);
        Assert.Equal(0, settled.PendingIndexWork);
        Assert.Equal(0, settled.EstimatedIndexWorkBytes);
        Assert.Equal(2, settled.CompletedIndexJobs);
        Assert.Equal(charged.PublishedMutations, settled.PublishedMutations);
        Assert.True(settled.EstimatedActiveBytes < charged.EstimatedActiveBytes);
        Assert.Equal(charged.EstimatedRetainedBytes, settled.EstimatedRetainedBytes);
        Assert.Empty(current.Search("late", 0));
        Assert.Throws<ArgumentOutOfRangeException>(() => current.SearchIndexed("late", -1));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReplacementAndDeletionDiscardObsoleteWorkWithoutResurrection(bool delete)
    {
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = Create(Session("prefix obsolete"),
            Options(token => { entered.Set(); release.Wait(token); }));
        Assert.True(entered.Wait(Timeout));
        using var old = owner.OpenRead(Id(1));
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, delete
            ? new DeleteEntry(Id(1000)) : new ReplaceEntry(Id(1000), new TextContent("fresh newtail"))).Status);
        var completion = owner.WaitForIndexingAsync(Id(1), 1);
        Assert.False(completion.IsCompleted);
        release.Set();
        await completion.WaitAsync(Timeout);
        using var current = owner.OpenRead(Id(1));
        Assert.True(current.IndexStatus.IsComplete);
        Assert.Empty(current.Search("obsolete", 10));
        Assert.Empty(current.SearchIndexed("obsolete", 10).Hits);
        Assert.Equal(delete ? 0 : 1, current.SearchIndexed("newtail", 10).Hits.Length);
        Assert.Single(old.Search("obsolete", 10));
        Assert.Equal(1, owner.GetStatistics().DiscardedIndexJobs);
        Assert.Equal(0, owner.GetStatistics().PendingIndexWork);
    }

    [Fact]
    public async Task RemovedSessionLeavesOnlyChargedJobContentAndIdentityUntilWorkerReleases()
    {
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var options = Options(token => { entered.Set(); release.Wait(token); });
        using var owner = Create(Session("prefix obsolete"), options);
        Assert.True(entered.Wait(Timeout));
        using var old = owner.OpenRead(Id(1));
        Assert.Equal(ContextMutationStatus.Applied, owner.RemoveSession(Id(1), 0).Status);
        var removed = owner.GetStatistics();
        long infrastructure = ContextIndexTokenizer.InfrastructureReservation(options.DeferredIndexing!.MaximumPendingEntries);
        Assert.Equal(infrastructure + 48 + removed.EstimatedIndexWorkBytes, removed.EstimatedActiveBytes);
        await Assert.ThrowsAsync<KeyNotFoundException>(() => owner.WaitForIndexingAsync(Id(1), 0));
        release.Set();
        Assert.True(SpinWait.SpinUntil(() => owner.GetStatistics().PendingIndexWork == 0, Timeout));
        Assert.Equal(infrastructure + 48, owner.GetStatistics().EstimatedActiveBytes);
        Assert.Single(old.Search("obsolete", 10));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BacklogAdmissionRejectsWholeMutationWithoutPublishingOrEnqueueing(bool byteLimit)
    {
        const string text = "prefix retained payload";
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var options = Options(token => { entered.Set(); release.Wait(token); });
        options = options with
        {
            DeferredIndexing = options.DeferredIndexing! with
            {
                MaximumPendingEntries = byteLimit ? 2 : 1,
                MaximumEstimatedWorkBytes = byteLimit ? ContextIndexTokenizer.WorkReservation(text.Length) : 1024 * 1024
            }
        };
        using var owner = Create(Session(text), options);
        Assert.True(entered.Wait(Timeout));
        var before = owner.GetStatistics();
        var result = Apply(owner, 0,
            new AppendEntries([new(Id(2000), ContextRole.User, Now, new TextContent(text))]));
        Assert.Equal(ContextMutationStatus.AdmissionRejected, result.Status);
        Assert.Equal(before, owner.GetStatistics());
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(0, read.Session.Revision);
        Assert.False(read.TryFindEntry(Id(2000), out _));
        release.Set();
        await owner.WaitForIndexingAsync(Id(1), 0).WaitAsync(Timeout);
    }

    [Fact]
    public void RemainingIndexReservationCanRejectContentThatFitsItsPayloadSegment()
    {
        using var owner = Create(Session(), Options() with { EstimatedResidentByteBudget = 16 * 1024 });
        var before = owner.GetStatistics();
        Assert.Equal(ContextMutationStatus.AdmissionRejected, Apply(owner, 0,
            new AppendEntries([new(Id(2000), ContextRole.User, Now, new TextContent(new string('a', 1000)))])).Status);
        Assert.Equal(before, owner.GetStatistics());
        using var read = owner.OpenRead(Id(1));
        Assert.Empty(read.ReadRange(0, 10));
        Assert.True(read.IndexStatus.IsComplete);
    }

    [Fact]
    public async Task LateInvalidBatchDoesNotCreateBackgroundJobs()
    {
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = Create(Session("prefix original"),
            Options(token => { entered.Set(); release.Wait(token); }));
        Assert.True(entered.Wait(Timeout));
        var before = owner.GetStatistics();
        Assert.Equal(ContextMutationStatus.InvalidOperation, Apply(owner, 0,
            new ReplaceEntry(Id(1000), new TextContent("prefix speculative")),
            new DeleteEntry(Id(9999))).Status);
        Assert.Equal(before, owner.GetStatistics());
        using var read = owner.OpenRead(Id(1));
        Assert.Single(read.Search("original", 10));
        Assert.Empty(read.Search("speculative", 10));
        release.Set();
        await owner.WaitForIndexingAsync(Id(1), 0).WaitAsync(Timeout);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OnlyDerivedProgressCanRebaseOverSpeculativePreparation(bool contentConflict)
    {
        using var workerEntered = new ManualResetEventSlim();
        using var releaseWorker = new ManualResetEventSlim();
        using var preparing = new ManualResetEventSlim();
        using var releasePreparation = new ManualResetEventSlim();
        var options = Options(token => { workerEntered.Set(); releaseWorker.Wait(token); }) with
        {
            EntrySizeEstimator = entry =>
            {
                if (entry.Content is TextContent { Text: "replacement" })
                {
                    preparing.Set();
                    Assert.True(releasePreparation.Wait(Timeout));
                }
                return ContextPolicies.EstimateEntryBytes(entry);
            }
        };
        using var owner = Create(Session("prefix tailone", "prefix tailtwo"), options);
        Assert.True(workerEntered.Wait(Timeout));
        var writing = Task.Run(() => Apply(owner, 0, new ReplaceEntry(Id(1001), new TextContent("replacement"))));
        try
        {
            Assert.True(preparing.Wait(Timeout));
            if (contentConflict)
                Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, new SetSessionStatus(SessionStatus.Active)).Status);
            releaseWorker.Set();
            await owner.WaitForIndexingAsync(Id(1), contentConflict ? 1 : 0).WaitAsync(Timeout);
        }
        finally { releasePreparation.Set(); releaseWorker.Set(); }
        var result = await writing.WaitAsync(Timeout);
        Assert.Equal(contentConflict ? ContextMutationStatus.RevisionConflict : ContextMutationStatus.Applied, result.Status);
        using var read = owner.OpenRead(Id(1));
        Assert.True(read.IndexStatus.IsComplete);
        Assert.Single(read.SearchIndexed("tailone", 10).Hits);
        Assert.Equal(contentConflict ? 0 : 1, read.Search("replacement", 10).Length);
    }

    [Fact]
    public async Task FailureIsObservableWhileExactSearchStillWorksAndReplacementCanRecover()
    {
        using var owner = Create(Session("prefix late"),
            Options(_ => throw new InvalidOperationException("simulated index failure")));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => owner.WaitForIndexingAsync(Id(1), 0).WaitAsync(Timeout));
        Assert.Contains("simulated index failure", error.Message);
        Assert.True(SpinWait.SpinUntil(() => owner.GetStatistics().PendingIndexWork == 0, Timeout));
        using var failed = owner.OpenRead(Id(1));
        Assert.Equal(1, failed.IndexStatus.FailedEntries);
        Assert.False(failed.IndexStatus.IsComplete);
        Assert.Empty(failed.SearchIndexed("late", 10).Hits);
        Assert.Single(failed.Search("late", 10));
        Assert.Equal(ContextMutationStatus.Applied,
            Apply(owner, 0, new ReplaceEntry(Id(1000), new TextContent("recovered"))).Status);
        await owner.WaitForIndexingAsync(Id(1), 1).WaitAsync(Timeout);
        using var recovered = owner.OpenRead(Id(1));
        Assert.True(recovered.IndexStatus.IsComplete);
        Assert.Single(recovered.SearchIndexed("recovered", 10).Hits);
    }

    [Fact]
    public async Task CancellationOnlyCancelsWaitAndDisposalCancelsWorkerWithoutInvalidatingLease()
    {
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var owner = Create(Session("prefix late"), Options(token => { entered.Set(); release.Wait(token); }));
        Assert.True(entered.Wait(Timeout));
        using var lease = owner.OpenRead(Id(1));
        using var cancellation = new CancellationTokenSource();
        var cancelled = owner.WaitForIndexingAsync(Id(1), 0, cancellation.Token);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        Assert.Equal(1, owner.GetStatistics().PendingIndexWork);
        var pending = owner.WaitForIndexingAsync(Id(1), 0);
        owner.Dispose();
        await Assert.ThrowsAsync<ObjectDisposedException>(() => pending.WaitAsync(Timeout));
        Assert.Single(lease.Search("late", 10));
        Assert.False(lease.IndexStatus.IsComplete);
        await Assert.ThrowsAsync<ObjectDisposedException>(() => owner.WaitForIndexingAsync(Id(1), 0));
    }

    [Fact]
    public async Task DeferredMutationPathsMatchSynchronousSearchIncludingAnchorAddresses()
    {
        using var release = new ManualResetEventSlim();
        var initial = Session("prefix alpha late", "prefix beta late");
        using var deferred = Create(initial, Options(token => release.Wait(token)));
        using var synchronous = Create(initial, Options() with { DeferredIndexing = null });
        ImmutableArray<ContextChange>[] batches =
        [
            [new ReplaceEntry(Id(1000), new TextContent("prefix discarded")),
                new ReplaceEntry(Id(1000), new TextContent("prefix final late"))],
            [new AppendEntries([new(Id(2000), ContextRole.User, Now, new TextContent("prefix appended late"))]),
                new ReplaceEntry(Id(2000), new TextContent("prefix corrected late"))],
            [new DeleteEntry(Id(1001)), new PutAnchor(new(Id(3000), Id(1000), Id(2000),
                "anchor", "late bookmark", ["topic"], AnchorKind.Topic, 2, null))]
        ];
        long revision = 0;
        foreach (var batch in batches)
        {
            Assert.Equal(ContextMutationStatus.Applied, synchronous.Apply(new(Id(1), revision, batch)).Status);
            Assert.Equal(ContextMutationStatus.Applied, deferred.Apply(new(Id(1), revision++, batch)).Status);
            using var expected = synchronous.OpenRead(Id(1));
            using var actual = deferred.OpenRead(Id(1));
            foreach (string query in new[] { "prefix", "late", "prefix late", "alpha", "final", "corrected", "anchor late", "prefix anchor" })
            {
                Assert.Equal<ContextSearchHit>(expected.Search(query, 100), actual.Search(query, 100));
                Assert.All(actual.SearchIndexed(query, 100).Hits, hit => Assert.Contains(hit, expected.Search(query, 100)));
            }
        }
        using (var read = synchronous.OpenRead(Id(1)))
        {
            var entries = read.Session.Segments[0].Entries.Select(entry =>
                entry with { Content = new TextContent("prefix segment late") }).ToImmutableArray();
            var batch = new ContextChangeSet(Id(1), revision++, [new ReplaceSegment(0, entries)]);
            Assert.Equal(ContextMutationStatus.Applied, synchronous.Apply(batch).Status);
            Assert.Equal(ContextMutationStatus.Applied, deferred.Apply(batch).Status);
        }
        release.Set();
        await deferred.WaitForIndexingAsync(Id(1), revision).WaitAsync(Timeout);
        using var finalExpected = synchronous.OpenRead(Id(1));
        using var finalActual = deferred.OpenRead(Id(1));
        Assert.True(finalActual.IndexStatus.IsComplete);
        Assert.Equal<ContextSearchHit>(finalExpected.Search("segment late", 100), finalActual.SearchIndexed("segment late", 100).Hits);
    }

    [Fact]
    public void WholeBatchCapacityAndFailedInitializationDoNotLeaveAcceptedWork()
    {
        var options = Options() with
        {
            DeferredIndexing = new() { ForegroundWords = 1, MaximumPendingEntries = 1 }
        };
        using var owner = Create(Session(), options);
        var before = owner.GetStatistics();
        Assert.Equal(ContextMutationStatus.AdmissionRejected, Apply(owner, 0,
            new AppendEntries([
                new(Id(2000), ContextRole.User, Now, new TextContent("prefix first")),
                new(Id(2001), ContextRole.User, Now, new TextContent("prefix second"))
            ])).Status);
        Assert.Equal(before, owner.GetStatistics());
        Assert.Throws<ArgumentException>(() => Create(Session("prefix first", "prefix second"), options));

        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var session = Session("prefix first");
        var builder = LLMContextFactory.Create(Options(token => { entered.Set(); release.Wait(token); }));
        Assert.Throws<ArgumentException>(() => builder.Initialize([session, session]));
    }

    [Theory]
    [InlineData(0, 1, 1, 1)]
    [InlineData(1, 0, 1, 1)]
    [InlineData(1, 1, 0, 1)]
    [InlineData(1, 1, 1, 0)]
    public void InvalidIndexingLimitsAreRejectedBeforeStartingWorker(int words, int characters, int count, long bytes)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => LLMContextFactory.Create(new()
        {
            DeferredIndexing = new()
            {
                ForegroundWords = words,
                ForegroundCharacters = characters,
                MaximumPendingEntries = count,
                MaximumEstimatedWorkBytes = bytes
            }
        }));
    }

    [Fact]
    public async Task IndependentWritersAndSnapshotSearchesConvergeWithoutLeakedWork()
    {
        var options = Options() with
        {
            DeferredIndexing = new() { ForegroundWords = 1, MaximumPendingEntries = 256 }
        };
        using var owner = LLMContextFactory.Create(options).Initialize(
            Enumerable.Range(1, 4).Select(id => Session() with { SessionId = Id(id) }));
        await Task.WhenAll(Enumerable.Range(1, 4).Select(id => Task.Run(async () =>
        {
            for (int i = 0; i < 32; i++)
            {
                var result = owner.Apply(new(Id(id), i, [new AppendEntries([
                    new(Id(1000 + i), ContextRole.User, Now, new TextContent($"prefix message{id}item{i} tail"))
                ])]));
                Assert.Equal(ContextMutationStatus.Applied, result.Status);
                using var read = owner.OpenRead(Id(id));
                Assert.Equal(i + 1, read.Search("tail", 100).Length);
                Assert.True(read.SearchIndexed("tail", 100).Hits.Length <= i + 1);
            }
            await owner.WaitForIndexingAsync(Id(id), 32).WaitAsync(Timeout);
            using var final = owner.OpenRead(Id(id));
            Assert.True(final.IndexStatus.IsComplete);
            Assert.Equal(32, final.SearchIndexed("tail", 100).Hits.Length);
        }))).WaitAsync(Timeout);
        Assert.Equal(0, owner.GetStatistics().PendingIndexWork);
        Assert.Equal(0, owner.GetStatistics().EstimatedIndexWorkBytes);
        Assert.Equal(128, owner.GetStatistics().CompletedIndexJobs);
        Assert.Equal(0, owner.GetStatistics().RetainedReads);
    }

    [Fact]
    public async Task IdleWorkerDoesNotRetainDeletedCompletedPayload()
    {
        using var owner = Create(Session(), Options());
        var weak = AppendPayload(owner);
        await owner.WaitForIndexingAsync(Id(1), 1).WaitAsync(Timeout);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, new DeleteEntry(Id(2000))).Status);
        Assert.True(SpinWait.SpinUntil(() =>
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            return !weak.TryGetTarget(out _);
        }, Timeout));
        GC.KeepAlive(owner);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference<ContextContent> AppendPayload(ILLMContextPolymorphicArray owner)
    {
        var content = new TextContent(new string('x', 5000) + " tail");
        var weak = new WeakReference<ContextContent>(content);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0,
            new AppendEntries([new(Id(2000), ContextRole.User, Now, content)])).Status);
        return weak;
    }
}
