// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;

namespace LLMContextLib;

// Private derived addresses are meaningful only within their containing ContextState.
// Public mutations/navigation use canonical IDs, never these physical offsets.
internal readonly record struct EntryLocation(long SegmentId, int Offset);
// Sequence order survives deletions without renumbering; list positions do not.
internal readonly record struct EntryOrder(long Sequence, Guid EntryId);
// Anchor descriptions and entry content index separately even when sharing a start entry.
internal readonly record struct SearchAddress(Guid EntryId, Guid? AnchorId);

/// <summary>
/// The immutable publication unit. No index is independently published: an entry location and
/// the segment it addresses always belong to this same state. .NET ImmutableDictionary uses a
/// balanced tree of hash buckets, NOT a hash-array mapped trie: normal lookup/update is O(log N),
/// and collision buckets can add linear work. String hashing also pays for key length.
/// The segment directory is an AVL tree; the order directory is a persistent indexed list.
/// A point mutation path-copies bounded segment content and tree paths, never all entries.
/// EntryTerms retains the lexical result for each live entry in THIS generation. It is
/// owner-private derived state, not a process-wide cache or a history of every edited payload.
/// Publishing it with Search lets replacements/deletions reuse the old terms without
/// tokenizing the old content again. Captured roots retain their matching term directory.
/// </summary>
internal sealed record ContextState(
    LLMSessionContext Session,
    ImmutableDictionary<Guid, EntryLocation> Locations,
    ImmutableHashSet<Guid> SeenEntryIds,
    ImmutableList<EntryOrder> Order,
    ImmutableDictionary<string, ImmutableHashSet<SearchAddress>> Search,
    ImmutableDictionary<Guid, ImmutableArray<string>> EntryTerms,
    ImmutableDictionary<long, long> SegmentBytes,
    long EstimatedBytes,
    long NextSequence,
    long NextSegmentId)
{
    internal ImmutableDictionary<long, ContextIndexPartition> IndexPartitions { get; init; } =
        ImmutableDictionary<long, ContextIndexPartition>.Empty;
    internal ImmutableDictionary<Guid, long> EntryTermBytes { get; init; } =
        ImmutableDictionary<Guid, long>.Empty;
    internal ImmutableDictionary<Guid, PendingEntryIndex> PendingIndexes { get; init; } =
        ImmutableDictionary<Guid, PendingEntryIndex>.Empty;
    internal long IndexGeneration { get; init; }

    internal ContextIndexStatus IndexStatus
    {
        get
        {
            int failed = 0;
            string? error = null;
            foreach (var pending in PendingIndexes.Values)
                if (pending.Error is not null) { failed++; error ??= pending.Error; }
            return new(Session.Revision, IndexGeneration, PendingIndexes.Count, failed, error);
        }
    }
}

/// <summary>
/// A private transaction builder. Intermediate states are unreachable by readers. A point update
/// copies/compares B references but estimates/tokenizes ONLY changed payloads. Reference identity
/// is a safe fast path because admitted entry graphs are immutable. Deletion can additionally
/// shift B location offsets. Replacement-only batches copy each touched segment once; mixed
/// transactions retain the sequential path. Replacements tokenize only the new payload and
/// reuse the old entry's retained terms; unchanged memberships and equivalent term arrays
/// remain shared. This is separate from segment-array coalescing.
/// </summary>
internal sealed class ContextStateBuilder
{
    private readonly LLMContextOptions _options;
    private readonly ContextExecution? _execution;
    private readonly bool _initializing;
    private long? _editingSegment;
    private bool _droppingPartition;
    internal ContextState State { get; private set; }
    internal long SegmentsRewritten { get; private set; }
    internal long BytesRewritten { get; private set; }
    internal ImmutableArray<Guid>.Builder Appended { get; } = ImmutableArray.CreateBuilder<Guid>();

    internal ContextStateBuilder(ContextState state, LLMContextOptions options, bool initializing = false,
        ContextExecution? execution = null)
        => (State, _options, _initializing, _execution) = (state, options, initializing, execution);

    /// <summary>
    /// Rebuild trusted derived state from an imported immutable graph. Unlike a point mutation,
    /// initialization walks every entry and anchor, validates global ordering, reconstructs
    /// search/location/tombstone metadata, and derives future sequence/segment counters.
    /// No portion is visible until the owner admits the completed root.
    /// </summary>
    internal static ContextState Initialize(LLMSessionContext session, LLMContextOptions options,
        ContextExecution? execution = null)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (session.SessionId == Guid.Empty || session.UserId == Guid.Empty ||
            session.RepositoryId == Guid.Empty || session.Revision < 0 || !Enum.IsDefined(session.Status) ||
            session.Segments is null || session.Anchors is null)
            throw new ArgumentException("Session identity, revision and collections must be valid.");
        var empty = session with
        {
            Segments = ImmutableSortedDictionary<long, ContextSegment>.Empty,
            Anchors = ImmutableDictionary<Guid, ConversationAnchor>.Empty
        };
        // Charge the term-directory reference plus the pending-directory reference and index
        // generation, even before entries add their directory/array/string/reservation charges.
        var initial = new ContextState(empty, ImmutableDictionary<Guid, EntryLocation>.Empty,
            ImmutableHashSet<Guid>.Empty, ImmutableList<EntryOrder>.Empty,
            ImmutableDictionary.Create<string, ImmutableHashSet<SearchAddress>>(StringComparer.Ordinal),
            ImmutableDictionary<Guid, ImmutableArray<string>>.Empty,
            ImmutableDictionary<long, long>.Empty, 256 + 8 + 16 + (options.PartitionedIndex is null ? 0 : 16), 0, 0);
        var builder = new ContextStateBuilder(initial, options, initializing: true, execution: execution);
        long previousSequence = -1;
        foreach (var (id, segment) in session.Segments)
        {
            if (id < 0 || segment is null || segment.SegmentId != id ||
                segment.Revision < 0 || segment.Revision > session.Revision)
                throw new ArgumentException("Segment metadata does not match its directory.");
            builder.ReplaceSegment(segment, existing: false);
            foreach (var entry in segment.Entries)
            {
                if (entry.Sequence <= previousSequence)
                    throw new ArgumentException("Sequences must increase across all segments.");
                previousSequence = entry.Sequence;
            }
        }
        foreach (var (id, anchor) in session.Anchors)
        {
            if (anchor is null || id != anchor.AnchorId || anchor.SourceRevision > session.Revision ||
                anchor.PinnedRevision > session.Revision)
                throw new ArgumentException("Anchor identity/revision mismatch.");
            builder.PutAnchor(anchor);
        }
        return builder.State with
        {
            NextSequence = checked(previousSequence + 1),
            NextSegmentId = session.Segments.Count == 0 ? 0 : checked(session.Segments.Last().Key + 1)
        };
    }

    internal void ApplyChanges(ImmutableArray<ContextChange> changes, long revision)
    {
        // Restrict buffering to membership-preserving batches. Appends/deletes, explicit
        // segment replacements, anchors and status changes keep their existing ordering and
        // validation path; a single point replacement avoids dictionary/builder overhead.
        if (changes.Length > 1 && changes.All(change => change is ReplaceEntry))
            ApplyReplacements(changes, revision);
        else
            foreach (var change in changes) Apply(change, revision);
    }

    /// <summary>
    /// K replacements touching D segments copy sum(Bd) entry references instead of one
    /// B-entry array per command. Normal work is O(K * H(N) + sum(Bd) + D * log S + I + E):
    /// H(N) is immutable location lookup, I the unchanged per-command lexical/index work,
    /// E the caller's estimator work. Expected dictionary probes add O(K); collision chains
    /// can degrade them. Temporary non-index storage is O(sum(Bd) + D + K), including K
    /// replacement records. No session-wide array, location map or order list is rebuilt.
    /// </summary>
    private void ApplyReplacements(ImmutableArray<ContextChange> changes, long revision)
    {
        if (State.Session.Status != SessionStatus.Active)
            throw new ArgumentException("Only active sessions accept content changes.");
        var pending = new Dictionary<long, (ImmutableArray<ContextEntry>.Builder Entries, long Bytes)>();
        foreach (ReplaceEntry change in changes)
        {
            var location = Locate(change.EntryId);
            if (!pending.TryGetValue(location.SegmentId, out var buffer))
                buffer = (State.Session.Segments[location.SegmentId].Entries.ToBuilder(),
                    State.SegmentBytes[location.SegmentId]);
            var old = buffer.Entries[location.Offset];
            var replacement = old with { Content = change.Content, IndexKeys = change.IndexKeys };

            // Validate EVERY intermediate edit in caller order, including overwritten edits.
            // Preserve new/old estimator call order and check each intermediate segment size:
            // invalid or oversized content cannot become legal through a later replacement.
            ValidateEntry(replacement);
            long size = checked(buffer.Bytes + EntryBytes(replacement) - EntryBytes(old));
            if (size > _options.MaximumEstimatedBytesPerSegment)
                throw new ArgumentException("Segment byte limit exceeded.");
            if (IndexChanged(old, replacement))
            {
                ReplaceEntryIndex(old.EntryId, replacement.Content, replacement.IndexKeys);
            }
            State = State with { EstimatedBytes = checked(State.EstimatedBytes + size - buffer.Bytes) };
            buffer.Entries[location.Offset] = replacement;
            pending[location.SegmentId] = (buffer.Entries, size);
        }

        // Indexes above and buffers are private until the owner publishes the complete state.
        // Membership/offsets never change, so Locations, SeenEntryIds and Order remain shared.
        // ToBuilder has exact capacity; MoveToImmutable transfers that private array without
        // a second reference copy and empties the builder, preventing later mutable aliases.
        foreach (var (id, buffer) in pending)
        {
            var segment = State.Session.Segments[id] with
            {
                Revision = revision,
                Entries = buffer.Entries.MoveToImmutable()
            };
            State = State with
            {
                Session = State.Session with { Segments = State.Session.Segments.SetItem(id, segment) },
                SegmentBytes = State.SegmentBytes.SetItem(id, buffer.Bytes)
            };
            SegmentsRewritten++;
            BytesRewritten = checked(BytesRewritten + buffer.Bytes);
        }
    }

    private void Apply(ContextChange change, long revision)
    {
        // Commands see earlier commands in this same private transaction. This permits appending
        // a conclusion then anchoring it, or activating a session before changing its content.
        // An exception anywhere abandons the builder rather than publishing a prefix.
        ArgumentNullException.ThrowIfNull(change);
        if (State.Session.Status != SessionStatus.Active && change is not SetSessionStatus)
            throw new ArgumentException("Only active sessions accept content changes.");
        switch (change)
        {
            case AppendEntries append:
                RequireInitialized(append.Entries);
                foreach (var draft in append.Entries) Append(draft, revision);
                break;
            case ReplaceEntry replace:
                var location = Locate(replace.EntryId);
                var segment = State.Session.Segments[location.SegmentId];
                var replacement = segment.Entries[location.Offset] with
                {
                    Content = replace.Content,
                    IndexKeys = replace.IndexKeys
                };
                ReplaceSegment(segment with
                {
                    Revision = revision,
                    Entries = segment.Entries.SetItem(location.Offset, replacement)
                }, existing: true);
                break;
            case DeleteEntry delete:
                location = Locate(delete.EntryId);
                segment = State.Session.Segments[location.SegmentId];
                long sequence = segment.Entries[location.Offset].Sequence;
                ReplaceSegment(segment with
                {
                    Revision = revision,
                    Entries = segment.Entries.RemoveAt(location.Offset)
                }, existing: true);
                // Remove order membership but preserve SeenEntryIds and the sequence counter.
                // Anchors deliberately remain: later reads report partial/missing endpoints.
                State = State with { Order = State.Order.RemoveAt(LowerBound(State.Order, sequence)) };
                break;
            case ReplaceSegment replace:
                if (!State.Session.Segments.TryGetValue(replace.SegmentId, out segment))
                    throw new ArgumentException("Unknown segment.");
                RequireInitialized(replace.Entries);
                if (segment.Entries.Length != replace.Entries.Length)
                    throw new ArgumentException("Segment replacement preserves membership; use append/delete for growth.");
                for (int i = 0; i < segment.Entries.Length; i++)
                    if (segment.Entries[i].EntryId != replace.Entries[i].EntryId ||
                        segment.Entries[i].Sequence != replace.Entries[i].Sequence)
                        throw new ArgumentException("Segment replacement cannot change identities or ordering.");
                ReplaceSegment(new ContextSegment(replace.SegmentId, revision, replace.Entries), existing: true);
                break;
            case PutAnchor put:
                PutAnchor(put.Anchor);
                break;
            case RemoveAnchor remove:
                if (!State.Session.Anchors.TryGetValue(remove.AnchorId, out var old))
                    throw new ArgumentException("Unknown anchor.");
                RemoveAnchorIndex(old);
                State = State with
                {
                    Session = State.Session with { Anchors = State.Session.Anchors.Remove(remove.AnchorId) },
                    EstimatedBytes = checked(State.EstimatedBytes - AnchorBytes(old))
                };
                break;
            case SetSessionStatus status:
                if (!Enum.IsDefined(status.Status) ||
                    (State.Session.Status == SessionStatus.Expired && status.Status != SessionStatus.Expired))
                    throw new ArgumentException("Expired sessions cannot be reopened.");
                State = State with { Session = State.Session with { Status = status.Status } };
                break;
            default:
                throw new ArgumentException("Unknown change type.");
        }
    }

    private void Append(ContextEntryDraft draft, long revision)
    {
        // This simple first realization appends one draft at a time. K drafts can therefore
        // copy/compare the same tail K times (O(K * Wsegment)), even within one atomic commit.
        // Coalescing the transaction's final tail is a documented optimization, not a hidden
        // assumption in benchmark interpretation. The tail lookup itself is O(log S).
        ArgumentNullException.ThrowIfNull(draft);
        var id = draft.EntryId == Guid.Empty ? Guid.NewGuid() : draft.EntryId;
        if (State.SeenEntryIds.Contains(id)) throw new ArgumentException("Entry identities cannot be reused after deletion.");
        var entry = new ContextEntry(id, State.NextSequence, draft.Role, draft.CreatedAt, draft.Content)
        {
            IndexKeys = draft.IndexKeys
        };
        ValidateEntry(entry);
        long bytes = EntryBytes(entry);
        ContextSegment? tail = State.NextSegmentId == 0 ? null : State.Session.Segments[State.NextSegmentId - 1];
        if (tail is not null && tail.Entries.Length < _options.MaximumEntriesPerSegment &&
            checked(State.SegmentBytes[tail.SegmentId] + bytes) <= _options.MaximumEstimatedBytesPerSegment &&
            CanAppendIndex(tail.SegmentId, entry.IndexKeys))
            ReplaceSegment(tail with { Revision = revision, Entries = tail.Entries.Add(entry) }, existing: true);
        else
        {
            var next = new ContextSegment(State.NextSegmentId, revision, [entry]);
            ReplaceSegment(next, existing: false);
            State = State with { NextSegmentId = checked(State.NextSegmentId + 1) };
        }
        State = State with
        {
            Order = State.Order.Add(new EntryOrder(entry.Sequence, entry.EntryId)),
            NextSequence = checked(State.NextSequence + 1)
        };
        Appended.Add(id);
    }

    private bool CanAppendIndex(long segment, ContextIndexKeys? keys)
    {
        if (_options.PartitionedIndex is not { } options ||
            !State.IndexPartitions.TryGetValue(segment, out var partition)) return true;
        long bytes = ContextIndexPartition.OverrideBytes(new(keys!.Keys, keys.EstimatedBytes));
        return partition.Overrides.Count < options.MaximumWorkingSetEntries &&
            checked(partition.WorkingSetBytes + bytes) <= options.MaximumEstimatedWorkingSetBytes &&
            checked(partition.EstimatedBytes + bytes) <= options.MaximumEstimatedPartitionBytes;
    }

    private void ReplaceSegment(ContextSegment segment, bool existing)
    {
        // Central physical rewrite path for initialization, append, delete, and single edits.
        // Compare entry identities/references first, then update only changed payload indexes.
        // Physical offset shifts after deletion still require location updates for survivors.
        RequireInitialized(segment.Entries);
        if (segment.Entries.Length > _options.MaximumEntriesPerSegment)
            throw new ArgumentException("Segment entry limit exceeded.");
        var previous = existing ? State.Session.Segments[segment.SegmentId] : null;
        long oldSize = existing ? State.SegmentBytes[segment.SegmentId] : 0;
        long size = oldSize;
        var unique = new HashSet<Guid>();
        var edits = new List<(ContextEntry? Old, ContextEntry? New)>();
        var locations = State.Locations;
        var seen = State.SeenEntryIds;
        long identityBytes = 0;
        for (int i = 0; i < segment.Entries.Length; i++)
        {
            var entry = segment.Entries[i];
            if (entry is null || !unique.Add(entry.EntryId))
                throw new ArgumentException("Duplicate entry identity.");
            ContextEntry? old = null;
            bool sameOffset = previous is not null && i < previous.Entries.Length &&
                previous.Entries[i].EntryId == entry.EntryId;
            if (sameOffset)
                old = previous!.Entries[i];
            else if (State.Locations.TryGetValue(entry.EntryId, out var location))
            {
                if (!existing || location.SegmentId != segment.SegmentId)
                    throw new ArgumentException("Duplicate entry identity.");
                old = previous!.Entries[location.Offset];
            }
            if (!ReferenceEquals(old, entry))
            {
                ValidateEntry(entry);
                size = checked(size + EntryBytes(entry) - (old is null ? 0 : EntryBytes(old)));
                edits.Add((old, entry));
            }
            if (!sameOffset) locations = locations.SetItem(entry.EntryId, new EntryLocation(segment.SegmentId, i));
            if (old is null)
            {
                // These reservations survive later deletion. Their estimated cost therefore
                // grows with identities ever admitted, not merely the current live entry count.
                seen = seen.Add(entry.EntryId);
                identityBytes += 48;
            }
        }
        if (previous is not null)
        {
            foreach (var entry in previous.Entries)
            {
                if (unique.Contains(entry.EntryId)) continue;
                locations = locations.Remove(entry.EntryId);
                size = checked(size - EntryBytes(entry));
                edits.Add((entry, null));
            }
        }
        if (size > _options.MaximumEstimatedBytesPerSegment)
            throw new ArgumentException("Segment byte limit exceeded.");

        // The size/identity pass above is bounded by B references. Re-reading unchanged text
        // here used to allocate/tokenize B payloads for a one-entry correction. The edit list
        // makes that work proportional to the changed payloads instead. Role/timestamp-only
        // replacements can retain postings when the immutable content object is unchanged.
        _editingSegment = segment.SegmentId;
        _droppingPartition = _options.PartitionedIndex is not null && segment.Entries.IsEmpty;
        foreach (var (old, entry) in edits)
        {
            if (old is not null && entry is not null && !IndexChanged(old, entry)) continue;
            if (old is not null && entry is not null)
                ReplaceEntryIndex(old.EntryId, entry.Content, entry.IndexKeys);
            else if (old is not null)
                RemoveEntryIndex(old.EntryId);
            else if (entry is not null)
                ReplaceEntryIndex(entry.EntryId, entry.Content, entry.IndexKeys);
        }
        _editingSegment = null;
        _droppingPartition = false;
        if (_options.PartitionedIndex is not null &&
            State.IndexPartitions.TryGetValue(segment.SegmentId, out var partition))
        {
            if (segment.Entries.IsEmpty)
                State = State with
                {
                    IndexPartitions = State.IndexPartitions.Remove(segment.SegmentId),
                    EstimatedBytes = checked(State.EstimatedBytes - partition.EstimatedBytes)
                };
            else if (_initializing)
            {
                var compacted = partition.Compact();
                if (compacted.EstimatedBytes > _options.PartitionedIndex.MaximumEstimatedPartitionBytes)
                    throw new ArgumentException("Imported entry index exceeds the partition byte limit.");
                StorePartition(segment.SegmentId, compacted);
            }
        }
        State = State with
        {
            Locations = locations,
            SeenEntryIds = seen,
            Session = State.Session with { Segments = State.Session.Segments.SetItem(segment.SegmentId, segment) },
            SegmentBytes = State.SegmentBytes.SetItem(segment.SegmentId, size),
            EstimatedBytes = checked(State.EstimatedBytes + size - oldSize + identityBytes + (existing ? 0 : 128))
        };
        // Initialization creates order metadata here; append adds exactly its new tail item.
        if (_initializing)
        {
            var order = State.Order;
            foreach (var entry in segment.Entries) order = order.Add(new EntryOrder(entry.Sequence, entry.EntryId));
            State = State with { Order = order };
        }
        SegmentsRewritten++;
        BytesRewritten = checked(BytesRewritten + size);
    }

    private EntryLocation Locate(Guid entryId) => State.Locations.TryGetValue(entryId, out var location)
        ? location : throw new ArgumentException("Unknown entry.");

    private static bool IndexChanged(ContextEntry old, ContextEntry current) =>
        !ReferenceEquals(old.Content, current.Content) || !ReferenceEquals(old.IndexKeys, current.IndexKeys);

    private void ValidateIndexKeys(ContextIndexKeys? keys)
    {
        if ((_options.IndexingMode == ContextIndexingMode.ProducerOwned) != (keys is not null))
            throw new ArgumentException("ProducerOwned mode requires explicit keys; Text mode does not accept supplied keys.");
    }

    private void PutAnchor(ConversationAnchor anchor)
    {
        // Resolve against the builder's current candidate, so endpoints appended earlier in
        // this transaction are already addressable. Updating a bookmark removes its old
        // address first, including when its start entry (and therefore search address) moves.
        ArgumentNullException.ThrowIfNull(anchor);
        ValidateIndexKeys(anchor.IndexKeys);
        if (anchor.AnchorId == Guid.Empty || string.IsNullOrWhiteSpace(anchor.Title) || anchor.Summary is null ||
            anchor.Topics.IsDefault || anchor.Topics.Any(topic => topic is null) || !Enum.IsDefined(anchor.Kind) ||
            anchor.SourceRevision < 0 || anchor.SourceRevision > checked(State.Session.Revision + 1) ||
            anchor.PinnedRevision is < 0 || anchor.PinnedRevision > checked(State.Session.Revision + 1))
            throw new ArgumentException("Invalid anchor metadata.");
        var start = Locate(anchor.StartEntryId);
        var end = Locate(anchor.EndEntryId);
        if (State.Session.Segments[start.SegmentId].Entries[start.Offset].Sequence >
            State.Session.Segments[end.SegmentId].Entries[end.Offset].Sequence)
            throw new ArgumentException("Anchor range is reversed.");
        long oldBytes = 0;
        if (State.Session.Anchors.TryGetValue(anchor.AnchorId, out var old))
        {
            RemoveAnchorIndex(old);
            oldBytes = AnchorBytes(old);
        }
        if (_options.IndexingMode == ContextIndexingMode.ProducerOwned)
            Index(new SearchAddress(anchor.StartEntryId, anchor.AnchorId), anchor.IndexKeys!.Keys, add: true);
        else
            Index(new SearchAddress(anchor.StartEntryId, anchor.AnchorId), AnchorText(anchor), add: true);
        State = State with
        {
            Session = State.Session with { Anchors = State.Session.Anchors.SetItem(anchor.AnchorId, anchor) },
            EstimatedBytes = checked(State.EstimatedBytes + AnchorBytes(anchor) - oldBytes)
        };
    }

    private void RemoveAnchorIndex(ConversationAnchor anchor)
    {
        if (_options.IndexingMode == ContextIndexingMode.ProducerOwned)
            Index(new SearchAddress(anchor.StartEntryId, anchor.AnchorId), anchor.IndexKeys!.Keys, add: false);
        else
            Index(new SearchAddress(anchor.StartEntryId, anchor.AnchorId), AnchorText(anchor), add: false);
    }

    /// <summary>
    /// Terms returns distinct ordinal-sorted arrays. Two linear exclusion passes
    /// cost O((Uold + Unew) * L) comparisons without another hash set; only D changed terms
    /// rewrite postings/dictionary paths. Tokenization and its O(C + U) storage remain.
    /// Remove all obsolete memberships before adding new ones, preserving the original
    /// decrease-before-increase checked accounting. The canonical entry address is unchanged;
    /// anchor relocation still uses its separate full remove/add path.
    /// </summary>
    private void ReplaceEntryIndex(Guid entryId, ContextContent content, ContextIndexKeys? keys)
    {
        if (_options.IndexingMode == ContextIndexingMode.ProducerOwned)
        {
            _execution?.RecordSuppliedEntry();
            SetEntryTerms(entryId, keys!.Keys, keys.EstimatedBytes);
            return;
        }
        bool existing = _execution is not null && State.EntryTerms.ContainsKey(entryId);
        RemovePendingIndex(entryId);
        if (_execution is not null || _options.DeferredIndexing is not null)
        {
            var prefix = _execution is not null ? _execution.PrepareEntry(content, existing) :
                ContextIndexTokenizer.Prefix(content, _options.DeferredIndexing!);
            SetEntryTerms(entryId, prefix.Terms);
            if (!prefix.Complete)
            {
                int characters = ContextIndexTokenizer.TextLength(content);
                var pending = new PendingEntryIndex(content, State.EntryTerms[entryId], prefix.ResumeOffset,
                    ContextIndexTokenizer.IndexReservation(characters), ContextIndexTokenizer.WorkReservation(characters));
                State = State with
                {
                    PendingIndexes = State.PendingIndexes.SetItem(entryId, pending),
                    EstimatedBytes = checked(State.EstimatedBytes + pending.ReservedIndexBytes)
                };
            }
        }
        else SetEntryTerms(entryId, ContextPolicies.Terms(ContextPolicies.Text(content)));
    }

    private void SetEntryTerms(Guid entryId, ImmutableArray<string> newTerms, long? preparedBytes = null)
    {
        bool existing = State.EntryTerms.TryGetValue(entryId, out var oldTerms);
        if (!existing) oldTerms = [];
        // Equivalent edits need neither a new retained array nor a path copy of this directory.
        // The freshly tokenized candidate becomes temporary garbage, not another cache version.
        if (existing && oldTerms.SequenceEqual(newTerms))
        {
            if (_options.IndexingMode == ContextIndexingMode.ProducerOwned && !oldTerms.Equals(newTerms))
                State = State with { EntryTerms = State.EntryTerms.SetItem(entryId, newTerms) };
            return;
        }
        var address = new SearchAddress(entryId, null);
        long newBytes = preparedBytes ?? EstimateEntryTermsBytes(newTerms);
        if (_options.PartitionedIndex is not null)
            OverrideEntry(entryId, new(newTerms, newBytes));
        else
        {
            Index(address, oldTerms, add: false, except: newTerms);
            Index(address, newTerms, add: true, except: oldTerms);
        }
        long delta = checked((preparedBytes ?? EstimateEntryTermsBytes(newTerms)) -
            (existing ? TermBytes(entryId, oldTerms) : 0));
        State = State with
        {
            EntryTerms = State.EntryTerms.SetItem(entryId, newTerms),
            EntryTermBytes = _options.PartitionedIndex is null ? State.EntryTermBytes :
                State.EntryTermBytes.SetItem(entryId, newBytes),
            EstimatedBytes = checked(State.EstimatedBytes + delta)
        };
    }

    private void RemoveEntryIndex(Guid entryId)
    {
        RemovePendingIndex(entryId);
        var terms = State.EntryTerms[entryId];
        long bytes = TermBytes(entryId, terms);
        if (_options.PartitionedIndex is not null)
        {
            if (!_droppingPartition) OverrideEntry(entryId, null);
        }
        else Index(new SearchAddress(entryId, null), terms, add: false);
        State = State with
        {
            EntryTerms = State.EntryTerms.Remove(entryId),
            EntryTermBytes = State.EntryTermBytes.Remove(entryId),
            EstimatedBytes = checked(State.EstimatedBytes - bytes)
        };
    }

    private long TermBytes(Guid id, ImmutableArray<string> terms) =>
        _options.PartitionedIndex is null ? EstimateEntryTermsBytes(terms) : State.EntryTermBytes[id];

    private void OverrideEntry(Guid id, PartitionContribution? value)
    {
        long segment = _editingSegment ?? Locate(id).SegmentId;
        var partition = State.IndexPartitions.GetValueOrDefault(segment) ?? ContextIndexPartition.Empty;
        ContextIndexPartition next;
        if (_initializing)
        {
            long oldBytes = partition.Overrides.TryGetValue(id, out var old)
                ? ContextIndexPartition.OverrideBytes(old) : 0;
            next = partition with
            {
                Overrides = partition.Overrides.SetItem(id, value),
                WorkingSetBytes = checked(partition.WorkingSetBytes - oldBytes +
                    ContextIndexPartition.OverrideBytes(value))
            };
        }
        else
        {
            try { next = partition.Override(id, value, _options.PartitionedIndex!); }
            catch (PartitionCapacityException error) { error.SegmentId = segment; throw; }
        }
        StorePartition(segment, next);
    }

    private void StorePartition(long segment, ContextIndexPartition partition)
    {
        long oldBytes = State.IndexPartitions.TryGetValue(segment, out var old) ? old.EstimatedBytes : 0;
        State = State with
        {
            IndexPartitions = State.IndexPartitions.SetItem(segment, partition),
            EstimatedBytes = checked(State.EstimatedBytes + partition.EstimatedBytes - oldBytes)
        };
    }

    private void RemovePendingIndex(Guid entryId)
    {
        if (!State.PendingIndexes.TryGetValue(entryId, out var pending)) return;
        State = State with
        {
            PendingIndexes = State.PendingIndexes.Remove(entryId),
            EstimatedBytes = checked(State.EstimatedBytes - pending.ReservedIndexBytes)
        };
    }

    internal bool CompleteEntryIndex(Guid entryId, PendingEntryIndex pending, ImmutableArray<string> terms)
    {
        if (!State.PendingIndexes.TryGetValue(entryId, out var current) || !ReferenceEquals(current, pending))
            return false;
        // Release before checked additions in this private builder, avoiding an artificial
        // double charge/overflow. Publication still exposes only the complete admitted root.
        RemovePendingIndex(entryId);
        SetEntryTerms(entryId, terms);
        return true;
    }

    internal void RebaseIndexProgress(ContextState captured, ContextState current)
    {
        // Only derived progress may merge. The storage fence separately requires the SAME
        // content root; a genuine concurrent content write still returns RevisionConflict.
        foreach (var (id, original) in captured.PendingIndexes)
        {
            if (!State.PendingIndexes.TryGetValue(id, out var candidate) || !ReferenceEquals(candidate, original))
                continue;
            if (!current.PendingIndexes.TryGetValue(id, out var pending))
                CompleteEntryIndex(id, original, current.EntryTerms[id]);
            else if (!ReferenceEquals(pending, original))
                State = State with { PendingIndexes = State.PendingIndexes.SetItem(id, pending) };
        }
    }

    /// <summary>
    /// Conservative admission estimate for one term-directory membership: 128 bytes for
    /// dictionary/array overhead, eight bytes per array reference, and 32 bytes plus two per
    /// UTF-16 character for each distinct term string. The root's extra directory reference
    /// is charged separately in Initialize. Empty entries still own a directory membership.
    /// This deliberately does not discount strings shared with Search or other revisions;
    /// it is not exact heap measurement. Segment payload limits remain payload-only, while
    /// resident and captured-root admission include this owner-private derived metadata.
    /// </summary>
    internal static long EstimateEntryTermsBytes(ImmutableArray<string> terms)
    {
        long bytes = checked(128L + 8L * terms.Length);
        foreach (string term in terms) bytes = checked(bytes + 32L + 2L * term.Length);
        return bytes;
    }

    private void Index(SearchAddress address, string text, bool add) =>
        Index(address, _execution?.Collect(text, CancellationToken.None) ?? ContextPolicies.Terms(text), add);

    private void Index(SearchAddress address, ImmutableArray<string> terms, bool add, ImmutableArray<string> except = default)
    {
        // Both term arrays are sorted/distinct. A forward-only exclusion cursor keeps shared
        // memberships untouched; an empty posting removes the term bucket and its estimated
        // overhead as well as the address charge. All updates remain private to this builder.
        var index = State.Search;
        long estimatedBytes = State.EstimatedBytes;
        if (except.IsDefault) except = [];
        int excluded = 0;
        foreach (var term in terms)
        {
            while (excluded < except.Length && string.CompareOrdinal(except[excluded], term) < 0) excluded++;
            if (excluded < except.Length && string.Equals(except[excluded], term, StringComparison.Ordinal)) continue;
            bool hadTerm = index.TryGetValue(term, out var postings);
            postings ??= ImmutableHashSet<SearchAddress>.Empty;
            bool hadAddress = postings.Contains(address);
            postings = add ? postings.Add(address) : postings.Remove(address);
            long delta = add && !hadAddress ? 64 : !add && hadAddress ? -64 : 0;
            if (!hadTerm && !postings.IsEmpty) delta += 96L + 2L * term.Length;
            if (hadTerm && postings.IsEmpty) delta -= 96L + 2L * term.Length;
            // Preserve each intermediate overflow check without allocating a state record
            // per term. No callback observes this private accounting pass; the owner still
            // publishes the complete transaction atomically after resource admission.
            estimatedBytes = checked(estimatedBytes + delta);
            index = postings.IsEmpty ? index.Remove(term) : index.SetItem(term, postings);
        }
        if (!ReferenceEquals(index, State.Search))
            State = State with { Search = index, EstimatedBytes = estimatedBytes };
    }

    internal static string AnchorText(ConversationAnchor anchor) =>
        $"{anchor.Title} {anchor.Summary} {string.Join(' ', anchor.Topics)}";
    internal static long AnchorBytes(ConversationAnchor anchor)
    {
        if (anchor.Topics.IsDefault) throw new ArgumentException("Anchor topics must be initialized.");
        long length = checked((long)(anchor.Title?.Length ?? 0) + (anchor.Summary?.Length ?? 0) + 2);
        foreach (string? topic in anchor.Topics) length = checked(length + (topic?.Length ?? 0));
        if (!anchor.Topics.IsEmpty) length = checked(length + anchor.Topics.Length - 1);
        return checked(128L + 2L * length + (anchor.IndexKeys?.EstimatedBytes ?? 0));
    }

    private long EntryBytes(ContextEntry entry)
    {
        ValidateIndexKeys(entry.IndexKeys);
        // Estimation is caller code, not heap introspection. Stability matters because updates
        // subtract old estimates and add new ones; positivity alone cannot enforce consistency.
        long estimate = _options.EntrySizeEstimator(entry);
        if (estimate <= 0) throw new ArgumentException("Entry size estimates must be positive.");
        return estimate;
    }

    internal static void ValidateEntry(ContextEntry entry)
    {
        // Admit a closed set of immutable payloads despite the public abstract base type.
        // Tool role/correlation shape is validated here; JSON syntax, actual tool execution,
        // call/result existence, and application authorization are deliberately not.
        if (entry is null || entry.EntryId == Guid.Empty || entry.Sequence < 0 || !Enum.IsDefined(entry.Role))
            throw new ArgumentException("Invalid entry identity, ordering or role.");
        bool valid = entry.Content switch
        {
            TextContent text => text.Text is not null,
            ToolCallContent call => entry.Role == ContextRole.Assistant && !string.IsNullOrWhiteSpace(call.CallId) &&
                                    !string.IsNullOrWhiteSpace(call.ToolName) && call.ArgumentsJson is not null,
            ToolResultContent result => entry.Role == ContextRole.Tool && !string.IsNullOrWhiteSpace(result.CallId) && result.ResultJson is not null,
            SummaryContent summary => summary.Text is not null && summary.ThroughSequence >= 0 &&
                                      summary.ThroughSequence < entry.Sequence,
            _ => false
        };
        if (!valid) throw new ArgumentException("Invalid or unsupported mutable content.");
    }

    internal static void RequireInitialized<T>(ImmutableArray<T> array)
    {
        if (array.IsDefault) throw new ArgumentException("Arrays must be initialized.");
    }

    /// <summary>
    /// ImmutableList indexing is O(log N); doing it at each binary-search step makes this
    /// O(log-squared N), not O(log N). It avoids copying a flat sorted array on append/delete.
    /// A future persistent order tree with a sequence-aware lower-bound could remove that
    /// extra logarithm. Range reads then pay per returned item, not per skipped history item.
    /// </summary>
    internal static int LowerBound(ImmutableList<EntryOrder> order, long sequence)
    {
        int low = 0, high = order.Count;
        while (low < high)
        {
            int middle = low + (high - low) / 2;
            if (order[middle].Sequence < sequence) low = middle + 1;
            else high = middle;
        }
        return low;
    }
}
