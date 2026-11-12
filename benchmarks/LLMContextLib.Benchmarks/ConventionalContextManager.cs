// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Diagnostics;
using LLMContextLib;

namespace LLMContextLib.Benchmarks;

/// <summary>
/// Fresh conventional application design: mutable List storage, per-session read/write locking,
/// stable-ID dictionaries, and optional ordinary inverted indexes. This does not wrap any
/// previous strategy. Point replacement is in-place O(1) expected plus changed-text indexing;
/// deletion pays List compaction O(N), while coherent long reads hold a read lock.
/// A retained full snapshot copies references, not immutable payload strings.
/// </summary>
internal sealed class ConventionalContextManager : IContextBenchmarkParticipant
{
    private readonly record struct Address(Guid EntryId, Guid? AnchorId);
    private sealed class Slot
    {
        internal readonly ReaderWriterLockSlim Gate = new();
        internal LLMSessionContext Header;
        internal readonly List<ContextEntry> Entries;
        internal readonly Dictionary<Guid, int> Locations;
        internal readonly HashSet<Guid> Seen;
        internal Dictionary<Guid, ConversationAnchor> Anchors;
        internal readonly Dictionary<string, HashSet<Address>> Index = new(StringComparer.Ordinal);
        internal long NextSequence;
        internal Slot(LLMSessionContext session)
        {
            Header = session with
            {
                Segments = ImmutableSortedDictionary<long, ContextSegment>.Empty,
                Anchors = ImmutableDictionary<Guid, ConversationAnchor>.Empty
            };
            Entries = ContextPolicies.Entries(session).ToList();
            Locations = Entries.Select((entry, i) => (entry.EntryId, i)).ToDictionary(pair => pair.EntryId, pair => pair.i);
            Seen = Locations.Keys.ToHashSet();
            Anchors = session.Anchors.ToDictionary();
            NextSequence = Entries.Count == 0 ? 0 : checked(Entries[^1].Sequence + 1);
        }
    }

    private readonly Dictionary<Guid, Slot> _sessions;
    private readonly bool _indexed;
    private readonly object _memoryGate = new();
    private readonly Dictionary<Guid, ContextMemory> _memory = [];
    private readonly Dictionary<MemoryScope, HashSet<Guid>> _scopes = [];
    private readonly TimeProvider _clock;
    private readonly LLMContextOptions _options;
    private readonly object _retentionGate = new();
    private int _held;
    private long _memoryRevision;

    internal ConventionalContextManager(ContextFixture fixture, bool indexed)
    {
        _indexed = indexed;
        _options = fixture.Options;
        _clock = fixture.Options.TimeProvider;
        _sessions = fixture.Sessions.ToDictionary(session => session.SessionId, session => new Slot(session));
        if (!_indexed) return;
        foreach (var slot in _sessions.Values)
        {
            foreach (var entry in slot.Entries) Index(slot, new(entry.EntryId, null), ContextPolicies.Text(entry.Content), true);
            foreach (var anchor in slot.Anchors.Values) Index(slot, new(anchor.StartEntryId, anchor.AnchorId), AnchorText(anchor), true);
        }
    }

    public long Revision(Guid sessionId)
    {
        var slot = _sessions[sessionId];
        var instrumentation = PressureInstrumentation.Current;
        long started = instrumentation is null ? 0 : Stopwatch.GetTimestamp();
        slot.Gate.EnterReadLock();
        instrumentation?.ReadWait(started);
        try { return slot.Header.Revision; }
        finally { slot.Gate.ExitReadLock(); }
    }

    public ContextObservation Read(Guid sessionId, ContextReadRequest request)
    {
        Acquire();
        try { return ReadAdmitted(sessionId, request); }
        finally { Release(); }
    }

    private ContextObservation ReadAdmitted(Guid sessionId, ContextReadRequest request)
    {
        var slot = _sessions[sessionId];
        ContextMemory[] memories;
        long memoryRevision;
        var scopes = BenchmarkParticipants.Scopes(request);
        lock (_memoryGate)
        {
            memoryRevision = _memoryRevision;
            memories = _indexed
                ? scopes.SelectMany(scope => _scopes.TryGetValue(scope, out var ids) ? ids : [])
                    .Distinct().Select(id => _memory[id]).ToArray()
                : scopes.IsEmpty ? [] : _memory.Values.ToArray();
        }
        var instrumentation = PressureInstrumentation.Current;
        long started = instrumentation is null ? 0 : Stopwatch.GetTimestamp();
        slot.Gate.EnterReadLock();
        instrumentation?.ReadWait(started);
        try
        {
            if (slot.Header.Status == SessionStatus.Expired) throw new InvalidOperationException("Session expired.");
            var result = ContextObservation.Empty(slot.Header.Revision, memoryRevision);
            switch (request.Kind)
            {
                case ContextReadKind.Range:
                    int first = LowerBound(slot.Entries, request.FromSequence);
                    return result with { Entries = slot.Entries.Skip(first).Take(request.Limit).ToImmutableArray() };
                case ContextReadKind.Search:
                    return result with { Hits = Search(slot, request.Query, request.Limit) };
                case ContextReadKind.Anchor:
                    return result with { Anchors = [Resolve(slot, request.AnchorId)] };
                case ContextReadKind.Conversation:
                    return result with
                    {
                        Entries = slot.Entries.Where(entry => entry.Role is ContextRole.User or ContextRole.Assistant &&
                            entry.Content is TextContent).Take(request.Limit).ToImmutableArray()
                    };
                case ContextReadKind.Memory:
                    return result with
                    {
                        Memories = ContextPolicies.ApplicableMemory(memories, slot.Header, scopes, _clock.GetUtcNow())
                    };
                case ContextReadKind.Model:
                    return result with
                    {
                        Model = ContextPolicies.BuildModelContext(slot.Entries,
                            ContextPolicies.ApplicableMemory(memories, slot.Header, scopes, _clock.GetUtcNow()),
                            request.TokenBudget, ContextFixture.EstimateTokens, request.Limit)
                    };
                default: throw new ArgumentOutOfRangeException(nameof(request));
            }
        }
        finally { slot.Gate.ExitReadLock(); }
    }

    public IContextMutationResult Apply(ContextChangeSet changes)
    {
        if (!_sessions.TryGetValue(changes.SessionId, out var slot)) return Result(ContextMutationStatus.NotFound, 0);
        var instrumentation = PressureInstrumentation.Current;
        long started = instrumentation is null ? 0 : Stopwatch.GetTimestamp();
        slot.Gate.EnterWriteLock();
        instrumentation?.WriteWait(started);
        try
        {
            long revision = slot.Header.Revision;
            if (revision != changes.ExpectedRevision) return Result(ContextMutationStatus.RevisionConflict, revision);
            var edits = new Dictionary<Guid, ContextEntry?>();
            Dictionary<Guid, ConversationAnchor>? anchors = null;
            var newIds = new HashSet<Guid>();
            long nextSequence = slot.NextSequence;
            var status = slot.Header.Status;
            if (changes.Changes.IsDefaultOrEmpty) return Result(ContextMutationStatus.InvalidOperation, revision);
            try
            {
                foreach (var change in changes.Changes)
                {
                    if (status != SessionStatus.Active && change is not SetSessionStatus)
                        throw new ArgumentException("Session is not active.");
                    switch (change)
                    {
                        case AppendEntries append:
                            foreach (var draft in append.Entries)
                            {
                                if (draft.EntryId == Guid.Empty || slot.Seen.Contains(draft.EntryId) || !newIds.Add(draft.EntryId))
                                    throw new ArgumentException("Invalid/reused entry identity.");
                                _ = ContextPolicies.Text(draft.Content);
                                edits[draft.EntryId] = new(draft.EntryId, nextSequence++, draft.Role, draft.CreatedAt, draft.Content);
                            }
                            break;
                        case ReplaceEntry replace:
                            var old = Find(replace.EntryId);
                            _ = ContextPolicies.Text(replace.Content);
                            edits[replace.EntryId] = old with { Content = replace.Content };
                            break;
                        case DeleteEntry delete:
                            _ = Find(delete.EntryId);
                            edits[delete.EntryId] = null;
                            break;
                        case PutAnchor put:
                            if (Find(put.Anchor.StartEntryId).Sequence > Find(put.Anchor.EndEntryId).Sequence)
                                throw new ArgumentException("Reversed anchor.");
                            anchors ??= new(slot.Anchors);
                            anchors[put.Anchor.AnchorId] = put.Anchor;
                            break;
                        case RemoveAnchor remove:
                            anchors ??= new(slot.Anchors);
                            if (!anchors.Remove(remove.AnchorId)) throw new ArgumentException("Unknown anchor.");
                            break;
                        case SetSessionStatus set:
                            if (status == SessionStatus.Expired && set.Status != SessionStatus.Expired)
                                throw new ArgumentException("Expired session.");
                            status = set.Status;
                            break;
                        default: throw new ArgumentException("Unsupported benchmark-domain operation.");
                    }
                }
            }
            catch (ArgumentException error) { return Result(ContextMutationStatus.InvalidOperation, revision, error.Message); }

            // All ordinary validation precedes mutation. The edit overlay is O(K), not a cloned
            // N-entry transcript. Immutable payload replacements can be installed directly.
            // A deletion needs one O(N) compaction/reindex pass, not one pass per deleted item.
            foreach (var (id, replacement) in edits)
            {
                if (!slot.Locations.TryGetValue(id, out int position)) continue;
                var previous = slot.Entries[position];
                Index(slot, new(id, null), ContextPolicies.Text(previous.Content), false);
                if (replacement is not null) slot.Entries[position] = replacement;
            }
            bool deleted = edits.Any(pair => pair.Value is null);
            if (deleted)
            {
                if (instrumentation is not null) instrumentation.CompactedEntries += slot.Entries.Count;
                slot.Entries.RemoveAll(entry => edits.TryGetValue(entry.EntryId, out var value) && value is null);
                slot.Locations.Clear();
                for (int i = 0; i < slot.Entries.Count; i++) slot.Locations.Add(slot.Entries[i].EntryId, i);
                if (instrumentation is not null) instrumentation.RebuiltLocations += slot.Entries.Count;
            }
            foreach (var (id, replacement) in edits)
            {
                if (replacement is null) continue;
                if (!slot.Locations.ContainsKey(id))
                {
                    slot.Locations.Add(id, slot.Entries.Count);
                    slot.Entries.Add(replacement);
                }
                slot.Seen.Add(id);
                Index(slot, new(id, null), ContextPolicies.Text(replacement.Content), true);
            }
            if (anchors is not null)
            {
                foreach (var anchor in slot.Anchors.Values) Index(slot, new(anchor.StartEntryId, anchor.AnchorId), AnchorText(anchor), false);
                slot.Anchors = anchors;
                foreach (var anchor in anchors.Values) Index(slot, new(anchor.StartEntryId, anchor.AnchorId), AnchorText(anchor), true);
            }
            slot.NextSequence = nextSequence;
            slot.Header = slot.Header with { Revision = checked(revision + 1), Status = status };
            return Result(ContextMutationStatus.Applied, revision + 1);

            ContextEntry Find(Guid id)
            {
                if (edits.TryGetValue(id, out var pending)) return pending ?? throw new ArgumentException("Deleted entry.");
                return slot.Locations.TryGetValue(id, out int index) ? slot.Entries[index] : throw new ArgumentException("Unknown entry.");
            }
        }
        finally { slot.Gate.ExitWriteLock(); }
    }

    public IContextMutationResult ApplyMemory(MemoryChangeSet changes)
    {
        lock (_memoryGate)
        {
            if (_memoryRevision != changes.ExpectedRevision) return Result(ContextMutationStatus.RevisionConflict, _memoryRevision);
            if (changes.Upserts.IsDefault || changes.Deletes.IsDefault || changes.Upserts.IsEmpty && changes.Deletes.IsEmpty)
                return Result(ContextMutationStatus.InvalidOperation, _memoryRevision);
            var seen = new HashSet<Guid>();
            foreach (var id in changes.Deletes)
                if (!seen.Add(id) || !_memory.ContainsKey(id)) return Result(ContextMutationStatus.InvalidOperation, _memoryRevision);
            foreach (var record in changes.Upserts)
            {
                if (!seen.Add(record.MemoryId) || record.Scope == new MemoryScope() ||
                    record.Status == MemoryStatus.Confirmed && record.Sources.IsDefaultOrEmpty)
                    return Result(ContextMutationStatus.InvalidOperation, _memoryRevision);
                foreach (var source in record.Sources)
                {
                    var slot = _sessions[source.SessionId];
                    slot.Gate.EnterReadLock();
                    try
                    {
                        if (!ContextPolicies.Matches(record.Scope, slot.Header) ||
                            !slot.Anchors.TryGetValue(source.AnchorId, out var anchor) ||
                            !slot.Locations.ContainsKey(anchor.StartEntryId) || !slot.Locations.ContainsKey(anchor.EndEntryId))
                            return Result(ContextMutationStatus.InvalidOperation, _memoryRevision);
                    }
                    finally { slot.Gate.ExitReadLock(); }
                }
            }
            long revision = checked(_memoryRevision + 1);
            foreach (var id in changes.Deletes) Remove(id);
            foreach (var record in changes.Upserts)
            {
                if (_memory.ContainsKey(record.MemoryId)) Remove(record.MemoryId);
                _memory.Add(record.MemoryId, record with { Revision = revision });
                if (_indexed)
                {
                    if (!_scopes.TryGetValue(record.Scope, out var ids)) _scopes.Add(record.Scope, ids = []);
                    ids.Add(record.MemoryId);
                }
            }
            _memoryRevision = revision;
            return Result(ContextMutationStatus.Applied, revision);
        }
        void Remove(Guid id)
        {
            var previous = _memory[id];
            _memory.Remove(id);
            if (!_indexed) return;
            var ids = _scopes[previous.Scope];
            ids.Remove(id);
            if (ids.Count == 0) _scopes.Remove(previous.Scope);
        }
    }

    private ImmutableArray<ContextSearchHit> Search(Slot slot, string query, int limit)
    {
        var terms = ContextPolicies.Terms(query);
        if (terms.IsEmpty || limit == 0) return [];
        IEnumerable<Address> candidates;
        if (_indexed)
        {
            var sets = new List<HashSet<Address>>();
            foreach (var term in terms)
            {
                if (!slot.Index.TryGetValue(term, out var ids)) return [];
                sets.Add(ids);
            }
            var smallest = sets.MinBy(set => set.Count)!;
            candidates = smallest.Where(address => sets.All(set => set.Contains(address)));
        }
        else
            candidates = slot.Entries.Where(entry => Matches(ContextPolicies.Text(entry.Content)))
                .Select(entry => new Address(entry.EntryId, null))
                .Concat(slot.Anchors.Values.Where(anchor => Matches(AnchorText(anchor)))
                    .Select(anchor => new Address(anchor.StartEntryId, anchor.AnchorId)));
        var hits = new List<ContextSearchHit>();
        foreach (var address in candidates)
        {
            if (!slot.Locations.TryGetValue(address.EntryId, out int index)) continue;
            var entry = slot.Entries[index];
            string text = address.AnchorId.HasValue ? AnchorText(slot.Anchors[address.AnchorId.Value]) : ContextPolicies.Text(entry.Content);
            hits.Add(new(entry.EntryId, address.AnchorId, text[..Math.Min(160, text.Length)], entry.Sequence, slot.Header.Revision));
        }
        return hits.OrderBy(hit => hit.Sequence).ThenBy(hit => hit.AnchorId).Take(limit).ToImmutableArray();
        bool Matches(string text)
        {
            var words = ContextPolicies.Terms(text);
            return terms.All(term => words.Contains(term));
        }
    }

    private static AnchorResolution Resolve(Slot slot, Guid id)
    {
        var anchor = slot.Anchors[id];
        long revision = slot.Header.Revision;
        if (anchor.PinnedRevision.HasValue && anchor.PinnedRevision != revision)
            return new(anchor, AnchorTargetStatus.HistoryUnavailable, null, null, revision);
        ContextEntry? start = slot.Locations.TryGetValue(anchor.StartEntryId, out int first) ? slot.Entries[first] : null;
        ContextEntry? end = slot.Locations.TryGetValue(anchor.EndEntryId, out int last) ? slot.Entries[last] : null;
        var status = start is null && end is null ? AnchorTargetStatus.Missing : start is null || end is null
            ? AnchorTargetStatus.Partial : anchor.SourceRevision == revision ? AnchorTargetStatus.Current : AnchorTargetStatus.Edited;
        return new(anchor, status, start, end, revision);
    }

    private void Index(Slot slot, Address address, string text, bool add)
    {
        if (!_indexed) return;
        foreach (var term in ContextPolicies.Terms(text))
        {
            if (!slot.Index.TryGetValue(term, out var ids))
            {
                if (!add) continue;
                slot.Index.Add(term, ids = []);
            }
            if (add) ids.Add(address); else ids.Remove(address);
            if (ids.Count == 0) slot.Index.Remove(term);
        }
    }

    private static int LowerBound(List<ContextEntry> entries, long sequence)
    {
        int low = 0, high = entries.Count;
        while (low < high)
        {
            int middle = low + (high - low) / 2;
            if (entries[middle].Sequence < sequence) low = middle + 1; else high = middle;
        }
        return low;
    }

    public IContextRetention Retain(Guid sessionId)
    {
        Acquire();
        var slot = _sessions[sessionId];
        var instrumentation = PressureInstrumentation.Current;
        long started = instrumentation is null ? 0 : Stopwatch.GetTimestamp();
        slot.Gate.EnterReadLock();
        instrumentation?.ReadWait(started);
        try
        {
            var entries = slot.Entries.ToArray();
            var anchors = slot.Anchors.Values.ToArray();
            if (instrumentation is not null) instrumentation.SnapshotReferences += entries.Length + anchors.Length;
            return new Retention(slot.Header.Revision, entries, anchors, Release);
        }
        catch { Release(); throw; }
        finally { slot.Gate.ExitReadLock(); }
    }

    private sealed class Retention(long revision, ContextEntry[] entries, ConversationAnchor[] anchors, Action release) : IContextRetention
    {
        private ContextEntry[]? _entries = entries;
        private ConversationAnchor[]? _anchors = anchors;
        private Action? _release = release;
        public long Revision => _entries is null ? throw new ObjectDisposedException(nameof(Retention)) : revision;
        public ContextEntry? FirstEntry => _entries is null ? throw new ObjectDisposedException(nameof(Retention)) : _entries.FirstOrDefault();
        public void Dispose()
        {
            _entries = null;
            _anchors = null;
            Interlocked.Exchange(ref _release, null)?.Invoke();
        }
    }

    private void Acquire()
    {
        var instrumentation = PressureInstrumentation.Current;
        long entered = instrumentation is null ? 0 : Stopwatch.GetTimestamp();
        try
        {
            lock (_retentionGate)
            {
                long start = Stopwatch.GetTimestamp();
                while (_held >= _options.MaximumRetainedReads)
                {
                    if (instrumentation is not null) instrumentation.AdmissionWaits++;
                    var remaining = _options.AdmissionTimeout - Stopwatch.GetElapsedTime(start);
                    if (remaining <= TimeSpan.Zero) throw new InvalidOperationException("Read-retention count exhausted.");
                    Monitor.Wait(_retentionGate, remaining);
                }
                _held++;
            }
        }
        finally { if (instrumentation is not null) instrumentation.AdmissionTicks += Stopwatch.GetTimestamp() - entered; }
    }

    private void Release()
    {
        lock (_retentionGate) { _held--; Monitor.PulseAll(_retentionGate); }
    }

    private static string AnchorText(ConversationAnchor anchor) => $"{anchor.Title} {anchor.Summary} {string.Join(' ', anchor.Topics)}";
    private static IContextMutationResult Result(ContextMutationStatus status, long revision, string? error = null) =>
        new BenchmarkMutationResult(status, revision, error);
    public void Dispose()
    {
        foreach (var slot in _sessions.Values) slot.Gate.Dispose();
    }
}
