// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;

namespace LLMContextLib;

/// <summary>
/// A session root, a memory-catalog root, and an evaluation clock captured once. This revision
/// pair is explicitly not a cross-catalog transaction. Reads never reacquire current roots.
/// Disposal releases accounting exactly once; managed immutable payloads need no pooled-buffer
/// pinning. Operations after disposal fail rather than quietly accessing a newer generation.
/// </summary>
internal sealed class ContextReadLease : ILLMContextReadLease
{
    private ContextState? _state;
    private MemoryState? _memory;
    private readonly DateTimeOffset _now;
    private Action? _release;
    private ContextState State => Volatile.Read(ref _state) ?? throw new ObjectDisposedException(nameof(ContextReadLease));
    private MemoryState Memory => Volatile.Read(ref _memory) ?? throw new ObjectDisposedException(nameof(ContextReadLease));
    internal ContextReadLease(ContextState state, MemoryState memory, DateTimeOffset now, Action release)
        => (_state, _memory, _now, _release) = (state, memory, now, release);
    // Keep method bodies bound to one immutable generation. These properties never obtain the
    // owner's newer state; clearing fields on disposal also avoids a disposed handle rooting
    // the entire old session indefinitely if the consumer retains the handle object itself.
    private ContextState state => State;
    private MemoryState memory => Memory;
    public LLMSessionContext Session { get { Check(); return state.Session; } }
    public long MemoryRevision { get { Check(); return memory.Revision; } }
    private void Check() => ObjectDisposedException.ThrowIf(Volatile.Read(ref _release) is null, this);

    // The location map and segment directory come from the same published root. Resolving
    // through them cannot combine a new offset with an old segment after another writer commits.
    public bool TryFindEntry(Guid entryId, out ContextEntry entry)
    {
        Check();
        if (state.Locations.TryGetValue(entryId, out var location))
        {
            entry = state.Session.Segments[location.SegmentId].Entries[location.Offset];
            return true;
        }
        entry = null!;
        return false;
    }

    /// <summary>
    /// Lower-bound uses O(log² N) because persistent-list indexing is O(log N). Each of R
    /// results pays order-list lookup, immutable hash-bucket lookup and AVL segment lookup:
    /// O(log² N + R * (log N + H(N) + log S)); only R entry references are materialized.
    /// Earlier conversation payloads are not scanned, decoded or copied.
    /// </summary>
    public ImmutableArray<ContextEntry> ReadRange(long fromSequence, int count)
    {
        Check();
        if (fromSequence < 0 || count < 0) throw new ArgumentOutOfRangeException(nameof(fromSequence));
        int start = ContextStateBuilder.LowerBound(state.Order, fromSequence);
        int take = Math.Min(count, state.Order.Count - start);
        var result = ImmutableArray.CreateBuilder<ContextEntry>(take);
        for (int i = 0; i < take; i++)
        {
            TryFindEntry(state.Order[start + i].EntryId, out var entry);
            result.Add(entry);
        }
        return result.MoveToImmutable();
    }

    public ContextPage ReadPage(ContextCursor? cursor, int count)
    {
        Check();
        if (count <= 0) throw new ArgumentOutOfRangeException(nameof(count));
        if (cursor is not null && (cursor.SessionId != state.Session.SessionId ||
            cursor.Revision != state.Session.Revision || cursor.AfterSequence < 0))
            throw new ArgumentException("Cursor belongs to another session/revision.", nameof(cursor));
        // Continue by sequence rather than positional offset: deletions leave holes. The
        // revision check above prevents a page walk from silently mixing snapshots.
        long start = cursor is null ? 0 : checked(cursor.AfterSequence + 1);
        var entries = ReadRange(start, count);
        bool more = entries.Length > 0 &&
            ContextStateBuilder.LowerBound(state.Order, entries[^1].Sequence) + 1 < state.Order.Count;
        return new(entries, more
            ? new ContextCursor(state.Session.SessionId, state.Session.Revision, entries[^1].Sequence) : null);
    }

    /// <summary>
    /// Intersect postings, starting with the smallest set; then resolve/sort actual candidates.
    /// This does not claim O(limit) search: common terms may still produce K ~ N candidates.
    /// Work includes query tokenization, all inspected postings, candidate lookups, and K log K
    /// deterministic ordering before truncation. Index maintenance is charged to mutations.
    /// </summary>
    public ImmutableArray<ContextSearchHit> Search(string query, int limit)
    {
        Check();
        if (limit < 0) throw new ArgumentOutOfRangeException(nameof(limit));
        var terms = ContextPolicies.Terms(query);
        if (limit == 0 || terms.IsEmpty) return [];
        var sets = new List<ImmutableHashSet<SearchAddress>>(terms.Length);
        foreach (var term in terms)
        {
            if (!state.Search.TryGetValue(term, out var postings)) return [];
            sets.Add(postings);
        }
        sets.Sort((left, right) => left.Count.CompareTo(right.Count));
        // Entry text and anchor metadata have different addresses even at the same entry.
        // Requiring every term at one address prevents a query from accidentally combining
        // half its terms from entry text with half from an unrelated bookmark description.
        var hits = new List<ContextSearchHit>();
        foreach (var address in sets[0])
        {
            if (!sets.All(set => set.Contains(address)) || !TryFindEntry(address.EntryId, out var entry)) continue;
            string text = address.AnchorId.HasValue
                ? ContextStateBuilder.AnchorText(state.Session.Anchors[address.AnchorId.Value])
                : ContextPolicies.Text(entry.Content);
            hits.Add(new(entry.EntryId, address.AnchorId, text[..Math.Min(text.Length, 160)],
                entry.Sequence, state.Session.Revision));
        }
        return hits.OrderBy(hit => hit.Sequence).ThenBy(hit => hit.AnchorId)
            .Take(limit).ToImmutableArray();
    }

    public AnchorResolution ResolveAnchor(Guid anchorId)
    {
        Check();
        if (!state.Session.Anchors.TryGetValue(anchorId, out var anchor))
            throw new KeyNotFoundException("Anchor not found.");
        // A pin is an exact-version requirement, not a request to reconstruct historical
        // text. Even surviving current endpoints do not satisfy a different pinned revision.
        if (anchor.PinnedRevision.HasValue && anchor.PinnedRevision != state.Session.Revision)
            return new(anchor, AnchorTargetStatus.HistoryUnavailable, null, null, state.Session.Revision);
        TryFindEntry(anchor.StartEntryId, out var start);
        TryFindEntry(anchor.EndEntryId, out var end);
        var status = start is null && end is null ? AnchorTargetStatus.Missing :
            start is null || end is null ? AnchorTargetStatus.Partial :
            state.Session.Revision == anchor.SourceRevision ? AnchorTargetStatus.Current : AnchorTargetStatus.Edited;
        // Edited is deliberately conservative: without retained provenance versions we cannot
        // distinguish a passage edit from an unrelated later session mutation.
        return new(anchor, status, start, end, state.Session.Revision);
    }

    public ImmutableArray<ContextMemory> GetApplicableMemory(ImmutableArray<MemoryScope> scopes)
    {
        Check();
        ContextStateBuilder.RequireInitialized(scopes);
        // Narrow by exact scope buckets before applying the shared semantic filter. Union
        // deduplicates records when a request repeats scopes; it does not broaden them.
        var candidates = new HashSet<Guid>();
        foreach (var scope in scopes)
        {
            ContextPolicies.ValidateScope(scope);
            if (!ContextPolicies.Matches(scope, state.Session))
                throw new ArgumentException("Requested scope does not apply to this session.", nameof(scopes));
            if (memory.Scopes.TryGetValue(scope, out var ids)) candidates.UnionWith(ids);
        }
        return ContextPolicies.ApplicableMemory(candidates.Select(id => memory.Records[id]),
            state.Session, scopes, _now);
    }

    public void Dispose()
    {
        // Release accounting once, and sever this handle's graph references. Arrays/records
        // already returned to a caller remain ordinary managed values, not invalidated buffers.
        var release = Interlocked.Exchange(ref _release, null);
        if (release is null) return;
        _state = null;
        _memory = null;
        release();
    }
}
