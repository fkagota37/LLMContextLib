// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Diagnostics;

namespace LLMContextLib;

/// <summary>
/// Independently published catalog root. Scope postings and records must move together:
/// otherwise a read could discover an ID in one revision and dereference another revision.
/// Its revision domain is separate from every session, including sessions supplying provenance.
/// </summary>
internal sealed record MemoryState(
    long Revision,
    ImmutableDictionary<Guid, ContextMemory> Records,
    ImmutableDictionary<MemoryScope, ImmutableHashSet<Guid>> Scopes,
    long EstimatedBytes)
{
    internal static MemoryState Empty { get; } = new(0, ImmutableDictionary<Guid, ContextMemory>.Empty,
        ImmutableDictionary<MemoryScope, ImmutableHashSet<Guid>>.Empty, 0);
}

/// <summary>
/// Private boundary between the lifetime-fenced client and storage. It is not a public
/// extension point: the client supplies shutdown coordination and storage supplies immutable
/// publication/admission. Returned leases retain roots independently of either object's lifetime.
/// </summary>
internal interface ILLMContextStorage : IDisposable
{
    bool TryFind(Guid id, out LLMSessionContext session);
    IContextMutationResult Create(LLMSessionContext session);
    IContextMutationResult Remove(Guid id, long revision);
    IContextMutationResult Apply(ContextChangeSet changes);
    IContextMutationResult ApplyMemory(MemoryChangeSet changes);
    ILLMContextReadLease OpenRead(Guid id);
    IDisposable RetainOutput(long bytes);
    LLMContextStatistics Statistics();
    Task WaitForIndexingAsync(Guid id, long revision, CancellationToken cancellationToken);
    Task<ContextIndexSynchronization> SynchronizeIndexAsync(Guid id, CancellationToken cancellationToken);
}

/// <summary>
/// Independent storage, not a wrapper around a previous array strategy. ConcurrentDictionary
/// owns the growing session directory, avoiding full-array publication for independent sessions.
/// Each slot has a commit gate; by default tokenization/path-copy preparation is speculative.
/// An internal experimental policy also serializes preparation with that same per-slot gate.
/// A separate short accounting gate protects budget/lease metadata, NOT ordinary point reads.
/// Hash-based directory lookup is expected O(1), with ordinary collision/resizing caveats.
/// </summary>
internal sealed partial class SegmentedContextStorage : ILLMContextStorage
{
    // A slot survives in-flight operations even after directory removal. Removed is checked
    // under Gate so a prepared writer cannot resurrect it by publishing into that old slot.
    private sealed class Slot(ContextState state)
    {
        internal ContextState State = state;
        internal readonly object Gate = new();
        internal bool Removed;
        internal bool Synchronizing;
        internal long SynchronizationEpoch;
        internal int Preparations;
        internal TaskCompletionSource<ContextIndexSynchronization>? Synchronization;
    }

    // Lock map: session Gate or _memoryGate serializes its own publication; _resources protects
    // accounting, retention references, and session-ID tombstones. Writers acquire their
    // publication gate before _resources. Readers capture roots without publication gates.
    // Monitor.Wait releases only _resources, so a budget-waiting writer still owns its gate.
    private readonly ConcurrentDictionary<Guid, Slot> _sessions = new();
    private readonly HashSet<Guid> _seenSessions = [];
    private readonly object _resources = new();
    private readonly object _memoryGate = new();
    private readonly Dictionary<object, (long Bytes, int Count)> _retained = new(ReferenceEqualityComparer.Instance);
    private readonly LLMContextOptions _options;
    private readonly Func<LLMSessionContext, Guid> _selector;
    private MemoryState _memory = MemoryState.Empty;
    private long _activeBytes, _retainedBytes, _published, _segments, _rewrittenBytes;
    private long _viewBytes;
    private int _reads;
    private readonly DeferredIndexingCoordinator? _indexing;
    private readonly ContextExecution? _execution;

    internal SegmentedContextStorage(LLMContextOptions options, Func<LLMSessionContext, Guid> selector,
        ContextExecutionRecipe? execution = null)
    {
        (_options, _selector) = (options, selector);
        execution?.Validate(options);
        _execution = execution is null ? null : new(execution, options, CanDeferEntry);
        _activeBytes = execution?.ReservedBytes ?? 0;
        if (options.PartitionedIndex is { } partitions)
            _activeBytes = checked(_activeBytes + partitions.RecoveryBytes + partitions.InfrastructureBytes);
        try
        {
            if (options.DeferredIndexing is not null && (_execution?.UsesDeferredIndexing ?? true))
                _indexing = new(this, options.DeferredIndexing);
        }
        catch { _execution?.Dispose(); throw; }
    }

    private bool CanDeferEntry(int characters)
    {
        lock (_resources)
            return _indexing is not null && _indexing.CanReserveEntry(characters) &&
                checked(ContextIndexTokenizer.IndexReservation(characters) +
                    ContextIndexTokenizer.WorkReservation(characters)) <=
                _options.EstimatedResidentByteBudget - _activeBytes - _retainedBytes;
    }

    public bool TryFind(Guid id, out LLMSessionContext session)
    {
        if (_sessions.TryGetValue(id, out var slot))
        {
            session = Volatile.Read(ref slot.State).Session;
            return true;
        }
        session = null!;
        return false;
    }

    public IContextMutationResult Create(LLMSessionContext session)
    {
        try
        {
            ArgumentNullException.ThrowIfNull(session);
            if (_selector(session) != session.SessionId)
                throw new ArgumentException("The selected key must be SessionId.");
            // Validate/rebuild every derived directory privately before directory insertion.
            // Imported graphs do not get to supply trusted locations or search postings.
            var state = ContextStateBuilder.Initialize(session, _options, _execution);
            var work = NewIndexWork(state, previous: null);
            lock (_resources)
            {
                // Reserve IDs for the entire owner lifetime, including after removal. Waiting
                // for budget yields this lock, hence the second identity check after admission.
                if (_seenSessions.Contains(session.SessionId))
                    return Result(ContextMutationStatus.InvalidOperation, session.Revision, "Session identities cannot be reused.");
                if (_indexing is not null && !_indexing.CanReserve(work))
                    return Result(ContextMutationStatus.AdmissionRejected, session.Revision, "Deferred indexing backlog or work budget exhausted.");
                if (!WaitForBudget(checked(state.EstimatedBytes + 48 + WorkBytes(work)), 0, additionalRead: false))
                    return Result(ContextMutationStatus.AdmissionRejected, session.Revision, "Resident budget exhausted.");
                if (_seenSessions.Contains(session.SessionId))
                    return Result(ContextMutationStatus.InvalidOperation, session.Revision, "Session identity was admitted while waiting.");
                if (_indexing is not null && !_indexing.CanReserve(work))
                    return Result(ContextMutationStatus.AdmissionRejected, session.Revision, "Deferred indexing backlog or work budget exhausted.");
                if (!_sessions.TryAdd(session.SessionId, new Slot(state)))
                    return Result(ContextMutationStatus.InvalidOperation, session.Revision, "Session already exists.");
                _seenSessions.Add(session.SessionId);
                _activeBytes = checked(_activeBytes + state.EstimatedBytes + 48);
                _indexing?.Reserve(work);
                _published++;
                _indexing?.Pulse();
            }
            return Result(ContextMutationStatus.Applied, state.Session.Revision);
        }
        catch (Exception error) when (IsValidation(error))
        {
            return Result(ContextMutationStatus.InvalidOperation, 0, error.Message);
        }
    }

    public IContextMutationResult Remove(Guid id, long revision)
    {
        if (!_sessions.TryGetValue(id, out var slot)) return Result(ContextMutationStatus.NotFound, 0);
        if (!Monitor.TryEnter(slot.Gate, _options.AdmissionTimeout))
            return Result(ContextMutationStatus.AdmissionRejected, revision, "Session commit gate is busy.");
        try
        {
            var current = Volatile.Read(ref slot.State);
            if (slot.Removed) return Result(ContextMutationStatus.NotFound, current.Session.Revision);
            if (current.Session.Revision != revision) return Result(ContextMutationStatus.RevisionConflict, current.Session.Revision);
            if (slot.Synchronizing)
                return Result(ContextMutationStatus.Synchronizing, current.Session.Revision,
                    "Session index synchronization has closed write admission.");
            slot.Removed = true;
            _sessions.TryRemove(id, out _);
            lock (_resources)
            {
                // Keep the 48-byte identity reservation charged: the tombstone still prevents
                // ID reuse. Existing read charges are untouched and release on their own disposal.
                _activeBytes -= current.EstimatedBytes;
                _published++;
                _indexing?.Pulse();
                Monitor.PulseAll(_resources);
            }
            return Result(ContextMutationStatus.Applied, current.Session.Revision);
        }
        finally { Monitor.Exit(slot.Gate); }
    }

    public IContextMutationResult Apply(ContextChangeSet changes)
    {
        ArgumentNullException.ThrowIfNull(changes);
        var diagnostic = MutationDiagnostics.Current;
        diagnostic?.Begin();
        Slot? slot = null;
        bool entered = false;
        long preparationReservation = 0;
        long synchronizationEpoch = 0;
        bool partitionPreparation = false;
        try
        {
            if (!_sessions.TryGetValue(changes.SessionId, out slot))
                return Finish(ContextMutationStatus.NotFound, 0, MutationDisposition.NotFound, diagnostic);
            if (_options.PartitionedIndex is not null &&
                !EnterPartitionAdmission(slot, out synchronizationEpoch, out bool synchronizing))
                return Finish(synchronizing ? ContextMutationStatus.Synchronizing : ContextMutationStatus.AdmissionRejected,
                    changes.ExpectedRevision, MutationDisposition.GateRejected, diagnostic,
                    synchronizing ? "Session index synchronization has closed write admission." : "Session commit gate is busy.");
            partitionPreparation = _options.PartitionedIndex is not null;
            var captured = Volatile.Read(ref slot.State);
            if (captured.Session.Revision != changes.ExpectedRevision)
                return Finish(ContextMutationStatus.RevisionConflict, captured.Session.Revision, MutationDisposition.InitialRevisionConflict, diagnostic);

            // Strict CAS is unchanged: waiting never rebases a caller's expected revision.
            // For W writers sharing a revision and preparation cost P, speculative work can
            // reach W*P. Serial preparation permits one P then cheap stale checks, excluding
            // gate waiting/timeouts. It can trade wasted work for head-of-line blocking.
            // No reader uses this gate; independent sessions keep independent writer gates.
            if (_execution?.SelectSerializedPreparation() ?? _options.SerializeSessionPreparation)
            {
                if (!EnterWriter(slot.Gate, diagnostic))
                    return Finish(ContextMutationStatus.AdmissionRejected, captured.Session.Revision, MutationDisposition.GateRejected, diagnostic, "Session commit gate is busy.");
                entered = true;
                if (slot.Removed)
                    return Finish(ContextMutationStatus.NotFound, captured.Session.Revision, MutationDisposition.NotFound, diagnostic);
                captured = Volatile.Read(ref slot.State);
                if (captured.Session.Revision != changes.ExpectedRevision)
                    return Finish(ContextMutationStatus.RevisionConflict, captured.Session.Revision, MutationDisposition.GatedRevisionConflict, diagnostic);
            }

            ContextStateBuilder transaction;
            ContextState next;
            diagnostic?.BeginPreparation();
            try
            {
                // All command effects, validation, index updates, and estimator callbacks occur
                // in an unreachable candidate. Even a late invalid command discards the whole
                // candidate; none of the builder's intermediate roots can leak into readers.
                ContextStateBuilder.RequireInitialized(changes.Changes);
                if (changes.Changes.IsEmpty) throw new ArgumentException("A change set cannot be empty.");
                if (_options.PartitionedIndex is not null)
                {
                    if (!ReservePreparation(changes, out long reserved))
                        return Finish(ContextMutationStatus.AdmissionRejected, captured.Session.Revision,
                            MutationDisposition.ResourceRejected, diagnostic, "Preconstruction reservation unavailable or oversized.");
                    preparationReservation = reserved;
                }
                long revision = checked(captured.Session.Revision + 1);
                transaction = new ContextStateBuilder(captured, _options, execution: _execution);
                transaction.ApplyChanges(changes.Changes, revision);
                next = transaction.State with { Session = transaction.State.Session with { Revision = revision } };
                if (diagnostic is not null) diagnostic.Prepared = true;
            }
            catch (PartitionCapacityException error)
            {
                bool canSynchronize = error.CanSynchronize &&
                    captured.IndexPartitions.TryGetValue(error.SegmentId, out var partition) &&
                    !partition.Overrides.IsEmpty;
                if (canSynchronize)
                {
                    try { _ = SynchronizeIndexAsync(changes.SessionId, CancellationToken.None); }
                    catch (KeyNotFoundException) { }
                }
                return Finish(canSynchronize ? ContextMutationStatus.SynchronizationRequired :
                    ContextMutationStatus.AdmissionRejected, captured.Session.Revision,
                    MutationDisposition.ResourceRejected, diagnostic, error.Message);
            }
            catch (Exception error) when (IsValidation(error))
            {
                return Finish(ContextMutationStatus.InvalidOperation, captured.Session.Revision, MutationDisposition.InvalidPreparation, diagnostic, error.Message);
            }
            finally { diagnostic?.EndPreparation(); }

            if (!entered)
            {
                if (!EnterWriter(slot.Gate, diagnostic))
                    return Finish(ContextMutationStatus.AdmissionRejected, captured.Session.Revision, MutationDisposition.GateRejected, diagnostic, "Session commit gate is busy.");
                entered = true;
            }
            if (slot.Removed)
                return Finish(ContextMutationStatus.NotFound, captured.Session.Revision, MutationDisposition.NotFound, diagnostic);
            if (_options.PartitionedIndex is not null &&
                (slot.Synchronizing || synchronizationEpoch != slot.SynchronizationEpoch))
                return Finish(ContextMutationStatus.SynchronizationRequired, captured.Session.Revision,
                    MutationDisposition.GateRejected, diagnostic, "Preparation crossed an index synchronization fence.");
            // Content identity is the final fence for speculative work. Only derived index
            // progress may merge; an intervening content publication still conflicts.
            var current = Volatile.Read(ref slot.State);
            if (!ReferenceEquals(captured.Session, current.Session))
                return Finish(ContextMutationStatus.RevisionConflict, current.Session.Revision, MutationDisposition.PreparedRevisionConflict, diagnostic);
            if (!ReferenceEquals(captured, current))
            {
                transaction.RebaseIndexProgress(captured, current);
                next = transaction.State with { Session = next.Session };
            }
            if (_indexing is not null)
                next = next with { IndexGeneration = checked(current.IndexGeneration + 1) };
            var work = NewIndexWork(next, current);
            long resourceStart = diagnostic is null ? 0 : Stopwatch.GetTimestamp();
            try
            {
                lock (_resources)
                {
                    long delta = checked(next.EstimatedBytes - current.EstimatedBytes);
                    if (_options.PartitionedIndex is not null && delta > preparationReservation)
                        return Finish(ContextMutationStatus.AdmissionRejected, current.Session.Revision,
                            MutationDisposition.ResourceRejected, diagnostic, "Candidate exceeded its preparation reservation.");
                    if (_indexing is not null && !_indexing.CanReserve(work))
                        return Finish(ContextMutationStatus.AdmissionRejected, current.Session.Revision, MutationDisposition.ResourceRejected, diagnostic, "Deferred indexing backlog or work budget exhausted.");
                    if (!WaitForBudget(checked(delta + WorkBytes(work) - preparationReservation), 0, additionalRead: false))
                        return Finish(ContextMutationStatus.AdmissionRejected, captured.Session.Revision, MutationDisposition.ResourceRejected, diagnostic, "Resident budget exhausted.");
                    if (_indexing is not null && !_indexing.CanReserve(work))
                        return Finish(ContextMutationStatus.AdmissionRejected, current.Session.Revision, MutationDisposition.ResourceRejected, diagnostic, "Deferred indexing backlog or work budget exhausted.");
                    // This is the session's linearization point: content, locations, order,
                    // anchors, retained entry terms, and search become visible as one immutable generation.
                    // Retained old roots remain charged separately; active accounting changes
                    // only after admission, along with successful-publication statistics.
                    Volatile.Write(ref slot.State, next);
                    _activeBytes = checked(_activeBytes + delta);
                    _indexing?.Reserve(work);
                    _published++;
                    _segments += transaction.SegmentsRewritten;
                    _rewrittenBytes += transaction.BytesRewritten;
                    _indexing?.Pulse();
                }
            }
            finally { if (diagnostic is not null) diagnostic.ResourceTicks = Stopwatch.GetTimestamp() - resourceStart; }
            if (diagnostic is not null) diagnostic.Disposition = MutationDisposition.Applied;
            return new ContextMutationResult(ContextMutationStatus.Applied, next.Session.Revision,
                AppendedEntryIds: transaction.Appended.ToImmutable());
        }
        finally
        {
            if (entered) Monitor.Exit(slot!.Gate);
            ReleasePreparation(preparationReservation);
            if (partitionPreparation)
                lock (slot!.Gate)
                {
                    slot.Preparations--;
                    Monitor.PulseAll(slot.Gate);
                }
            diagnostic?.End();
        }
    }

    private bool EnterWriter(object gate, MutationDiagnostics? diagnostic)
    {
        // AdmissionTimeout bounds this gate attempt, not the complete mutation. Preparation
        // and a later resource wait have their own costs; diagnostics keep those phases separate.
        long start = diagnostic is null ? 0 : Stopwatch.GetTimestamp();
        if (diagnostic is not null) Volatile.Write(ref diagnostic.GateAttempted, true);
        try { return Monitor.TryEnter(gate, _options.AdmissionTimeout); }
        finally { if (diagnostic is not null) diagnostic.GateTicks = Stopwatch.GetTimestamp() - start; }
    }

    private static IContextMutationResult Finish(ContextMutationStatus status, long revision,
        MutationDisposition disposition, MutationDiagnostics? diagnostic, string? error = null)
    {
        if (diagnostic is not null) diagnostic.Disposition = disposition;
        return Result(status, revision, error);
    }

    public IContextMutationResult ApplyMemory(MemoryChangeSet changes)
    {
        ArgumentNullException.ThrowIfNull(changes);
        var diagnostic = MutationDiagnostics.Current;
        diagnostic?.Begin();
        try { return ApplyMemoryCore(changes, diagnostic); }
        finally { diagnostic?.End(); }
    }

    private IContextMutationResult ApplyMemoryCore(MemoryChangeSet changes, MutationDiagnostics? diagnostic)
    {
        // The memory catalog is a different contention domain. Its policy is unchanged;
        // diagnostics must not attribute these conflicts to the per-session experiment.
        var captured = Volatile.Read(ref _memory);
        if (captured.Revision != changes.ExpectedRevision)
            return Finish(ContextMutationStatus.RevisionConflict, captured.Revision, MutationDisposition.InitialRevisionConflict, diagnostic);
        MemoryState next;
        diagnostic?.BeginPreparation();
        try
        {
            ContextStateBuilder.RequireInitialized(changes.Upserts);
            ContextStateBuilder.RequireInitialized(changes.Deletes);
            if (changes.Upserts.IsEmpty && changes.Deletes.IsEmpty) throw new ArgumentException("Empty memory change.");
            long revision = checked(captured.Revision + 1);
            var records = captured.Records;
            var scopes = captured.Scopes;
            long bytes = captured.EstimatedBytes;
            var seen = new HashSet<Guid>();
            // One ID may appear only once across deletes and upserts. Maintain private record
            // and scope roots together, removing old scope membership when an upsert moves scope.
            foreach (var id in changes.Deletes)
            {
                if (!seen.Add(id) || !records.TryGetValue(id, out var old)) throw new ArgumentException("Unknown/duplicate memory.");
                Remove(old);
            }
            foreach (var memory in changes.Upserts)
            {
                ValidateMemory(memory);
                if (!seen.Add(memory.MemoryId)) throw new ArgumentException("Duplicate memory change.");
                if (records.TryGetValue(memory.MemoryId, out var old)) Remove(old);
                var accepted = memory with { Revision = revision };
                records = records.Add(accepted.MemoryId, accepted);
                scopes.TryGetValue(accepted.Scope, out var ids);
                scopes = scopes.SetItem(accepted.Scope, (ids ?? ImmutableHashSet<Guid>.Empty).Add(accepted.MemoryId));
                bytes = checked(bytes + MemoryBytes(accepted));
            }
            next = new MemoryState(revision, records, scopes, bytes);
            if (diagnostic is not null) diagnostic.Prepared = true;

            void Remove(ContextMemory old)
            {
                records = records.Remove(old.MemoryId);
                var ids = scopes[old.Scope].Remove(old.MemoryId);
                scopes = ids.IsEmpty ? scopes.Remove(old.Scope) : scopes.SetItem(old.Scope, ids);
                bytes = checked(bytes - MemoryBytes(old));
            }
        }
        catch (Exception error) when (IsValidation(error))
        {
            return Finish(ContextMutationStatus.InvalidOperation, captured.Revision, MutationDisposition.InvalidPreparation, diagnostic, error.Message);
        }
        finally { diagnostic?.EndPreparation(); }
        if (!EnterWriter(_memoryGate, diagnostic))
            return Finish(ContextMutationStatus.AdmissionRejected, captured.Revision, MutationDisposition.GateRejected, diagnostic, "Memory commit gate is busy.");
        try
        {
            if (!ReferenceEquals(captured, Volatile.Read(ref _memory)))
                return Finish(ContextMutationStatus.RevisionConflict, _memory.Revision, MutationDisposition.PreparedRevisionConflict, diagnostic);
            long resourceStart = diagnostic is null ? 0 : Stopwatch.GetTimestamp();
            try
            {
                lock (_resources)
                {
                    long delta = checked(next.EstimatedBytes - captured.EstimatedBytes);
                    if (!WaitForBudget(delta, 0, additionalRead: false))
                        return Finish(ContextMutationStatus.AdmissionRejected, captured.Revision, MutationDisposition.ResourceRejected, diagnostic, "Resident budget exhausted.");
                    Volatile.Write(ref _memory, next);
                    _activeBytes = checked(_activeBytes + delta);
                    _published++;
                }
            }
            finally { if (diagnostic is not null) diagnostic.ResourceTicks = Stopwatch.GetTimestamp() - resourceStart; }
            return Finish(ContextMutationStatus.Applied, next.Revision, MutationDisposition.Applied, diagnostic);
        }
        finally { Monitor.Exit(_memoryGate); }
    }

    private void ValidateMemory(ContextMemory memory)
    {
        // This checks evidence availability during preparation, not in a cross-session commit.
        // Sources can change immediately afterwards; consumers needing freshness resolve them
        // again under their own policy. Confirmation here is an application assertion.
        ArgumentNullException.ThrowIfNull(memory);
        ContextPolicies.ValidateScope(memory.Scope);
        if (memory.MemoryId == Guid.Empty || string.IsNullOrWhiteSpace(memory.Content) ||
            memory.Sources.IsDefault || !Enum.IsDefined(memory.Status) || memory.Revision < 0 ||
            (memory.Status == MemoryStatus.Confirmed && memory.Sources.IsEmpty))
            throw new ArgumentException("Memory needs valid content, status and provenance.");
        if (memory.Scope.SessionId.HasValue)
        {
            if (!TryFind(memory.Scope.SessionId.Value, out var session) || !ContextPolicies.Matches(memory.Scope, session))
                throw new ArgumentException("Memory scope does not match its session.");
        }
        foreach (var source in memory.Sources)
        {
            if (source is null || !_sessions.TryGetValue(source.SessionId, out var slot))
                throw new ArgumentException("Memory provenance does not resolve in its scope.");
            var state = Volatile.Read(ref slot.State);
            if (!ContextPolicies.Matches(memory.Scope, state.Session) ||
                !state.Session.Anchors.TryGetValue(source.AnchorId, out var anchor))
                throw new ArgumentException("Memory provenance does not resolve in its scope.");
            if (!state.Locations.ContainsKey(anchor.StartEntryId) || !state.Locations.ContainsKey(anchor.EndEntryId) ||
                (anchor.PinnedRevision.HasValue && anchor.PinnedRevision != state.Session.Revision))
                throw new ArgumentException("Memory provenance target is unavailable.");
        }
    }

    public ILLMContextReadLease OpenRead(Guid id)
    {
        if (!_sessions.TryGetValue(id, out var slot)) throw new KeyNotFoundException("Session not found.");
        // Capture each immutable domain once, before retention admission. A writer may advance
        // either root while we wait; the eventual lease still represents these captured roots,
        // not an implicit refresh or an atomic transaction spanning both domains.
        var session = Volatile.Read(ref slot.State);
        if (session.Session.Status == SessionStatus.Expired) throw new InvalidOperationException("Session expired.");
        var memory = Volatile.Read(ref _memory);
        var now = _options.TimeProvider.GetUtcNow();
        lock (_resources)
        {
            long start = Stopwatch.GetTimestamp();
            while (true)
            {
                // Recompute after EVERY wake: another lease may have released or acquired
                // these roots while Monitor.Wait yielded the accounting gate.
                long extra = (_retained.ContainsKey(session) ? 0 : session.EstimatedBytes) +
                             (_retained.ContainsKey(memory) ? 0 : memory.EstimatedBytes);
                if (_activeBytes + _retainedBytes + extra <= _options.EstimatedResidentByteBudget &&
                    _retainedBytes + extra <= _options.MaximumEstimatedRetainedBytes &&
                    _reads < _options.MaximumRetainedReads)
                    break;
                var remaining = _options.AdmissionTimeout - Stopwatch.GetElapsedTime(start);
                if (remaining <= TimeSpan.Zero) throw new InvalidOperationException("Read-retention budget exhausted.");
                Monitor.Wait(_resources, remaining);
            }
            Retain(session, session.EstimatedBytes);
            Retain(memory, memory.EstimatedBytes);
            _reads++;
        }
        return new ContextReadLease(session, memory, now, () => Release(session, memory), _options.IndexingMode);
    }

    // The full-root charge is intentionally conservative: immutable sharing is not deduplicated
    // across DIFFERENT revisions. Multiple leases on the SAME root are deduplicated by identity.
    // This is an admission estimate, not the CLR's live-byte count; raw TryFind roots can escape
    // our lease accounting and the documentation never claims a hard process-memory ceiling.
    private void Retain(object root, long bytes)
    {
        _retained.TryGetValue(root, out var old);
        _retained[root] = (bytes, old.Count + 1);
        if (old.Count == 0) _retainedBytes += bytes;
    }

    private void Release(ContextState session, MemoryState memory)
    {
        lock (_resources)
        {
            Drop(session);
            Drop(memory);
            _reads--;
            // Budget waiters include readers, writers, and output admission. Wake all so each
            // can recheck its own predicate; a pulse is not a reservation or fairness guarantee.
            Monitor.PulseAll(_resources);
        }
        void Drop(object root)
        {
            var old = _retained[root];
            if (old.Count == 1) { _retained.Remove(root); _retainedBytes -= old.Bytes; }
            else _retained[root] = (old.Bytes, old.Count - 1);
        }
    }

    /// <summary>
    /// Called only while holding _resources. Recheck predicates after every wake because
    /// another operation can consume released capacity first. Negative active deltas allow
    /// shrinking publications; the budget describes estimates, not transient preparation memory.
    /// </summary>
    private bool WaitForBudget(long activeDelta, long retainedDelta, bool additionalRead)
    {
        long start = Stopwatch.GetTimestamp();
        while (checked(_activeBytes + _retainedBytes + activeDelta + retainedDelta) > _options.EstimatedResidentByteBudget ||
               checked(_retainedBytes + retainedDelta) > _options.MaximumEstimatedRetainedBytes ||
               (additionalRead && _reads >= _options.MaximumRetainedReads))
        {
            var remaining = _options.AdmissionTimeout - Stopwatch.GetElapsedTime(start);
            if (remaining <= TimeSpan.Zero) return false;
            Monitor.Wait(_resources, remaining);
        }
        return true;
    }

    public IDisposable RetainOutput(long bytes)
    {
        // Projections can own text/objects beyond captured roots, so charge output separately.
        // It is already materialized by the bridge; rejection releases roots but cannot prevent
        // the transient allocation that produced these values.
        lock (_resources)
        {
            if (!WaitForBudget(0, bytes, additionalRead: false))
                throw new InvalidOperationException("Projected-view budget exhausted.");
            _retainedBytes = checked(_retainedBytes + bytes);
            _viewBytes = checked(_viewBytes + bytes);
        }
        return new OutputRetention(() =>
        {
            lock (_resources)
            {
                _retainedBytes -= bytes;
                _viewBytes -= bytes;
                Monitor.PulseAll(_resources);
            }
        });
    }

    private sealed class OutputRetention(Action release) : IDisposable
    {
        private Action? _release = release;
        public void Dispose() => Interlocked.Exchange(ref _release, null)?.Invoke();
    }

    public LLMContextStatistics Statistics()
    {
        // Synchronize accounting fields, not every independent session read/publication.
        // This is operational telemetry; callers must not use it as a transactional state capture.
        lock (_resources)
            return new(_sessions.Count, _activeBytes, _retainedBytes, _reads, _memory.Revision,
                _published, _segments, _rewrittenBytes, _viewBytes, _indexing?.PendingCount ?? 0,
                _indexing?.ReservedBytes ?? 0, _indexing?.Completed ?? 0, _indexing?.Discarded ?? 0)
            {
                Execution = _execution?.Snapshot(),
                EstimatedPreparationBytes = _preparationBytes,
                EstimatedSynchronizationReserveBytes = _options.PartitionedIndex?.RecoveryBytes ?? 0,
                PendingSynchronizations = _synchronizations.Count
            };
    }

    public void Dispose()
    {
        StopPartitionSynchronization();
        _indexing?.Dispose();
        _execution?.Dispose();
        // The bridge has drained owner operations before calling here. Do not clear _retained
        // or reset read/output charges: escaped handles still need their matching release
        // callbacks and remain usable after the directory and active catalog are dropped.
        _sessions.Clear();
        lock (_resources)
        {
            _memory = MemoryState.Empty;
            _seenSessions.Clear();
            _activeBytes = 0;
            Monitor.PulseAll(_resources);
        }
    }

    private static long MemoryBytes(ContextMemory memory) =>
        checked(256L + 2L * memory.Content.Length + 48L * memory.Sources.Length);
    private static bool IsValidation(Exception error) => error is ArgumentException or OverflowException;
    private static IContextMutationResult Result(ContextMutationStatus status, long revision, string? error = null) =>
        new ContextMutationResult(status, revision, error, []);
}
