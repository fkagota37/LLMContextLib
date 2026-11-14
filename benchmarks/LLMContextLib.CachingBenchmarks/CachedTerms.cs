// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using BitFaster.Caching;
using BitFaster.Caching.Lfu;
using BitFaster.Caching.Lru;
using BitFaster.Caching.Scheduler;

namespace LLMContextLib.CachingBenchmarks;

/// <summary>
/// Experimental, owner-scoped memoization of EXACT text to the existing lexical-policy result.
/// This is not a tokenizer replacement, global cache, or production resource-admission layer.
/// Values are ordinary immutable arrays: eviction never invalidates an escaped result, but
/// neither can eviction release arrays still retained by session roots/callers.
/// Stop/join borrowers before disposal. The experiment does not model concurrent shutdown.
/// </summary>
internal sealed class CachedTerms : IDisposable
{
    internal const int Capacity = 64;
    internal const int MaximumCacheableCharacters = 8192;
    private ICache<string, ImmutableArray<string>>? _cache;
    private readonly Func<string, ImmutableArray<string>> _factory;
    private bool _disposed;
    private long _computations;
    internal string Policy { get; }
    internal long Computations => Interlocked.Read(ref _computations);

    internal CachedTerms(string policy)
    {
        Policy = policy;
        _factory = Compute;
        _cache = policy switch
        {
            "Uncached" => null,
            "Lru" => new ConcurrentLru<string, ImmutableArray<string>>(Capacity),
            // Foreground scheduling intentionally differs from the default thread-pool LFU.
            // It makes maintenance visible on the measured thread and leaves no asynchronous
            // helper work after the experiment. This is NOT a benchmark of default LFU.
            "LfuForeground" => new ConcurrentLfu<string, ImmutableArray<string>>(
                4, Capacity, new ForegroundScheduler(), StringComparer.Ordinal),
            _ => throw new ArgumentException("Unknown policy.", nameof(policy))
        };
    }

    internal ImmutableArray<string> Get(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        ObjectDisposedException.ThrowIf(_disposed, this);
        // A count limit alone does not bound retained bytes for arbitrary string keys.
        // Oversized input still follows the lexical policy but is never admitted to the memo.
        // Preparation remains transient allocation; this is not a maximum-input-size policy.
        return _cache is null || text.Length > MaximumCacheableCharacters
            ? Compute(text) : _cache.GetOrAdd(text, _factory);
    }

    private ImmutableArray<string> Compute(string text)
    {
        // The uncached control pays the SAME counter increment. Sequential factory executions
        // distinguish hits from misses; concurrent GetOrAdd may compute a value more than once.
        Interlocked.Increment(ref _computations);
        return ContextPolicies.Terms(text);
    }

    internal void Maintain()
    {
        if (_cache is ConcurrentLfu<string, ImmutableArray<string>> lfu) lfu.DoMaintenance();
    }

    /// <summary>
    /// Quiescent, live-membership estimate only: key/string/array payload plus 256 bytes per
    /// memo membership. It is not a measured node size, byte-admission guarantee, or estimate
    /// of every LFU policy buffer/retired node. Actual owner heap is measured separately.
    /// Even shared strings are charged in full. Production integration would need separate
    /// cache-budget reservations and accounting for values retained outside the memo.
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    internal CacheFootprint Snapshot()
    {
        Maintain();
        int count = 0;
        long bytes = 0, keyBytes = 0;
        if (_cache is not null)
            foreach (var pair in _cache)
            {
                count++;
                long key = checked(32L + 2L * pair.Key.Length);
                keyBytes = checked(keyBytes + key);
                bytes = checked(bytes + 256 + key + 128 + 8L * pair.Value.Length);
                foreach (string word in pair.Value) bytes = checked(bytes + 32 + 2L * word.Length);
            }
        return new(count, keyBytes, bytes);
    }

    internal int Count => _cache?.Count ?? 0;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Maintain();
        _cache?.Clear();
        Maintain();
        _cache = null;
    }
}

internal sealed record CacheFootprint(int Count, long EstimatedKeyBytes, long EstimatedMembershipBytes);
