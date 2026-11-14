// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Threading.Channels;

namespace LLMContextLib;

internal sealed partial class SegmentedContextStorage
{
    // Jobs retain only one content/prefix, never a captured session root or slot. Removal of
    // a session must not leave its whole graph alive through an uncharged queue reference.
    private sealed record IndexWork(Guid SessionId, Guid EntryId, PendingEntryIndex Pending);

    private static IReadOnlyList<IndexWork> NewIndexWork(ContextState next, ContextState? previous)
    {
        if (next.PendingIndexes.IsEmpty) return Array.Empty<IndexWork>();
        var result = new List<IndexWork>();
        foreach (var (id, pending) in next.PendingIndexes)
            if (pending.Error is null && (previous is null ||
                !previous.PendingIndexes.TryGetValue(id, out var old) || !ReferenceEquals(old, pending)))
                result.Add(new(next.Session.SessionId, id, pending));
        return result;
    }

    private static long WorkBytes(IReadOnlyList<IndexWork> work)
    {
        if (work.Count == 0) return 0;
        long bytes = 0;
        foreach (var item in work) bytes = checked(bytes + item.Pending.ReservedWorkBytes);
        return bytes;
    }

    public Task WaitForIndexingAsync(Guid id, long revision, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_indexing is not null) return _indexing.WaitAsync(id, revision, cancellationToken);
        if (!_sessions.TryGetValue(id, out var slot)) throw new KeyNotFoundException("Session not found.");
        if (Volatile.Read(ref slot.State).Session.Revision != revision)
            throw new InvalidOperationException("Session revision changed while waiting for indexing.");
        return Task.CompletedTask;
    }

    private bool IsCurrentIndexWork(IndexWork work)
    {
        // Do not return/store the root in the asynchronous worker's state machine.
        return _sessions.TryGetValue(work.SessionId, out var slot) &&
            Volatile.Read(ref slot.State).PendingIndexes.TryGetValue(work.EntryId, out var pending) &&
            ReferenceEquals(pending, work.Pending);
    }

    private bool PublishIndexWork(IndexWork work, ImmutableArray<string> terms, string? error,
        CancellationToken cancellationToken)
    {
        if (!_sessions.TryGetValue(work.SessionId, out var slot)) return false;
        // Tokenization is outside the writer gate. Postings path-copy/publication is serialized
        // with content commits; it is not a hard-bounded-duration critical section.
        while (!Monitor.TryEnter(slot.Gate, 25)) cancellationToken.ThrowIfCancellationRequested();
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var current = Volatile.Read(ref slot.State);
            if (slot.Removed || !current.PendingIndexes.TryGetValue(work.EntryId, out var pending) ||
                !ReferenceEquals(pending, work.Pending)) return false;
            ContextState next;
            if (error is null)
            {
                var builder = new ContextStateBuilder(current, _options, execution: _execution);
                builder.CompleteEntryIndex(work.EntryId, pending, terms);
                next = builder.State;
            }
            else next = current with { PendingIndexes = current.PendingIndexes.SetItem(work.EntryId, pending with { Error = error }) };
            next = next with { IndexGeneration = checked(current.IndexGeneration + 1) };
            long delta = checked(next.EstimatedBytes - current.EstimatedBytes);
            if (delta > 0) throw new InvalidOperationException("Deferred index exceeded its reserved estimate.");
            lock (_resources)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Volatile.Write(ref slot.State, next);
                _activeBytes = checked(_activeBytes + delta);
                if (error is null) _indexing!.Completed++;
                _indexing!.Pulse();
                Monitor.PulseAll(_resources);
            }
            return true;
        }
        finally { Monitor.Exit(slot.Gate); }
    }

    /// <summary>
    /// One cancellable worker per opted-in owner. Counts/bytes include queued, running, and
    /// obsolete work until it is actually released. All accounting and pulses use _resources.
    /// Channels bound item count; the separate reservations bound estimated queued/work bytes.
    /// </summary>
    private sealed class DeferredIndexingCoordinator : IDisposable
    {
        private readonly SegmentedContextStorage _owner;
        private readonly DeferredIndexingOptions _options;
        private readonly Channel<IndexWork> _queue;
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _worker;
        private readonly Dictionary<Guid, int> _sessionJobs = [];
        private TaskCompletionSource _changed = NewSignal();
        private bool _disposed;
        private string? _failure;
        internal int PendingCount;
        internal long ReservedBytes, Completed, Discarded;

        internal DeferredIndexingCoordinator(SegmentedContextStorage owner, DeferredIndexingOptions options)
        {
            (_owner, _options) = (owner, options);
            owner._activeBytes = checked(owner._activeBytes +
                ContextIndexTokenizer.InfrastructureReservation(options.MaximumPendingEntries));
            _queue = Channel.CreateBounded<IndexWork>(new BoundedChannelOptions(options.MaximumPendingEntries)
            {
                SingleReader = true,
                AllowSynchronousContinuations = false,
                FullMode = BoundedChannelFullMode.Wait
            });
            // An owner lifetime must not retain the initializing caller's AsyncLocal/request
            // context. This also keeps internal mutation diagnostics out of worker execution.
            if (ExecutionContext.IsFlowSuppressed()) _worker = Task.Run(RunAsync);
            else
            {
                using var flow = ExecutionContext.SuppressFlow();
                _worker = Task.Run(RunAsync);
            }
        }

        internal bool CanReserve(IReadOnlyList<IndexWork> work) => work.Count == 0 ||
            (!_disposed && _failure is null && work.Count <= _options.MaximumPendingEntries - PendingCount &&
             WorkBytes(work) <= _options.MaximumEstimatedWorkBytes - ReservedBytes);

        internal bool CanReserveEntry(int characters) =>
            !_disposed && _failure is null && PendingCount < _options.MaximumPendingEntries &&
            ContextIndexTokenizer.WorkReservation(characters) <= _options.MaximumEstimatedWorkBytes - ReservedBytes;

        internal void Reserve(IReadOnlyList<IndexWork> work)
        {
            if (work.Count == 0) return;
            foreach (var item in work)
            {
                long bytes = item.Pending.ReservedWorkBytes;
                PendingCount++;
                ReservedBytes = checked(ReservedBytes + bytes);
                _owner._activeBytes = checked(_owner._activeBytes + bytes);
                _sessionJobs.TryGetValue(item.SessionId, out int count);
                _sessionJobs[item.SessionId] = count + 1;
                // Only admitted owner operations write. Total queued PLUS running <= capacity,
                // so there is space even if the single consumer has not started yet.
                if (!_queue.Writer.TryWrite(item)) throw new InvalidOperationException("Admitted index queue is unavailable.");
            }
        }

        private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal void Pulse()
        {
            var old = _changed;
            _changed = NewSignal();
            old.TrySetResult();
        }

        private Task? PendingWait(Guid id, long revision)
        {
            // A synchronous helper avoids hoisting an entire uncharged root across await.
            lock (_owner._resources)
            {
                ObjectDisposedException.ThrowIf(_disposed, _owner);
                if (!_owner._sessions.TryGetValue(id, out var slot)) throw new KeyNotFoundException("Session not found.");
                var state = Volatile.Read(ref slot.State);
                if (state.Session.Revision != revision)
                    throw new InvalidOperationException("Session revision changed while waiting for indexing.");
                if (_failure is not null) throw new InvalidOperationException(_failure);
                var status = state.IndexStatus;
                if (status.Error is not null) throw new InvalidOperationException(status.Error);
                return status.IsComplete && !_sessionJobs.ContainsKey(id) ? null : _changed.Task;
            }
        }

        internal async Task WaitAsync(Guid id, long revision, CancellationToken cancellationToken)
        {
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Task? pending = PendingWait(id, revision);
                if (pending is null) return;
                await pending.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
        }

        private async Task RunAsync()
        {
            try
            {
                while (await _queue.Reader.WaitToReadAsync(_stop.Token).ConfigureAwait(false))
                    ProcessAvailableWork();
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
            catch (Exception error)
            {
                lock (_owner._resources) { _failure = Message(error); Pulse(); }
                // No orphaned reservations after an unexpected worker-level failure.
                DrainQueuedWork();
            }
        }

        private void ProcessAvailableWork()
        {
            // Neither a job nor its computed terms may be hoisted across the next idle await.
            // An async enumerable's Current can also retain its last yielded job while idle.
            while (_queue.Reader.TryRead(out var work))
            {
                try
                {
                    if (!_owner.IsCurrentIndexWork(work)) { Discard(); continue; }
                    _owner._options.BeforeDeferredIndexing?.Invoke(_stop.Token);
                    if (!_owner.IsCurrentIndexWork(work)) { Discard(); continue; }
                    var terms = _owner._execution?.Complete(work.Pending, _stop.Token) ??
                        ContextIndexTokenizer.Complete(work.Pending, _stop.Token);
                    if (!_owner.PublishIndexWork(work, terms, null, _stop.Token)) Discard();
                }
                catch (OperationCanceledException) when (_stop.IsCancellationRequested) { throw; }
                catch (Exception error)
                {
                    if (!_owner.PublishIndexWork(work, [], Message(error), _stop.Token)) Discard();
                }
                finally { Release(work); }
            }
        }

        private void DrainQueuedWork()
        {
            while (_queue.Reader.TryRead(out var work)) Release(work);
        }

        private static string Message(Exception error) =>
            error.Message[..Math.Min(error.Message.Length, 160)];

        private void Discard()
        {
            lock (_owner._resources) Discarded++;
        }

        private void Release(IndexWork work)
        {
            lock (_owner._resources)
            {
                PendingCount--;
                ReservedBytes -= work.Pending.ReservedWorkBytes;
                _owner._activeBytes -= work.Pending.ReservedWorkBytes;
                int remaining = _sessionJobs[work.SessionId] - 1;
                if (remaining == 0) _sessionJobs.Remove(work.SessionId);
                else _sessionJobs[work.SessionId] = remaining;
                Pulse();
                Monitor.PulseAll(_owner._resources);
            }
        }

        public void Dispose()
        {
            lock (_owner._resources) { _disposed = true; Pulse(); }
            _stop.Cancel();
            _queue.Writer.TryComplete();
            _worker.GetAwaiter().GetResult();
            DrainQueuedWork();
            _stop.Dispose();
        }
    }
}
