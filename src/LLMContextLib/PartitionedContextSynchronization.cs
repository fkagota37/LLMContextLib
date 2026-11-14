// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Diagnostics;

namespace LLMContextLib;

internal sealed partial class SegmentedContextStorage
{
    private readonly SemaphoreSlim _partitionWorker = new(1, 1);
    private readonly CancellationTokenSource _partitionStop = new();
    private readonly HashSet<Task<ContextIndexSynchronization>> _synchronizations = [];
    private long _preparationBytes;

    public Task<ContextIndexSynchronization> SynchronizeIndexAsync(Guid sessionId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_options.PartitionedIndex is null)
            throw new NotSupportedException("Enable partitioned indexing through the factory.");
        if (!_sessions.TryGetValue(sessionId, out var slot))
            throw new KeyNotFoundException("Session not found.");
        Task<ContextIndexSynchronization> task;
        lock (slot.Gate)
        {
            if (slot.Removed) throw new KeyNotFoundException("Session not found.");
            if (slot.Synchronizing) task = slot.Synchronization!.Task;
            else
            {
                var state = Volatile.Read(ref slot.State);
                if (!state.IndexPartitions.Values.Any(partition => !partition.Overrides.IsEmpty))
                    return Task.FromResult(new ContextIndexSynchronization(sessionId, slot.SynchronizationEpoch,
                        state.Session.Revision, 0, true));
                lock (_resources)
                {
                    if (_synchronizations.Count >= _options.PartitionedIndex.MaximumPendingSynchronizations)
                        return Task.FromResult(new ContextIndexSynchronization(sessionId, slot.SynchronizationEpoch,
                            state.Session.Revision, 0, false, "Synchronization backlog is full."));
                    var completion = new TaskCompletionSource<ContextIndexSynchronization>(
                        TaskCreationOptions.RunContinuationsAsynchronously);
                    slot.Synchronization = completion;
                    slot.SynchronizationEpoch = checked(slot.SynchronizationEpoch + 1);
                    slot.Synchronizing = true;
                    task = completion.Task;
                    _synchronizations.Add(task);
                    if (ExecutionContext.IsFlowSuppressed()) _ = Task.Run(() => SynchronizePartitions(slot, completion));
                    else
                    {
                        using var flow = ExecutionContext.SuppressFlow();
                        _ = Task.Run(() => SynchronizePartitions(slot, completion));
                    }
                }
            }
        }
        return cancellationToken.CanBeCanceled ? task.WaitAsync(cancellationToken) : task;
    }

    private async Task SynchronizePartitions(Slot slot, TaskCompletionSource<ContextIndexSynchronization> completion)
    {
        bool entered = false;
        ContextIndexSynchronization result;
        int compacted = 0;
        try
        {
            await _partitionWorker.WaitAsync(_partitionStop.Token).ConfigureAwait(false);
            entered = true;
            lock (slot.Gate)
                while (slot.Preparations != 0)
                {
                    _partitionStop.Token.ThrowIfCancellationRequested();
                    Monitor.Wait(slot.Gate, 25);
                }
            _options.BeforePartitionSynchronization?.Invoke(_partitionStop.Token);
            // This synchronous helper does not hoist roots/candidates across an await.
            compacted = CompactPartitions(slot, _partitionStop.Token);
            var state = Volatile.Read(ref slot.State);
            result = new(state.Session.SessionId, slot.SynchronizationEpoch, state.Session.Revision, compacted, true);
        }
        catch (Exception error)
        {
            var state = Volatile.Read(ref slot.State);
            result = new(state.Session.SessionId, slot.SynchronizationEpoch, state.Session.Revision, compacted, false,
                error.Message);
        }
        finally
        {
            if (entered) _partitionWorker.Release();
        }
        lock (slot.Gate)
        {
            // A completed task is a durable notification AFTER admission has reopened.
            slot.Synchronizing = false;
            Monitor.PulseAll(slot.Gate);
            lock (_resources)
            {
                _synchronizations.Remove(completion.Task);
                completion.TrySetResult(result);
                Monitor.PulseAll(_resources);
            }
        }
    }

    private int CompactPartitions(Slot slot, CancellationToken cancellationToken)
    {
        int compacted = 0;
        // Do not retain the pre-synchronization directory through every partition rebuild.
        // Session content is fenced, so segment IDs remain stable while derived roots change.
        long? after = null;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            long? nextId = NextDirtyPartition(slot, after);
            if (nextId is null) return compacted;
            CompactPartition(slot, nextId.Value, cancellationToken);
            after = nextId;
            compacted++;
        }
    }

    private static long? NextDirtyPartition(Slot slot, long? after)
    {
        if (slot.Removed) throw new InvalidOperationException("Session removed during synchronization.");
        long? next = null;
        foreach (var (id, partition) in Volatile.Read(ref slot.State).IndexPartitions)
            if ((after is null || id > after) && !partition.Overrides.IsEmpty && (next is null || id < next))
                next = id;
        return next;
    }

    private void CompactPartition(Slot slot, long id, CancellationToken cancellationToken)
    {
        var current = Volatile.Read(ref slot.State);
        var partition = current.IndexPartitions[id];
        var replacement = partition.Compact(cancellationToken);
        if (replacement.EstimatedBytes > _options.PartitionedIndex!.MaximumEstimatedPartitionBytes)
            throw new InvalidOperationException("Compacted partition exceeded its reserved limit.");
        var next = current with
        {
            IndexPartitions = current.IndexPartitions.SetItem(id, replacement),
            IndexGeneration = checked(current.IndexGeneration + 1),
            EstimatedBytes = checked(current.EstimatedBytes - partition.EstimatedBytes + replacement.EstimatedBytes)
        };
        lock (slot.Gate)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (slot.Removed) throw new InvalidOperationException("Session removed during synchronization.");
            lock (_resources)
            {
                Volatile.Write(ref slot.State, next);
                _activeBytes = checked(_activeBytes + next.EstimatedBytes - current.EstimatedBytes);
                Monitor.PulseAll(_resources);
            }
        }
    }

    private bool EnterPartitionAdmission(Slot slot, out long epoch, out bool synchronizing)
    {
        epoch = 0;
        synchronizing = false;
        var options = _options.PartitionedIndex!;
        long start = Stopwatch.GetTimestamp();
        var gateTimeout = options.WriteBehavior == ContextSynchronizationWriteBehavior.Wait
            ? options.SynchronizationWaitTimeout : _options.AdmissionTimeout;
        if (!Monitor.TryEnter(slot.Gate, gateTimeout))
        {
            synchronizing = Volatile.Read(ref slot.Synchronizing);
            return false;
        }
        try
        {
            while (slot.Synchronizing)
            {
                synchronizing = true;
                if (options.WriteBehavior == ContextSynchronizationWriteBehavior.Reject) return false;
                var remaining = options.SynchronizationWaitTimeout - Stopwatch.GetElapsedTime(start);
                if (remaining <= TimeSpan.Zero) return false;
                Monitor.Wait(slot.Gate, remaining);
            }
            epoch = slot.SynchronizationEpoch;
            synchronizing = false;
            slot.Preparations++;
            return true;
        }
        finally { Monitor.Exit(slot.Gate); }
    }

    private bool ReservePreparation(ContextChangeSet changes, out long reservation)
    {
        // Producer packets already contain their estimates. No tokenization or key traversal.
        // Include segment-reference copying, directory paths and every intermediate command,
        // not merely the final logical size after a shrink/grow transaction.
        long bytes = 4096;
        foreach (var change in changes.Changes)
        {
            bytes = checked(bytes + 8192L + 16L * _options.MaximumEntriesPerSegment);
            switch (change)
            {
                case AppendEntries append:
                    ContextStateBuilder.RequireInitialized(append.Entries);
                    foreach (var draft in append.Entries)
                    {
                        ArgumentNullException.ThrowIfNull(draft);
                        Add(draft.IndexKeys);
                    }
                    break;
                case ReplaceEntry replace:
                    Add(replace.IndexKeys);
                    break;
                case ReplaceSegment replace:
                    ContextStateBuilder.RequireInitialized(replace.Entries);
                    foreach (var entry in replace.Entries)
                    {
                        ArgumentNullException.ThrowIfNull(entry);
                        Add(entry.IndexKeys);
                    }
                    break;
                case PutAnchor put:
                    ArgumentNullException.ThrowIfNull(put.Anchor);
                    bytes = checked(bytes + 8 * ContextStateBuilder.AnchorBytes(put.Anchor));
                    break;
            }
        }
        reservation = bytes;
        if (bytes > _options.PartitionedIndex!.MaximumEstimatedPreparationBytes) return false;
        lock (_resources)
        {
            if (!WaitForBudget(bytes, 0, additionalRead: false)) return false;
            _activeBytes = checked(_activeBytes + bytes);
            _preparationBytes = checked(_preparationBytes + bytes);
            return true;
        }

        void Add(ContextIndexKeys? keys)
        {
            if (keys is null) throw new ArgumentException("Producer-owned entries require keys.");
            // A valid entry must fit its segment. Reserve that upper bound without invoking
            // producer estimators or walking payload/keys before capacity has been acquired.
            bytes = checked(bytes + 8192 + 2 * _options.MaximumEstimatedBytesPerSegment + 8 * keys.EstimatedBytes);
        }
    }

    private void ReleasePreparation(long bytes)
    {
        if (bytes == 0) return;
        lock (_resources)
        {
            _activeBytes -= bytes;
            _preparationBytes -= bytes;
            Monitor.PulseAll(_resources);
        }
    }

    private void StopPartitionSynchronization()
    {
        _partitionStop.Cancel();
        Task[] pending;
        lock (_resources) pending = _synchronizations.Cast<Task>().ToArray();
        Task.WhenAll(pending).GetAwaiter().GetResult();
        _partitionStop.Dispose();
        _partitionWorker.Dispose();
    }
}
