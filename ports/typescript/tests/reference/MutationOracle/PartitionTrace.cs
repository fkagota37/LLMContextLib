// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text.Json;
using LLMContextLib;

internal static class PartitionTrace
{
    internal static async Task Run(bool writeOptimized)
    {
        Guid session = Id(1), first = Id(3), second = Id(4);
        var builder = writeOptimized ? LLMContextFactory.Create(LLMContextOptions.WriteOptimized) :
            LLMContextFactory.Create().WithPartitionedIndexing(new()
            {
                MaximumWorkingSetEntries = 2,
            });
        using var owner = builder.Initialize([new LLMSessionContext(
            session, Id(2), null, 0, SessionStatus.Active,
            ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, new(0, 0, [Entry(first, 0), Entry(second, 1)])),
            ImmutableDictionary<Guid, ConversationAnchor>.Empty)]);
        using var original = owner.OpenRead(session);
        Trace("original", original);
        var replace = owner.Apply(new(session, 0, [new ReplaceEntry(first, new TextContent("override"))
        {
            IndexKeys = new(["override"]),
        }]));
        using var working = owner.OpenRead(session);
        Trace("working", working, replace.Status.ToString());
        var synchronize = await owner.SynchronizeIndexAsync(session);
        using (var compacted = owner.OpenRead(session)) Trace("compacted", compacted, synchronization: synchronize);
        Trace("old-base", original);
        Trace("old-working", working);
        var delete = owner.Apply(new(session, 1, [new DeleteEntry(first), new DeleteEntry(second)]));
        using (var empty = owner.OpenRead(session)) Trace("drop", empty, delete.Status.ToString());
        working.Dispose();
        original.Dispose();
        using (var released = owner.OpenRead(session)) Trace("released", released);

        void Trace(string label, ILLMContextReadLease read, string? status = null, ContextIndexSynchronization? synchronization = null)
        {
            var stats = owner.GetStatistics();
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                label, status, synchronization,
                revision = read.Session.Revision, generation = read.IndexStatus.IndexGeneration,
                shared = read.SearchKeys(new(["base"]), 8).Select(hit => hit.EntryId),
                working = read.SearchKeys(new(["override"]), 8).Select(hit => hit.EntryId),
                mixed = read.SearchKeys(new(["base", "override"]), 8).Select(hit => hit.EntryId),
                active = stats.EstimatedActiveBytes, retained = stats.EstimatedRetainedBytes,
                recovery = stats.EstimatedSynchronizationReserveBytes,
            }));
        }
    }

    internal static async Task RunMixed()
    {
        Guid session = Id(1), old = Id(3), appended = Id(4), discarded = Id(5), anchor = Id(6);
        using var owner = LLMContextFactory.Create(LLMContextOptions.WriteOptimized).Initialize([new LLMSessionContext(
            session, Id(2), null, 0, SessionStatus.Active,
            ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, new(0, 0, [Entry(old, 0)])),
            ImmutableDictionary<Guid, ConversationAnchor>.Empty)]);
        using var original = owner.OpenRead(session);
        var rollback = owner.Apply(new(session, 0, [new DeleteEntry(old), Replace(old)]));
        using (var read = owner.OpenRead(session)) Trace("rollback", read, rollback);
        var mixed = owner.Apply(new(session, 0, [new DeleteEntry(old), new AppendEntries([Draft(appended), Draft(discarded)]),
            Replace(appended), new DeleteEntry(discarded), new PutAnchor(
                new(anchor, appended, appended, "retained", "", [], AnchorKind.Manual, 1, null) { IndexKeys = new(["anchor"]) })]));
        using (var read = owner.OpenRead(session)) Trace("mixed", read, mixed);
        var synchronization = await owner.SynchronizeIndexAsync(session);
        using (var read = owner.OpenRead(session)) Trace("compacted", read, synchronization: synchronization);
        Trace("original", original);
        var tombstone = owner.Apply(new(session, 1, [new AppendEntries([Draft(discarded)])]));
        using (var read = owner.OpenRead(session)) Trace("tombstone", read, tombstone);

        static ReplaceEntry Replace(Guid id) => new(id, new TextContent("final")) { IndexKeys = new(["final"]) };
        static ContextEntryDraft Draft(Guid id) =>
            new(id, ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent("temporary")) { IndexKeys = new(["temporary"]) };

        void Trace(string label, ILLMContextReadLease read, IContextMutationResult? result = null, ContextIndexSynchronization? synchronization = null)
        {
            var stats = owner.GetStatistics();
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                label, status = result?.Status.ToString(), appended = result?.AppendedEntryIds, synchronization,
                revision = read.Session.Revision, generation = read.IndexStatus.IndexGeneration,
                entries = read.ReadRange(0, 8).Select(entry => new { entry.EntryId, entry.Sequence, ((TextContent)entry.Content).Text }),
                hits = new[] { "base", "temporary", "final" }.Select(key => read.SearchKeys(new([key]), 8).Select(hit => hit.EntryId)),
                anchors = read.Session.Anchors.Values.Select(value => new { value.AnchorId, value.StartEntryId, value.EndEntryId, value.Title }),
                active = stats.EstimatedActiveBytes, retained = stats.EstimatedRetainedBytes, preparation = stats.EstimatedPreparationBytes,
                rewrites = stats.SegmentsRewritten, rewrittenBytes = stats.EstimatedSegmentBytesRewritten,
            }));
        }
    }

    private static ContextEntry Entry(Guid id, long index) =>
        new(id, index, ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent("base")) { IndexKeys = new(["base"]) };

    private static Guid Id(int value) => new($"00000000-0000-0000-0000-{value:000000000000}");
}
