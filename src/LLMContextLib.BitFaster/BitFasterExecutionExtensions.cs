// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using BitFaster.Caching.Lru;

namespace LLMContextLib;

/// <summary>
/// Exact-text memo bounds. The complete estimate is reserved from the owner's resident budget
/// even while empty. This is conservative admission accounting, not an actual heap ceiling.
/// </summary>
public sealed record BitFasterTermMemoOptions
{
    /// <summary>Maximum memberships; at least three for the three-segment LRU policy.</summary>
    public int Capacity { get; init; } = 64;
    /// <summary>Maximum formatted UTF-16 length eligible even for a lookup.</summary>
    public int MaximumTextCharacters { get; init; } = 8192;
    /// <summary>
    /// Total reserved estimate: 4096 + 512 * (Capacity + 1) infrastructure bytes, plus equally
    /// sized payload allowances for Capacity + 1 slots (including one in-flight insertion).
    /// Oversized values bypass admission rather than displacing an unbounded byte total.
    /// </summary>
    public long MaximumEstimatedBytes { get; init; } = 1024 * 1024;

    internal long InfrastructureBytes => checked(4096L + 512L * (Capacity + 1L));
    internal long EntryAllowance => (MaximumEstimatedBytes - InfrastructureBytes) / (Capacity + 1L);

    internal void Validate()
    {
        if (Capacity < 3 || MaximumTextCharacters <= 0 ||
            MaximumEstimatedBytes <= InfrastructureBytes || EntryAllowance < 160)
            throw new ArgumentOutOfRangeException(nameof(BitFasterTermMemoOptions), "Memo bounds must allow infrastructure and at least 160 payload bytes per slot.");
    }
}

/// <summary>Optional owner-private memoization, composed through the native factory.</summary>
public static class BitFasterExecutionExtensions
{
    /// <summary>
    /// Return a recipe with a fresh bounded ConcurrentLru per initialized owner. Only complete
    /// immutable term arrays are memoized; exact keys include the full formatted content.
    /// No background maintenance, process-global cache, or separate client lifetime is introduced.
    /// </summary>
    public static LLMContextFactoryBuilder WithBitFasterTermMemoization(
        this LLMContextFactoryBuilder builder, BitFasterTermMemoOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var selected = options ?? new();
        selected.Validate();
        return builder.WithTermMemo(selected.MaximumEstimatedBytes, () => new BitFasterContextTermMemo(selected));
    }
}

internal sealed class BitFasterContextTermMemo(BitFasterTermMemoOptions options) : IContextTermMemo
{
    private readonly object _writes = new();
    private ConcurrentLru<string, ImmutableArray<string>>? _cache =
        new(1, options.Capacity, StringComparer.Ordinal);

    public string Name => "BitFasterConcurrentLru";
    public int MaximumTextCharacters => options.MaximumTextCharacters;
    public int Count => Volatile.Read(ref _cache)?.Count ?? 0;

    public bool TryGet(string text, out ImmutableArray<string> terms)
    {
        var cache = Volatile.Read(ref _cache);
        if (cache is not null) return cache.TryGet(text, out terms);
        terms = default;
        return false;
    }

    public bool TryAdd(string text, ImmutableArray<string> terms)
    {
        long bytes = checked(32L + 2L * text.Length + ContextStateBuilder.EstimateEntryTermsBytes(terms));
        if (text.Length > options.MaximumTextCharacters || bytes > options.EntryAllowance) return false;
        // Bound simultaneous insertions, not tokenization or hits. A fixed per-slot allowance
        // avoids a byte-eviction index/global key registry and includes one transient new node.
        lock (_writes)
        {
            var cache = _cache;
            if (cache is null) return false;
            cache.GetOrAdd(text, static (_, value) => value, terms);
            return true;
        }
    }

    public void Dispose()
    {
        // The owner drains public calls and joins its worker first. Dropping the provider root
        // releases internal queue nodes as well as current dictionary memberships.
        lock (_writes) Interlocked.Exchange(ref _cache, null)?.Clear();
    }
}
