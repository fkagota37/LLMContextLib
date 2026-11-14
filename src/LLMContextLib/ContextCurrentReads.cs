// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;

namespace LLMContextLib;

/// <summary>Short-lived lazy reads through the same owning client.</summary>
public static class ContextCurrentReads
{
    /// <summary>
    /// Recommended synchronous read scope. The first read captures a lease; all subsequent
    /// reads in this callback use that lease. No access means no capture. Completion or failure
    /// releases the lease and clears references. Do not retain, dispose, concurrently use, or
    /// start asynchronous work against the borrowed read. Returned immutable values may escape,
    /// but their memory then remains the caller's responsibility. Writes still require revisions.
    /// </summary>
    public static void WithCurrent(this ILLMContextPolymorphicArray owner, Guid sessionId,
        Action<ILLMContextReadLease> consume)
    {
        ArgumentNullException.ThrowIfNull(owner);
        ArgumentNullException.ThrowIfNull(consume);
        using var scope = new CurrentRead(() => owner.OpenRead(sessionId));
        consume(scope);
    }

    private sealed class CurrentRead(Func<ILLMContextReadLease> open) : ILLMContextReadLease
    {
        private Func<ILLMContextReadLease>? _open = open;
        private ILLMContextReadLease? _read;
        private ILLMContextReadLease Read
        {
            get
            {
                ObjectDisposedException.ThrowIf(_open is null, this);
                return _read ??= _open();
            }
        }

        public ContextIndexingMode IndexingMode => Read.IndexingMode;
        public LLMSessionContext Session => Read.Session;
        public long MemoryRevision => Read.MemoryRevision;
        public ContextIndexStatus IndexStatus => Read.IndexStatus;
        public bool TryFindEntry(Guid entryId, out ContextEntry entry) => Read.TryFindEntry(entryId, out entry);
        public ImmutableArray<ContextEntry> ReadRange(long fromSequence, int count) => Read.ReadRange(fromSequence, count);
        public ContextPage ReadPage(ContextCursor? cursor, int count) => Read.ReadPage(cursor, count);
        public ImmutableArray<ContextSearchHit> Search(string query, int limit) => Read.Search(query, limit);
        public ImmutableArray<ContextSearchHit> SearchKeys(ContextIndexKeys keys, int limit) => Read.SearchKeys(keys, limit);
        public ContextIndexedSearchResult SearchIndexed(string query, int limit) => Read.SearchIndexed(query, limit);
        public AnchorResolution ResolveAnchor(Guid anchorId) => Read.ResolveAnchor(anchorId);
        public ImmutableArray<ContextMemory> GetApplicableMemory(ImmutableArray<MemoryScope> scopes) =>
            Read.GetApplicableMemory(scopes);

        public void Dispose()
        {
            _open = null;
            var read = _read;
            _read = null;
            read?.Dispose();
        }
    }
}
