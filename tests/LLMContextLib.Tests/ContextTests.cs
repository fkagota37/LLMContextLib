// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using LLMContextLib;
using Xunit;

namespace LLMContextLib.Tests;

public sealed class ContextTests
{
    private static readonly Guid User = Id(100);
    private static readonly Guid Repository = Id(200);
    private static readonly DateTimeOffset Now = new(2026, 11, 10, 0, 0, 0, TimeSpan.Zero);
    internal static Guid Id(int value) => new(value, 0, 0, new byte[8]);
    private static ContextEntry Entry(int id, long sequence, string text) =>
        new(Id(id), sequence, ContextRole.User, Now, new TextContent(text));

    internal static LLMSessionContext Session(int id = 1, int count = 4)
    {
        var segments = ImmutableSortedDictionary.CreateBuilder<long, ContextSegment>();
        for (int i = 0; i < count; i += 2)
            segments.Add(i / 2, new(i / 2, 0, Enumerable.Range(i, Math.Min(2, count - i))
                .Select(index => Entry(1000 * id + index, index, $"message topic{index}")).ToImmutableArray()));
        return new(Id(id), User, Repository, 0, SessionStatus.Active, segments.ToImmutable(),
            ImmutableDictionary<Guid, ConversationAnchor>.Empty);
    }

    private static LLMContextOptions Options => new()
    {
        MaximumEntriesPerSegment = 2,
        AdmissionTimeout = TimeSpan.FromSeconds(3)
    };

    private static ILLMContextPolymorphicArray Create(LLMSessionContext session, LLMContextOptions? options = null) =>
        LLMContextFactory.Create(options ?? Options).Initialize([session]);

    private static IContextMutationResult Change(ILLMContextPolymorphicArray owner, long revision, params ContextChange[] changes) =>
        owner.Apply(new(Id(1), revision, changes.ToImmutableArray()));

    private static ConversationAnchor Anchor(LLMSessionContext session, Guid? id = null) =>
        new(id ?? Id(500), session.Segments[0].Entries[0].EntryId, session.Segments[0].Entries[1].EntryId,
            "Memory policy", "Repository versus session guidance", ["memory", "policy"], AnchorKind.Topic, session.Revision, null);

    [Theory]
    [InlineData("MESSAGE topic0", 0)]
    [InlineData("message fresh fresh", -2)]
    [InlineData("", -236)]
    public void IndexAccountingPreservesSharedTermsAndDistinctMembershipCharges(string text, long indexDelta)
    {
        var session = Session();
        using var owner = Create(session);
        using var before = owner.OpenRead(Id(1));
        long active = owner.GetStatistics().EstimatedActiveBytes;
        var original = session.Segments[0].Entries[0];
        long entryDelta = ContextPolicies.EstimateEntryBytes(original with { Content = new TextContent(text) }) -
            ContextPolicies.EstimateEntryBytes(original);
        long termsDelta = ContextStateBuilder.EstimateEntryTermsBytes(ContextPolicies.Terms(text)) -
            ContextStateBuilder.EstimateEntryTermsBytes(ContextPolicies.Terms(ContextPolicies.Text(original.Content)));
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0,
            new ReplaceEntry(original.EntryId, new TextContent(text))).Status);
        Assert.Equal(active + entryDelta + indexDelta + termsDelta, owner.GetStatistics().EstimatedActiveBytes);
        using var after = owner.OpenRead(Id(1));
        Assert.Single(before.Search("topic0", 10));
        Assert.Equal(text.Length == 0 ? 3 : 4, after.Search("message", 10).Length);
        Assert.Equal(text.Contains("fresh", StringComparison.Ordinal) ? 1 : 0, after.Search("fresh", 10).Length);
        Assert.Equal(ContextMutationStatus.InvalidOperation, Change(owner, 1,
            new ReplaceEntry(Id(1000), new TextContent("tentative index")),
            new DeleteEntry(Id(9999))).Status);
        Assert.Equal(active + entryDelta + indexDelta + termsDelta, owner.GetStatistics().EstimatedActiveBytes);
        using var rejected = owner.OpenRead(Id(1));
        Assert.Equal(after.Session, rejected.Session);
        Assert.Empty(rejected.Search("tentative", 10));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IndexAccountingStillChecksIntermediateAdditionAndSubtraction(bool add)
    {
        var state = ContextStateBuilder.Initialize(Session(), Options) with
        {
            EstimatedBytes = add ? long.MaxValue : long.MinValue
        };
        var builder = new ContextStateBuilder(state, Options);
        ContextChange change = add
            ? new AppendEntries([new(Id(9000), ContextRole.User, Now, new TextContent("overflowword"))])
            : new DeleteEntry(Id(1000));
        Assert.Throws<OverflowException>(() => builder.ApplyChanges([change], 1));
        Assert.Same(state.Search, builder.State.Search);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ReplacementsShareUnchangedPostingsIncludingRepeatedBatchEdits(bool batch)
    {
        var state = ContextStateBuilder.Initialize(Session(), Options);
        var builder = new ContextStateBuilder(state, Options);
        ImmutableArray<ContextChange> changes = batch
            ? [new ReplaceEntry(Id(1000), new TextContent("MESSAGE fresh")),
                new ReplaceEntry(Id(1000), new TextContent("fresh message finish"))]
            : [new ReplaceEntry(Id(1000), new TextContent("MESSAGE fresh"))];
        builder.ApplyChanges(changes, 1);
        Assert.Same(state.Search["message"], builder.State.Search["message"]);
        Assert.Same(state.Search["topic1"], builder.State.Search["topic1"]);
        Assert.False(builder.State.Search.ContainsKey("topic0"));
        Assert.Equal(new SearchAddress(Id(1000), null), Assert.Single(builder.State.Search["fresh"]));
        Assert.True(state.Search.ContainsKey("topic0"));
        Assert.False(state.Search.ContainsKey("fresh"));
    }

    [Theory]
    [InlineData("message topic0", "TOPIC0, message MESSAGE!")]
    [InlineData("\u00c9CLAIR caf\u00e9 123", "123 \u00e9clair CAF\u00c9 caf\u00e9")]
    [InlineData("", " ,.! ")]
    public void LexicallyEquivalentReplacementSharesTheWholeSearchIndex(string oldText, string newText)
    {
        var session = Session();
        var segment = session.Segments[0];
        segment = segment with
        {
            Entries = segment.Entries.SetItem(0,
            segment.Entries[0] with { Content = new TextContent(oldText) })
        };
        session = session with { Segments = session.Segments.SetItem(0, segment) };
        var state = ContextStateBuilder.Initialize(session, Options);
        var builder = new ContextStateBuilder(state, Options);
        builder.ApplyChanges([new ReplaceEntry(Id(1000), new TextContent(newText))], 1);
        Assert.Same(state.Search, builder.State.Search);
        Assert.Same(state.EntryTerms, builder.State.EntryTerms);
        Assert.Equal(newText, ((TextContent)builder.State.Session.Segments[0].Entries[0].Content).Text);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void RetainedEntryTermsFollowSingleBatchAndWholeSegmentReplacements(int path)
    {
        var state = ContextStateBuilder.Initialize(Session(), Options);
        var builder = new ContextStateBuilder(state, Options);
        var content = new TextContent("\u00c9CLAIR fresh FRESH 123");
        ImmutableArray<ContextChange> changes = path switch
        {
            1 => [new ReplaceEntry(Id(1000), new TextContent("discarded")),
                new ReplaceEntry(Id(1000), content)],
            2 => [new ReplaceSegment(0, state.Session.Segments[0].Entries.SetItem(0,
                state.Session.Segments[0].Entries[0] with { Content = content }))],
            _ => [new ReplaceEntry(Id(1000), content)]
        };
        builder.ApplyChanges(changes, 1);

        Assert.Equal<string>(ContextPolicies.Terms(content.Text), builder.State.EntryTerms[Id(1000)]);
        Assert.True(state.EntryTerms[Id(1001)] == builder.State.EntryTerms[Id(1001)]);
        Assert.Equal<string>(["message", "topic0"], state.EntryTerms[Id(1000)]);
        Assert.False(builder.State.Search.ContainsKey("discarded"));
        Assert.False(builder.State.Search.ContainsKey("topic0"));
        Assert.Equal(state.Locations.Count, builder.State.EntryTerms.Count);
    }

    [Fact]
    public void MixedAppendReplaceDeleteKeepsTermsOnlyForLiveEntriesInItsOwnGeneration()
    {
        var state = ContextStateBuilder.Initialize(Session(), Options);
        var builder = new ContextStateBuilder(state, Options);
        builder.ApplyChanges([
            new AppendEntries([new(Id(9000), ContextRole.User, Now, new TextContent("temporary"))]),
            new ReplaceEntry(Id(9000), new TextContent("final FINAL")),
            new DeleteEntry(Id(1000)),
            new DeleteEntry(Id(1001))
        ], 1);
        Assert.Equal(builder.State.Locations.Keys.Order(), builder.State.EntryTerms.Keys.Order());
        Assert.Equal<string>(["final"], builder.State.EntryTerms[Id(9000)]);
        Assert.False(builder.State.Search.ContainsKey("temporary"));
        Assert.False(builder.State.Search.ContainsKey("topic0"));
        Assert.False(builder.State.Search.ContainsKey("topic1"));
        Assert.Equal(4, state.EntryTerms.Count);
        Assert.True(state.EntryTerms.ContainsKey(Id(1000)));
        Assert.False(state.EntryTerms.ContainsKey(Id(9000)));
    }

    [Fact]
    public void DeletingAllEntriesReleasesTermMetadataButNotIdentityReservations()
    {
        var session = Session();
        var state = ContextStateBuilder.Initialize(session, Options);
        var builder = new ContextStateBuilder(state, Options);
        builder.ApplyChanges(ContextPolicies.Entries(session)
            .Select(entry => (ContextChange)new DeleteEntry(entry.EntryId)).ToImmutableArray(), 1);
        var empty = session with
        {
            Segments = session.Segments.ToImmutableSortedDictionary(pair => pair.Key,
                pair => pair.Value with { Entries = [] })
        };
        var emptyState = ContextStateBuilder.Initialize(empty, Options);

        Assert.Empty(builder.State.EntryTerms);
        Assert.Empty(builder.State.Search);
        Assert.Equal(emptyState.EstimatedBytes + 48L * state.EntryTerms.Count, builder.State.EstimatedBytes);
        Assert.Equal(state.SeenEntryIds, builder.State.SeenEntryIds);
        Assert.Equal(4, state.EntryTerms.Count);
    }

    [Fact]
    public void TermMetadataParticipatesInCreationMutationAndCapturedRootAdmission()
    {
        var session = Session();
        var state = ContextStateBuilder.Initialize(session, Options);
        using (var rejected = LLMContextFactory.Create(Options with
        {
            AdmissionTimeout = TimeSpan.Zero,
            EstimatedResidentByteBudget = state.EstimatedBytes + 47
        }).Initialize([]))
        {
            Assert.Equal(ContextMutationStatus.AdmissionRejected, rejected.CreateSession(session).Status);
            Assert.Equal(0, rejected.GetStatistics().EstimatedActiveBytes);
            Assert.False(rejected.TryFind(session.SessionId, out _));
        }

        var change = new ReplaceEntry(Id(1000), new TextContent("a b c d e f g h"));
        var candidate = new ContextStateBuilder(state, Options);
        candidate.ApplyChanges([change], 1);
        Assert.True(ContextStateBuilder.EstimateEntryTermsBytes(candidate.State.EntryTerms[Id(1000)]) >
            ContextStateBuilder.EstimateEntryTermsBytes(state.EntryTerms[Id(1000)]));
        using (var tight = Create(session, Options with
        {
            AdmissionTimeout = TimeSpan.Zero,
            EstimatedResidentByteBudget = candidate.State.EstimatedBytes + 47
        }))
        {
            var before = tight.GetStatistics();
            Assert.Equal(ContextMutationStatus.AdmissionRejected, Change(tight, 0, change).Status);
            Assert.Equal(before, tight.GetStatistics());
            Assert.Equal(ContextMutationStatus.Applied, Change(tight, 0,
                new ReplaceEntry(Id(1000), new TextContent("TOPIC0 message"))).Status);
        }

        using (var retentionLimited = Create(session, Options with
        {
            AdmissionTimeout = TimeSpan.Zero,
            MaximumEstimatedRetainedBytes = state.EstimatedBytes - 1
        }))
        {
            var before = retentionLimited.GetStatistics();
            Assert.Throws<InvalidOperationException>(() => retentionLimited.OpenRead(session.SessionId));
            Assert.Equal(before, retentionLimited.GetStatistics());
        }

        using var owner = Create(session);
        using var retained = owner.OpenRead(session.SessionId);
        Assert.Equal(state.EstimatedBytes + 48, owner.GetStatistics().EstimatedActiveBytes);
        Assert.Equal(state.EstimatedBytes, owner.GetStatistics().EstimatedRetainedBytes);
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0, change).Status);
        Assert.Equal(candidate.State.EstimatedBytes + 48, owner.GetStatistics().EstimatedActiveBytes);
        Assert.Equal(state.EstimatedBytes, owner.GetStatistics().EstimatedRetainedBytes);
        Assert.Equal(ContextMutationStatus.Applied, owner.RemoveSession(session.SessionId, 1).Status);
        Assert.Equal(48, owner.GetStatistics().EstimatedActiveBytes);
        Assert.Single(retained.Search("topic0", 10));
        Assert.Equal(state.EstimatedBytes, owner.GetStatistics().EstimatedRetainedBytes);
        retained.Dispose();
        Assert.Equal(0, owner.GetStatistics().EstimatedRetainedBytes);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void ReplacementPathsPreserveCanonicalAnchorOrderingAndRefreshSnippets(int path)
    {
        var session = Session();
        using var owner = Create(session);
        var anchor = Anchor(session) with { Title = "message", Summary = "", Topics = [] };
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0, new PutAnchor(anchor)).Status);
        using var before = owner.OpenRead(Id(1));
        var previousHits = before.Search("message", 10);
        const string text = "topic0 MESSAGE message";
        var replacement = new ReplaceEntry(Id(1000), new TextContent(text));
        ImmutableArray<ContextChange> changes = path switch
        {
            1 => [new ReplaceEntry(Id(1000), new TextContent("message temporary")), replacement],
            2 => [new ReplaceSegment(0, session.Segments[0].Entries.SetItem(0,
                session.Segments[0].Entries[0] with { Content = replacement.Content }))],
            _ => [replacement]
        };
        Assert.Equal(ContextMutationStatus.Applied, owner.Apply(new(Id(1), 1, changes)).Status);
        using var after = owner.OpenRead(Id(1));
        var hits = after.Search("message", 10);
        Assert.Equal(previousHits.Select(hit => (hit.EntryId, hit.AnchorId, hit.Sequence)),
            hits.Select(hit => (hit.EntryId, hit.AnchorId, hit.Sequence)));
        Assert.Equal(5, hits.Length);
        Assert.Equal(text, hits[0].Snippet);
        Assert.All(hits, hit => Assert.Equal(2, hit.SessionRevision));
        Assert.Empty(after.Search("temporary", 10));
        Assert.Single(after.Search("topic0", 10));
        owner.Dispose();
        Assert.Equal<ContextSearchHit>(previousHits, before.Search("message", 10));
        Assert.Equal<ContextSearchHit>(hits, after.Search("message", 10));
    }

    [Fact]
    public void PointMutationSharesUnrelatedSegmentsAndSessionRoots()
    {
        var input = Session();
        using var owner = Create(input);
        Assert.Equal(ContextMutationStatus.Applied, owner.CreateSession(Session(2)).Status);
        Assert.True(owner.TryFind(Id(2), out var unrelated));
        using var before = owner.OpenRead(input.SessionId);
        var outcome = Change(owner, 0, new ReplaceEntry(Id(1000), new TextContent("replacement")));
        Assert.Equal(ContextMutationStatus.Applied, outcome.Status);
        Assert.True(owner.TryFind(input.SessionId, out var current));
        Assert.NotSame(input.Segments[0], current.Segments[0]);
        Assert.Same(input.Segments[1], current.Segments[1]);
        Assert.True(owner.TryFind(Id(2), out var stillUnrelated));
        Assert.Same(unrelated, stillUnrelated);
        Assert.Equal("message topic0", ((TextContent)before.ReadRange(0, 1)[0].Content).Text);
        Assert.Equal(1, owner.GetStatistics().SegmentsRewritten);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(4)]
    public void AppendCrossesBoundariesAndAssignsUniqueIncreasingSequences(int initial)
    {
        using var owner = Create(Session(count: initial));
        var draft = new ContextEntryDraft(Id(9000), ContextRole.Assistant, Now, new TextContent("new tail"));
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0, new AppendEntries([draft])).Status);
        using var read = owner.OpenRead(Id(1));
        var entries = read.ReadRange(0, 100);
        Assert.Equal(initial + 1, entries.Length);
        Assert.Equal(Enumerable.Range(0, initial + 1).Select(value => (long)value), entries.Select(entry => entry.Sequence));
        Assert.All(read.Session.Segments.Values, segment => Assert.InRange(segment.Entries.Length, 0, 2));
        Assert.Equal(Id(9000), entries[^1].EntryId);
    }

    [Fact]
    public void InvalidBatchRollsBackDataAndIndexesAndValidBatchCommitsOneRevision()
    {
        using var owner = Create(Session());
        var failed = Change(owner, 0, new ReplaceEntry(Id(1000), new TextContent("freshword")),
            new DeleteEntry(Id(9999)));
        Assert.Equal(ContextMutationStatus.InvalidOperation, failed.Status);
        using (var read = owner.OpenRead(Id(1)))
        {
            Assert.Empty(read.Search("freshword", 10));
            Assert.Single(read.Search("topic0", 10));
            Assert.Equal(0, read.Session.Revision);
        }
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0,
            new ReplaceEntry(Id(1000), new TextContent("freshword")),
            new ReplaceEntry(Id(1003), new TextContent("freshword"))).Status);
        using var next = owner.OpenRead(Id(1));
        Assert.Equal(1, next.Session.Revision);
        Assert.Equal(2, next.Search("freshword", 10).Length);
    }

    [Fact]
    public void ReplacementBatchRebuildsEachTouchedSegmentOnceAndPreservesRetainedIndexes()
    {
        using var owner = Create(Session(count: 6));
        using var before = owner.OpenRead(Id(1));
        var statistics = owner.GetStatistics();
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0,
            new ReplaceEntry(Id(1000), new TextContent("intermediate")),
            new ReplaceEntry(Id(1002), new TextContent("othersegment")),
            new ReplaceEntry(Id(1000), new TextContent("finalword")),
            new ReplaceEntry(Id(1001), new TextContent("neighbor"))).Status);
        using var after = owner.OpenRead(Id(1));
        Assert.Equal(1, after.Session.Revision);
        Assert.Equal(statistics.PublishedMutations + 1, owner.GetStatistics().PublishedMutations);
        Assert.Equal(statistics.SegmentsRewritten + 2, owner.GetStatistics().SegmentsRewritten);
        Assert.Same(before.Session.Segments[2], after.Session.Segments[2]);
        Assert.Same(before.Session.Segments[1].Entries[1], after.Session.Segments[1].Entries[1]);
        Assert.Equal(before.ReadRange(0, 6).Select(entry => (entry.EntryId, entry.Sequence)),
            after.ReadRange(0, 6).Select(entry => (entry.EntryId, entry.Sequence)));
        Assert.Empty(after.Search("intermediate", 10));
        Assert.Single(after.Search("finalword", 10));
        Assert.Single(after.Search("othersegment", 10));
        Assert.Single(after.Search("neighbor", 10));
        Assert.Empty(after.Search("topic0", 10));
        Assert.Single(before.Search("topic0", 10));
        Assert.Empty(before.Search("finalword", 10));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    public void ReplacementBatchCannotHideInvalidIntermediateEdits(int failure)
    {
        using var owner = Create(Session(), Options with
        {
            MaximumEstimatedBytesPerSegment = 1024,
            EntrySizeEstimator = entry => entry.Content is TextContent { Text: "badestimate" }
                ? 0 : ContextPolicies.EstimateEntryBytes(entry)
        });
        var statistics = owner.GetStatistics();
        ContextContent invalid = failure switch
        {
            0 => new ToolCallContent("call", "lookup", "{}"),
            1 => new TextContent(null!),
            2 => new TextContent(new string('x', 2048)),
            4 => new TextContent("badestimate"),
            _ => new TextContent("missing")
        };
        Assert.Equal(ContextMutationStatus.InvalidOperation, Change(owner, 0,
            new ReplaceEntry(Id(1000), new TextContent("tentative")),
            new ReplaceEntry(Id(failure == 3 ? 9999 : 1001), invalid),
            new ReplaceEntry(Id(1001), new TextContent("validagain"))).Status);
        Assert.Equal(statistics, owner.GetStatistics());
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(0, read.Session.Revision);
        Assert.Empty(read.Search("tentative", 10));
        Assert.Empty(read.Search("validagain", 10));
        Assert.Single(read.Search("topic0", 10));
        Assert.Single(read.Search("topic1", 10));
    }

    [Fact]
    public void ReplacementBatchPreservesOrderedEstimatorCallsForRepeatedEntry()
    {
        var observed = new List<string>();
        bool admitted = false;
        using var owner = Create(Session(), Options with
        {
            EntrySizeEstimator = entry =>
            {
                if (admitted) observed.Add(((TextContent)entry.Content).Text);
                return ContextPolicies.EstimateEntryBytes(entry);
            }
        });
        admitted = true;
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0,
            new ReplaceEntry(Id(1000), new TextContent("first")),
            new ReplaceEntry(Id(1000), new TextContent("last"))).Status);
        Assert.Equal(new[] { "first", "message topic0", "last", "first" }, observed);
        Assert.Equal(1, owner.GetStatistics().SegmentsRewritten);
        using var read = owner.OpenRead(Id(1));
        Assert.Single(read.Search("last", 10));
        Assert.Empty(read.Search("first", 10));
    }

    [Fact]
    public void SegmentReplacementPreservesAddressesAndRejectsMembershipChanges()
    {
        var session = Session();
        using var owner = Create(session);
        var entries = session.Segments[0].Entries.Select(entry => entry with { Content = new TextContent("range changed") }).ToImmutableArray();
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0, new ReplaceSegment(0, entries)).Status);
        Assert.Equal(ContextMutationStatus.InvalidOperation, Change(owner, 1,
            new ReplaceSegment(0, entries.SetItem(0, entries[0] with { EntryId = Id(9000) }))).Status);
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(2, read.Search("changed", 10).Length);
        Assert.True(read.TryFindEntry(Id(1000), out _));
    }

    [Fact]
    public async Task WritersWithOneExpectedRevisionCannotLoseEachOthersChanges()
    {
        using var owner = Create(Session());
        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(i => Task.Run(() =>
            Change(owner, 0, new ReplaceEntry(Id(1000), new TextContent($"writer{i}"))))));
        Assert.Single(results, result => result.Status == ContextMutationStatus.Applied);
        Assert.All(results.Where(result => result.Status != ContextMutationStatus.Applied),
            result => Assert.Equal(ContextMutationStatus.RevisionConflict, result.Status));
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(1, read.Session.Revision);
    }

    [Fact]
    public async Task IndependentSessionsProgressWhileReadersKeepCoherentRevisions()
    {
        using var owner = Create(Session());
        for (int i = 2; i <= 4; i++) Assert.Equal(ContextMutationStatus.Applied, owner.CreateSession(Session(i)).Status);
        using var retained = owner.OpenRead(Id(1));
        await Task.WhenAll(Enumerable.Range(1, 4).Select(id => Task.Run(() =>
        {
            for (int revision = 0; revision < 20; revision++)
            {
                var result = owner.Apply(new(Id(id), revision,
                    [new ReplaceEntry(Id(1000 * id), new TextContent($"version{revision + 1}"))]));
                Assert.Equal(ContextMutationStatus.Applied, result.Status);
                using var read = owner.OpenRead(Id(id));
                Assert.Equal(revision + 1, read.Session.Revision);
                Assert.Single(read.Search($"version{revision + 1}", 10));
            }
        })));
        Assert.Equal(0, retained.Session.Revision);
        Assert.Single(retained.Search("topic0", 10));
    }

    [Fact]
    public void CursorsStayOnTheirCapturedRevision()
    {
        using var owner = Create(Session());
        using var old = owner.OpenRead(Id(1));
        var page = old.ReadPage(null, 2);
        Assert.NotNull(page.Next);
        Assert.Equal(2, old.ReadPage(page.Next, 2).Entries.Length);
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0, new DeleteEntry(Id(1000))).Status);
        using var current = owner.OpenRead(Id(1));
        Assert.Throws<ArgumentException>(() => current.ReadPage(page.Next, 2));
        Assert.Equal(3, current.ReadRange(0, 10).Length);
        Assert.Equal(4, old.ReadRange(0, 10).Length);
    }

    [Fact]
    public void AnchorsAndKeywordSearchUseStableAddressesAndReportMissingTargets()
    {
        var session = Session();
        using var owner = Create(session);
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0, new PutAnchor(Anchor(session))).Status);
        using (var read = owner.OpenRead(Id(1)))
        {
            var hit = Assert.Single(read.Search("policy", 10));
            Assert.Equal(Id(500), hit.AnchorId);
            Assert.Equal(Id(1000), hit.EntryId);
        }
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 1, new DeleteEntry(Id(1000))).Status);
        using var next = owner.OpenRead(Id(1));
        Assert.Equal(AnchorTargetStatus.Partial, next.ResolveAnchor(Id(500)).Status);
        Assert.Empty(next.Search("policy", 10));
        Assert.Equal(Id(1001), next.ReadRange(0, 1)[0].EntryId);
    }

    [Fact]
    public void PinnedRevisionDoesNotPretendToRetainHistory()
    {
        var session = Session();
        using var owner = Create(session);
        var anchor = Anchor(session) with { PinnedRevision = 0 };
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0, new PutAnchor(anchor)).Status);
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(AnchorTargetStatus.HistoryUnavailable, read.ResolveAnchor(anchor.AnchorId).Status);
    }

    [Fact]
    public void RepositoryAndSessionMemoryHaveIndependentApplicabilityAndCapturedExpiry()
    {
        var clock = new TestClock(Now);
        var first = Session();
        var second = Session(2) with { Anchors = ImmutableDictionary<Guid, ConversationAnchor>.Empty };
        using var owner = Create(first, Options with { TimeProvider = clock });
        Assert.Equal(ContextMutationStatus.Applied, owner.CreateSession(second).Status);
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0, new PutAnchor(Anchor(first))).Status);
        var source = ImmutableArray.Create(new MemorySource(Id(1), Id(500)));
        var repo = new ContextMemory(Id(600), new(RepositoryId: Repository), "Repository guideline", 0,
            MemoryStatus.Confirmed, Now.AddMinutes(1), source);
        var local = repo with { MemoryId = Id(601), Scope = new(SessionId: Id(1)), Content = "Session constraint" };
        var combined = repo with { MemoryId = Id(602), Scope = new(User, Repository), Content = "Combined constraint" };
        var proposed = repo with { MemoryId = Id(603), Status = MemoryStatus.Proposed };
        Assert.Equal(ContextMutationStatus.Applied, owner.ApplyMemory(new(0, [repo, local, combined, proposed], [])).Status);
        using var captured = owner.OpenRead(Id(1));
        Assert.Equal(3, captured.GetApplicableMemory([repo.Scope, local.Scope, combined.Scope]).Length);
        using (var other = owner.OpenRead(Id(2)))
        {
            Assert.Single(other.GetApplicableMemory([repo.Scope]));
            Assert.Throws<ArgumentException>(() => other.GetApplicableMemory([local.Scope]));
        }
        clock.Now = Now.AddMinutes(2);
        Assert.Equal(3, captured.GetApplicableMemory([repo.Scope, local.Scope, combined.Scope]).Length);
        using var expired = owner.OpenRead(Id(1));
        Assert.Empty(expired.GetApplicableMemory([repo.Scope, local.Scope, combined.Scope]));
    }

    [Fact]
    public void ConfirmationRequiresProvenanceAndMemoryChangesAreAtomic()
    {
        using var owner = Create(Session());
        var invalid = new ContextMemory(Id(600), new(RepositoryId: Repository), "Guideline", 0,
            MemoryStatus.Confirmed, null, []);
        Assert.Equal(ContextMutationStatus.InvalidOperation, owner.ApplyMemory(new(0, [invalid], [])).Status);
        Assert.Equal(0, owner.GetStatistics().MemoryRevision);
        Assert.Equal(ContextMutationStatus.Applied, owner.ApplyMemory(new(0, [invalid with { Status = MemoryStatus.Proposed }], [])).Status);
        Assert.Equal(ContextMutationStatus.RevisionConflict, owner.ApplyMemory(new(0, [], [Id(600)])).Status);
    }

    [Fact]
    public void RetentionAdmissionAndViewFailureReleaseAccounting()
    {
        using var owner = Create(Session(), Options with { MaximumRetainedReads = 1, AdmissionTimeout = TimeSpan.Zero });
        using (var read = owner.OpenRead(Id(1)))
        {
            Assert.Throws<InvalidOperationException>(() => owner.OpenRead(Id(1)));
            Assert.Equal(1, owner.GetStatistics().RetainedReads);
        }
        Assert.Equal(0, owner.GetStatistics().RetainedReads);
        Assert.Throws<InvalidOperationException>(() => owner.OpenView(ContextViews.Project<string>(
            Id(1), _ => true, _ => throw new InvalidOperationException("projection failed"))));
        Assert.Equal(0, owner.GetStatistics().RetainedReads);
        Assert.Equal(0, owner.GetStatistics().EstimatedRetainedBytes);
    }

    [Fact]
    public void ClosedAndExpiredSessionsEnforceLifecycleAndRetainedReadsSurviveDisposal()
    {
        var owner = Create(Session());
        using var read = owner.OpenRead(Id(1));
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 0, new SetSessionStatus(SessionStatus.Closed)).Status);
        Assert.Equal(ContextMutationStatus.InvalidOperation, Change(owner, 1, new DeleteEntry(Id(1000))).Status);
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 1, new SetSessionStatus(SessionStatus.Active)).Status);
        Assert.Equal(ContextMutationStatus.Applied, Change(owner, 2, new SetSessionStatus(SessionStatus.Expired)).Status);
        Assert.Throws<InvalidOperationException>(() => owner.OpenRead(Id(1)));
        owner.Dispose();
        owner.Dispose();
        Assert.Equal(4, read.ReadRange(0, 10).Length);
        Assert.Throws<ObjectDisposedException>(() => owner.OpenRead(Id(1)));
        read.Dispose();
        Assert.Throws<ObjectDisposedException>(() => read.ReadRange(0, 1));
    }

    [Fact]
    public void OversizedAndUnsupportedPayloadsDoNotPartiallyMutateSession()
    {
        using var owner = Create(Session(), Options with { MaximumEstimatedBytesPerSegment = 1024 });
        Assert.Equal(ContextMutationStatus.InvalidOperation,
            Change(owner, 0, new ReplaceEntry(Id(1000), new TextContent(new string('x', 2048)))).Status);
        Assert.Equal(ContextMutationStatus.InvalidOperation,
            Change(owner, 0, new ReplaceEntry(Id(1000), new MutableContent())).Status);
        Assert.True(owner.TryFind(Id(1), out var current));
        Assert.Equal(0, current.Revision);
    }

    [Fact]
    public void FactoryRejectsMismatchedSelectorsAndDuplicateSessionIds()
    {
        Assert.Throws<ArgumentException>(() => LLMContextFactory.Create(sessionIdSelector: session => session.UserId).Initialize([Session()]));
        Assert.Throws<ArgumentException>(() => LLMContextFactory.Create().Initialize([Session(), Session()]));
    }

    private sealed record MutableContent : ContextContent
    {
        public List<string> Values { get; } = [];
    }

    private sealed class TestClock(DateTimeOffset now) : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
