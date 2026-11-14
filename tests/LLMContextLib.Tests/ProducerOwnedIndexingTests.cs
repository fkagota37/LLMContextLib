// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using Xunit;

namespace LLMContextLib.Tests;

public sealed class ProducerOwnedIndexingTests
{
    private static Guid Id(int value) => ContextTests.Id(value);
    private static ContextIndexKeys Keys(params string[] keys) => new(keys);
    private static readonly TextContent Payload = new("The content does not define the producer's keys.");

    private static ContextEntry Entry(int id, int sequence, ContextIndexKeys keys) =>
        new(Id(id), sequence, ContextRole.User, DateTimeOffset.UnixEpoch, Payload) { IndexKeys = keys };

    private static LLMSessionContext Session(params ContextEntry[] entries) => ContextTests.Session(count: 0) with
    {
        Segments = entries.Length == 0 ? ImmutableSortedDictionary<long, ContextSegment>.Empty :
            ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, new(0, 0, entries.ToImmutableArray()))
    };

    private static ILLMContextPolymorphicArray Create(LLMSessionContext session, LLMContextOptions? options = null) =>
        LLMContextFactory.Create(options).WithProducerOwnedIndexing().Initialize([session]);

    private static AppendEntries Append(int id, ContextIndexKeys? keys) =>
        new([new(Id(id), ContextRole.User, DateTimeOffset.UnixEpoch, Payload) { IndexKeys = keys }]);

    private static ReplaceEntry Replace(int id, ContextIndexKeys? keys) => new(Id(id), Payload) { IndexKeys = keys };

    private static IContextMutationResult Apply(ILLMContextPolymorphicArray owner, long revision,
        params ContextChange[] changes) => owner.Apply(new(Id(1), revision, changes.ToImmutableArray()));

    [Fact]
    public void ImportedKeysAreCopiedOpaqueAndIndependentOfPayloadMeaning()
    {
        string[] source = ["entity:ACME/42", "two words", "", "entity:ACME/42"];
        var keys = new ContextIndexKeys(source);
        source[0] = "mutated";
        using var owner = Create(Session(Entry(10, 0, keys)));
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(ContextIndexingMode.ProducerOwned, read.IndexingMode);
        Assert.Single(read.SearchKeys(Keys("entity:ACME/42", "two words", ""), 10));
        Assert.Empty(read.SearchKeys(Keys("entity:acme/42"), 10));
        Assert.Empty(read.SearchKeys(Keys("two"), 10));
        Assert.Empty(read.SearchKeys(Keys("content"), 10));
        Assert.Empty(read.SearchKeys(Keys("mutated"), 10));
        Assert.Empty(read.SearchKeys(ContextIndexKeys.Empty, 10));
        Assert.Empty(read.SearchKeys(keys, 0));
        Assert.Throws<ArgumentOutOfRangeException>(() => read.SearchKeys(keys, -1));
        Assert.Throws<InvalidOperationException>(() => read.Search("entity:ACME/42", 10));
        Assert.Throws<InvalidOperationException>(() => read.SearchIndexed("content", 10));
        Assert.Throws<ArgumentException>(() => new ContextIndexKeys(["valid", null!]));
    }

    [Fact]
    public void ModeIsOptInAndIncompatibleTextWorkIsRejectedInEitherExtensionOrder()
    {
        var original = LLMContextFactory.Create();
        using var text = original.Initialize([ContextTests.Session()]);
        var producer = original.WithProducerOwnedIndexing();
        using var supplied = producer.Initialize([Session(Entry(10, 0, Keys("opaque")))]);
        using var read = text.OpenRead(Id(1));
        Assert.Single(read.Search("TOPIC0", 10));
        Assert.Single(read.SearchKeys(Keys("topic0"), 10));
        Assert.Empty(read.SearchKeys(Keys("TOPIC0"), 10));
        Assert.Throws<ArgumentException>(() => producer.WithLuceneTermCollection());
        Assert.Throws<ArgumentException>(() => original.WithLuceneTermCollection().WithProducerOwnedIndexing());
        Assert.Throws<ArgumentException>(() => producer.WithBitFasterTermMemoization());
        Assert.Throws<ArgumentException>(() => original.WithBitFasterTermMemoization().WithProducerOwnedIndexing());
        Assert.Throws<ArgumentException>(() => LLMContextFactory.Create(new()
        { DeferredIndexing = new() }).WithProducerOwnedIndexing());
        Assert.Throws<ArgumentException>(() => producer.Initialize([ContextTests.Session()]));
        Assert.Throws<ArgumentException>(() => original.Initialize([Session(Entry(10, 0, Keys("opaque")))]));
        Assert.Equal(ContextMutationStatus.InvalidOperation, Apply(text, 0, Append(20, Keys("opaque"))).Status);
    }

    [Fact]
    public void MissingKeysAndLateInvalidCommandsRollBackPayloadAndIndexTogether()
    {
        using var owner = Create(Session(Entry(10, 0, Keys("original"))));
        long active = owner.GetStatistics().EstimatedActiveBytes;
        Assert.Equal(ContextMutationStatus.InvalidOperation, Apply(owner, 0,
            Replace(10, Keys("tentative")), Append(20, null)).Status);
        Assert.Equal(ContextMutationStatus.InvalidOperation, Apply(owner, 0, Replace(10, null)).Status);
        Assert.Equal(active, owner.GetStatistics().EstimatedActiveBytes);
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(0, read.Session.Revision);
        Assert.Single(read.SearchKeys(Keys("original"), 10));
        Assert.Empty(read.SearchKeys(Keys("tentative"), 10));
        Assert.Single(read.ReadRange(0, 10));
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, Append(20, ContextIndexKeys.Empty)).Status);
    }

    [Fact]
    public void KeyOnlyRepeatedReplacementsSegmentReplacementAndDeletionStayCoherent()
    {
        using var owner = Create(Session(Entry(10, 0, Keys("old")), Entry(11, 1, Keys("second"))));
        using var old = owner.OpenRead(Id(1));
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0,
            Replace(10, Keys("temporary")), Replace(10, Keys("final", "literal/key")),
            Replace(11, ContextIndexKeys.Empty)).Status);
        using var current = owner.OpenRead(Id(1));
        Assert.Single(old.SearchKeys(Keys("old"), 10));
        Assert.Empty(current.SearchKeys(Keys("old"), 10));
        Assert.Empty(current.SearchKeys(Keys("temporary"), 10));
        Assert.Single(current.SearchKeys(Keys("final", "literal/key"), 10));
        Assert.Empty(current.SearchKeys(Keys("second"), 10));
        var segment = current.Session.Segments[0];
        var replacement = segment.Entries.SetItem(0, segment.Entries[0] with { IndexKeys = Keys("segment") });
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, new ReplaceSegment(0, replacement)).Status);
        using var afterSegment = owner.OpenRead(Id(1));
        Assert.Single(afterSegment.SearchKeys(Keys("segment"), 10));
        Assert.Empty(afterSegment.SearchKeys(Keys("final"), 10));
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 2, new DeleteEntry(Id(10))).Status);
        using var deleted = owner.OpenRead(Id(1));
        Assert.Empty(deleted.SearchKeys(Keys("segment"), 10));
        Assert.Equal(ContextMutationStatus.InvalidOperation, Apply(owner, 3, Append(10, Keys("reused"))).Status);
    }

    [Fact]
    public void EqualFreshContributionsRetainOnlyTheirOwnArrayInCurrentState()
    {
        var options = new LLMContextOptions { IndexingMode = ContextIndexingMode.ProducerOwned };
        var state = ContextStateBuilder.Initialize(Session(Entry(10, 0, Keys("same"))), options);
        var fresh = Keys("same");
        var transaction = new ContextStateBuilder(state, options);
        transaction.ApplyChanges([Replace(10, fresh)], 1);
        Assert.True(transaction.State.EntryTerms[Id(10)].Equals(fresh.Keys));
        Assert.Same(state.Search, transaction.State.Search);
        Assert.Equal(state.EstimatedBytes, transaction.State.EstimatedBytes);
    }

    [Fact]
    public void AnchorKeysDoNotMixWithEntryKeysAndRelocationRemovesOldAddresses()
    {
        using var owner = Create(Session(Entry(10, 0, Keys("entry")), Entry(11, 1, ContextIndexKeys.Empty)));
        var anchor = new ConversationAnchor(Id(50), Id(10), Id(11), "Unindexed title", "Unindexed summary",
            ["unindexed"], AnchorKind.Manual, 0, null)
        { IndexKeys = Keys("anchor") };
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 0, new PutAnchor(anchor)).Status);
        using var old = owner.OpenRead(Id(1));
        Assert.Empty(old.SearchKeys(Keys("entry", "anchor"), 10));
        Assert.Empty(old.SearchKeys(Keys("Unindexed"), 10));
        Assert.Single(old.SearchKeys(Keys("anchor"), 10));
        Assert.Equal(ContextMutationStatus.InvalidOperation, Apply(owner, 1,
            new PutAnchor(anchor with { IndexKeys = null })).Status);
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 1, new PutAnchor(anchor with
        { StartEntryId = Id(11), IndexKeys = Keys("moved") })).Status);
        using var moved = owner.OpenRead(Id(1));
        Assert.Empty(moved.SearchKeys(Keys("anchor"), 10));
        Assert.Equal(Id(11), Assert.Single(moved.SearchKeys(Keys("moved"), 10)).EntryId);
        Assert.Single(old.SearchKeys(Keys("anchor"), 10));
        Assert.Equal(ContextMutationStatus.Applied, Apply(owner, 2, new RemoveAnchor(Id(50))).Status);
        using var removed = owner.OpenRead(Id(1));
        Assert.Empty(removed.SearchKeys(Keys("moved"), 10));
    }

    [Fact]
    public void SuppliedIndexChargesParticipateInAdmissionAndRollback()
    {
        var session = Session(Entry(10, 0, ContextIndexKeys.Empty));
        string key = new('X', 1024);
        long delta = 200 + 4L * key.Length;
        using var baseline = Create(session);
        long active = baseline.GetStatistics().EstimatedActiveBytes;
        Assert.Equal(ContextMutationStatus.Applied, Apply(baseline, 0, Replace(10, Keys(key))).Status);
        Assert.Equal(active + delta, baseline.GetStatistics().EstimatedActiveBytes);
        using var limited = Create(session, new() { EstimatedResidentByteBudget = active + delta - 1 });
        Assert.Equal(ContextMutationStatus.AdmissionRejected, Apply(limited, 0, Replace(10, Keys(key))).Status);
        Assert.Equal(active, limited.GetStatistics().EstimatedActiveBytes);
        using var read = limited.OpenRead(Id(1));
        Assert.Equal(0, read.Session.Revision);
        Assert.Empty(read.SearchKeys(Keys(key), 10));
    }

    [Fact]
    public void MixedProducerWritesMatchAnIndependentKeySetModelAcrossSegments()
    {
        using var owner = Create(Session(), new() { MaximumEntriesPerSegment = 4 });
        var expected = new List<(Guid Id, HashSet<string> Keys)>();
        string[] universe = ["Case", "case", "path/42", "two words", "", "\u00e9"];
        var random = new Random(1729);
        for (int revision = 0; revision < 96; revision++)
        {
            string[] keys = universe.Where(_ => random.Next(2) == 0).ToArray();
            int choice = random.Next(10);
            ContextChange command;
            if (expected.Count < 3 || choice < 5)
            {
                int id = 1000 + revision;
                command = Append(id, Keys(keys));
                expected.Add((Id(id), new(keys, StringComparer.Ordinal)));
            }
            else
            {
                int index = random.Next(expected.Count);
                var previous = expected[index];
                if (choice < 8)
                {
                    command = new ReplaceEntry(previous.Id, Payload) { IndexKeys = Keys(keys) };
                    expected[index] = (previous.Id, new(keys, StringComparer.Ordinal));
                }
                else
                {
                    command = new DeleteEntry(previous.Id);
                    expected.RemoveAt(index);
                }
            }
            Assert.Equal(ContextMutationStatus.Applied, Apply(owner, revision, command).Status);
            using var read = owner.OpenRead(Id(1));
            Assert.Equal(expected.Select(entry => entry.Id), read.ReadRange(0, 100).Select(entry => entry.EntryId));
            foreach (string key in universe)
            {
                string[] query = revision % 2 == 0 ? [key] : [key, "Case"];
                var matches = expected.Where(entry => query.All(entry.Keys.Contains)).Take(3).Select(entry => entry.Id);
                Assert.Equal(matches, read.SearchKeys(Keys(query), 3).Select(hit => hit.EntryId));
            }
        }
    }

    [Theory]
    [InlineData(ContextPreparationStrategy.Speculative)]
    [InlineData(ContextPreparationStrategy.Serialized)]
    public void IndependentThousandCommandSubmissionsKeepStrictConflictsAndAtomicIndexes(ContextPreparationStrategy preparation)
    {
        using var owner = LLMContextFactory.Create(new() { AdmissionTimeout = TimeSpan.FromSeconds(5) })
            .WithProducerOwnedIndexing().WithExecutionStrategies(new() { Preparation = preparation })
            .Initialize([Session()]);
        var commands = new ContextChangeSet[1000];
        Parallel.For(0, commands.Length, i =>
            commands[i] = new(Id(1), 0, [Append(10_000 + i, Keys($"producer:{i}"))]));
        using var old = owner.OpenRead(Id(1));
        var results = new IContextMutationResult[commands.Length];
        Parallel.For(0, commands.Length, i => results[i] = owner.Apply(commands[i]));
        int winner = Assert.Single(Enumerable.Range(0, results.Length),
            i => results[i].Status == ContextMutationStatus.Applied);
        Assert.All(results.Where(result => result.Status != ContextMutationStatus.Applied), result =>
            Assert.True(result.Status is ContextMutationStatus.RevisionConflict or ContextMutationStatus.AdmissionRejected));
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(1, read.Session.Revision);
        Assert.Equal(Id(10_000 + winner), Assert.Single(read.ReadRange(0, 1000)).EntryId);
        for (int i = 0; i < commands.Length; i++)
            Assert.Equal(i == winner ? 1 : 0, read.SearchKeys(Keys($"producer:{i}"), 10).Length);
        Assert.Empty(old.ReadRange(0, 1000));
        var execution = owner.GetStatistics().Execution!;
        Assert.Equal("ProducerOwned", execution.TermCollector);
        Assert.Equal(0, execution.TermCollections);
        Assert.Equal(0, execution.MemoHits + execution.MemoMisses);
        Assert.Equal(0, owner.GetStatistics().PendingIndexWork);
    }

    [Fact]
    public void ViewsNavigationAndCapturedReadsSurviveRemovalAndOwnerDisposal()
    {
        var owner = Create(Session());
        var append = new AppendEntries([new(Guid.Empty, ContextRole.User, DateTimeOffset.UnixEpoch, Payload)
            { IndexKeys = Keys("navigation:key") }]);
        var result = Apply(owner, 0, append);
        Assert.Equal(ContextMutationStatus.Applied, result.Status);
        Guid entry = Assert.Single(result.AppendedEntryIds);
        using var read = owner.OpenRead(Id(1));
        using var view = owner.OpenView(ContextViews.SearchKeys(Id(1), Keys("navigation:key")));
        Assert.Equal(entry, Assert.Single(view).EntryId);
        Assert.True(read.TryFindEntry(entry, out _));
        Assert.Equal(ContextMutationStatus.Applied, owner.RemoveSession(Id(1), 1).Status);
        owner.Dispose();
        Assert.Equal(entry, Assert.Single(read.SearchKeys(Keys("navigation:key"), 10)).EntryId);
        Assert.Equal(entry, Assert.Single(view).EntryId);
        read.Dispose();
        Assert.Throws<ObjectDisposedException>(() => read.SearchKeys(Keys("navigation:key"), 10));
    }
}
