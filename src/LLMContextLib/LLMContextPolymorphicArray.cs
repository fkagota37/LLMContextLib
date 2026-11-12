// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections;
using System.Collections.Immutable;

namespace LLMContextLib;

/// <summary>
/// The single owning bridge. The lifecycle gate only fences operations against disposal;
/// concurrent operations share admission and the realization owns per-session publication.
/// Consumers never receive the storage or a writable top-level session array.
/// </summary>
internal sealed class LLMContextPolymorphicArray(ILLMContextStorage storage, LLMContextOptions options) : ILLMContextPolymorphicArray
{
    private readonly ReaderWriterLockSlim _lifetime = new();
    private bool _disposed;

    // Shared lifetime admission lets unrelated operations overlap. This is not a data lock:
    // storage owns publication gates, and a read lease outlives this short owner operation.
    // Holding the gate across callbacks also makes callback reentry/disposal unsupported.
    private T Run<T>(Func<T> action)
    {
        _lifetime.EnterReadLock();
        try { ObjectDisposedException.ThrowIf(_disposed, this); return action(); }
        finally { _lifetime.ExitReadLock(); }
    }

    public bool TryFind(Guid key, out LLMSessionContext value)
    {
        _lifetime.EnterReadLock();
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return storage.TryFind(key, out value);
        }
        finally { _lifetime.ExitReadLock(); }
    }

    public IContextMutationResult CreateSession(LLMSessionContext session) => Run(() => storage.Create(session));
    public IContextMutationResult RemoveSession(Guid sessionId, long expectedRevision) =>
        Run(() => storage.Remove(sessionId, expectedRevision));
    public IContextMutationResult Apply(ContextChangeSet changes) => Run(() => storage.Apply(changes));
    public IContextMutationResult ApplyMemory(MemoryChangeSet changes) => Run(() => storage.ApplyMemory(changes));
    public ILLMContextReadLease OpenRead(Guid sessionId) => Run(() => storage.OpenRead(sessionId));
    public LLMContextStatistics GetStatistics() => Run(storage.Statistics);

    public ILLMContextView<T> OpenView<T>(ILLMContextViewDefinition<T> definition)
    {
        ArgumentNullException.ThrowIfNull(definition);
        if (definition.MaximumResults < 0 || definition.MaximumResults > options.MaximumViewResults)
            throw new ArgumentOutOfRangeException(nameof(definition));
        return Run(() =>
        {
            var lease = storage.OpenRead(definition.SessionId);
            try
            {
                // First capture, then evaluate against ONLY that lease. Take bounds yielded
                // output, not work inside Evaluate or before its first yield (such as sorting).
                // Materialization happens before output admission, so rejection is not an
                // allocation-free path and cannot promise a hard transient-memory ceiling.
                var items = definition.Evaluate(lease).Take(definition.MaximumResults).ToImmutableArray();
                long bytes = 0;
                foreach (var item in items)
                {
                    long estimate = options.ProjectionSizeEstimator(item);
                    if (estimate <= 0) throw new ArgumentException("Projection size estimates must be positive.");
                    bytes = checked(bytes + estimate);
                }
                // The view takes ownership of BOTH retentions: its captured root lease and
                // the separate output charge. If evaluation, estimating, or output admission
                // fails first, the catch releases the lease and no view escapes to the caller.
                return (ILLMContextView<T>)new ContextView<T>(lease, items, storage.RetainOutput(bytes));
            }
            catch { lease.Dispose(); throw; }
        });
    }

    public void Dispose()
    {
        // Wait for in-flight owner calls, not for escaped read/view lifetimes. Those handles
        // own managed immutable roots and can finish after active storage has been cleared.
        _lifetime.EnterWriteLock();
        try
        {
            if (_disposed) return;
            _disposed = true;
            storage.Dispose();
        }
        finally { _lifetime.ExitWriteLock(); }
        // Do not dispose the admission lock itself: later calls must reliably throw the
        // client's ObjectDisposedException, including callers racing with shutdown.
    }

    /// <summary>
    /// Owns a materialized membership snapshot plus its two accounting lifetimes. Clearing
    /// items on disposal avoids retaining the projection merely because a disposed view escapes.
    /// Projected objects are not cloned or deep-frozen; custom projection immutability is a caller duty.
    /// </summary>
    private sealed class ContextView<T> : ILLMContextView<T>
    {
        private ILLMContextReadLease? _lease;
        private ImmutableArray<T> _items;
        private readonly IDisposable _output;
        internal ContextView(ILLMContextReadLease lease, ImmutableArray<T> items, IDisposable output)
            => (_lease, _items, _output) = (lease, items, output);
        private void Check() => ObjectDisposedException.ThrowIf(Volatile.Read(ref _lease) is null, this);
        public long SessionRevision { get { Check(); return _lease!.Session.Revision; } }
        public long MemoryRevision { get { Check(); return _lease!.MemoryRevision; } }
        public int Count { get { Check(); return _items.Length; } }
        public T this[int index] { get { Check(); return _items[index]; } }
        public IEnumerator<T> GetEnumerator()
        {
            Check();
            foreach (var item in _items) { Check(); yield return item; }
        }
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
        public void Dispose()
        {
            // Atomically claim cleanup once. Output and read charges are independent; release
            // the read in finally so a failure in one cleanup cannot strand the other charge.
            var lease = Interlocked.Exchange(ref _lease, null);
            if (lease is null) return;
            _items = [];
            try { _output.Dispose(); }
            finally { lease.Dispose(); }
        }
    }
}
