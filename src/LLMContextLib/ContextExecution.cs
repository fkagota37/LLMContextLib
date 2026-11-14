// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;

namespace LLMContextLib;

/// <summary>Deterministic entry-index routing; no choice changes exact-search semantics.</summary>
public enum ContextIndexingStrategy
{
    /// <summary>Preserve the options: synchronous unless DeferredIndexing is configured.</summary>
    Configured,
    /// <summary>Fully index every changed entry before publication.</summary>
    Synchronous,
    /// <summary>
    /// Consider deferred indexing only for new entries above the character threshold.
    /// Replacements retain synchronous term diffing; observed backlog pressure selects synchronous work.
    /// </summary>
    AppendOptimized
}

/// <summary>Preparation scheduling; strict expected revisions apply in every mode.</summary>
public enum ContextPreparationStrategy
{
    /// <summary>Preserve the existing preparation configuration.</summary>
    Configured,
    /// <summary>Prepare outside the session gate; competing writers may discard prepared work.</summary>
    Speculative,
    /// <summary>Experimental: prepare under the session gate, trading wasted work for blocking.</summary>
    Serialized
}

/// <summary>Opt-in deterministic routing, pinned at owner construction, not an adaptive predictor.</summary>
public sealed record ContextExecutionOptions
{
    /// <summary>Index-maintenance selection. AppendOptimized requires DeferredIndexing options.</summary>
    public ContextIndexingStrategy Indexing { get; init; }
    /// <summary>Preparation scheduling; readers never take the writer gate.</summary>
    public ContextPreparationStrategy Preparation { get; init; }
    /// <summary>Minimum formatted UTF-16 length considered by AppendOptimized.</summary>
    public int MinimumDeferredCharacters { get; init; } = 8192;

    internal void Validate(LLMContextOptions options)
    {
        if (!Enum.IsDefined(Indexing) || !Enum.IsDefined(Preparation) || MinimumDeferredCharacters <= 0)
            throw new ArgumentOutOfRangeException(nameof(ContextExecutionOptions));
        if (Indexing == ContextIndexingStrategy.AppendOptimized && options.DeferredIndexing is null)
            throw new ArgumentException("AppendOptimized requires DeferredIndexing limits.", nameof(options));
    }
}

/// <summary>
/// Owner-wide execution attribution, including speculative/rejected attempts. Counters are
/// observational, not a transactional capture, a latency measurement, or per-session history.
/// </summary>
public sealed record ContextExecutionStatistics
{
    /// <summary>Selected full-term collector; prefix scans keep the native bounded scanner.</summary>
    public string TermCollector { get; init; } = "";
    /// <summary>Selected memo provider, or None.</summary>
    public string TermMemo { get; init; } = "";
    /// <summary>Configured entry-index router.</summary>
    public ContextIndexingStrategy Indexing { get; init; }
    /// <summary>Effective preparation mode.</summary>
    public ContextPreparationStrategy Preparation { get; init; }
    /// <summary>Fixed execution infrastructure plus memo reservation, included in active bytes.</summary>
    public long EstimatedReservedBytes { get; init; }
    /// <summary>Live memo memberships at observation time; not arrays retained by roots.</summary>
    public int MemoEntries { get; init; }
    /// <summary>Full term collections, including background work but excluding prefix scans.</summary>
    public long TermCollections { get; init; }
    /// <summary>Eligible exact-text lookups returning complete terms.</summary>
    public long MemoHits { get; init; }
    /// <summary>Eligible exact-text lookups missing complete terms.</summary>
    public long MemoMisses { get; init; }
    /// <summary>Inputs too long even to attempt a memo lookup.</summary>
    public long MemoBypasses { get; init; }
    /// <summary>Computed values not retained because they exceeded the memo's per-entry allowance.</summary>
    public long MemoAdmissionBypasses { get; init; }
    /// <summary>Entry preparations completed synchronously, including memo hits.</summary>
    public long SynchronousEntries { get; init; }
    /// <summary>Entry preparations producing pending indexes; not necessarily published.</summary>
    public long DeferredEntries { get; init; }
    /// <summary>AppendOptimized selections falling back because observed resources lacked headroom.</summary>
    public long DeferredCapacityFallbacks { get; init; }
    /// <summary>Apply attempts selecting speculative preparation.</summary>
    public long SpeculativePreparations { get; init; }
    /// <summary>Apply attempts selecting serialized preparation.</summary>
    public long SerializedPreparations { get; init; }
}

// Only maintained friend adapters implement these private execution seams. They never own
// roots, mutate storage, or escape into captured reads. Queries keep the canonical lexical policy.
internal interface IContextTermCollector
{
    string Name { get; }
    ImmutableArray<string> Collect(string text, CancellationToken cancellationToken);
    ImmutableArray<string> Complete(PendingEntryIndex pending, string? formattedText, CancellationToken cancellationToken) =>
        Collect(formattedText ?? ContextPolicies.Text(pending.Content), cancellationToken);
}

internal interface IContextTermMemo : IDisposable
{
    string Name { get; }
    int MaximumTextCharacters { get; }
    int Count { get; }
    bool TryGet(string text, out ImmutableArray<string> terms);
    bool TryAdd(string text, ImmutableArray<string> terms);
}

internal sealed class NativeContextTermCollector : IContextTermCollector
{
    public string Name => "Native";
    public ImmutableArray<string> Complete(PendingEntryIndex pending, string? formattedText, CancellationToken cancellationToken) =>
        ContextIndexTokenizer.Complete(pending, cancellationToken);
    public ImmutableArray<string> Collect(string text, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var terms = ContextPolicies.Terms(text);
        cancellationToken.ThrowIfCancellationRequested();
        return terms;
    }
}

internal sealed record ContextExecutionRecipe
{
    internal const long InfrastructureBytes = 512;
    internal ContextExecutionOptions Options { get; init; } = new();
    internal Func<IContextTermCollector> Collector { get; init; } = () => new NativeContextTermCollector();
    internal bool HasCustomCollector { get; init; }
    internal Func<IContextTermMemo>? Memo { get; init; }
    internal long MemoReservation { get; init; }
    internal long ReservedBytes => checked(InfrastructureBytes + MemoReservation);

    internal void Validate(LLMContextOptions options)
    {
        if (options.IndexingMode == ContextIndexingMode.ProducerOwned && (HasCustomCollector || Memo is not null))
            throw new ArgumentException("Producer-owned indexing cannot use text collectors or term memoization.", nameof(options));
        Options.Validate(options);
        long worker = Options.Indexing != ContextIndexingStrategy.Synchronous && options.DeferredIndexing is { } deferred
            ? ContextIndexTokenizer.InfrastructureReservation(deferred.MaximumPendingEntries) : 0;
        if (options.PartitionedIndex is { } partitions)
            worker = checked(worker + partitions.InfrastructureBytes + partitions.RecoveryBytes);
        if (MemoReservation < 0 ||
            MemoReservation > options.EstimatedResidentByteBudget - InfrastructureBytes - worker)
            throw new ArgumentOutOfRangeException(nameof(options), "Execution infrastructure and memo reservation exceed the resident budget.");
    }
}

internal sealed class ContextExecution : IDisposable
{
    private readonly ContextExecutionRecipe _recipe;
    private readonly LLMContextOptions _options;
    private readonly IContextTermCollector _collector;
    private readonly IContextTermMemo? _memo;
    private readonly Func<int, bool> _canDefer;
    private long _collections, _hits, _misses, _bypasses, _admissionBypasses;
    private long _synchronous, _deferred, _capacityFallbacks, _speculative, _serialized;

    internal ContextExecution(ContextExecutionRecipe recipe, LLMContextOptions options, Func<int, bool> canDefer)
    {
        (_recipe, _options, _canDefer) = (recipe, options, canDefer);
        _collector = recipe.Collector();
        _memo = recipe.Memo?.Invoke();
    }

    internal bool UsesDeferredIndexing =>
        _options.DeferredIndexing is not null && _recipe.Options.Indexing != ContextIndexingStrategy.Synchronous;

    internal void RecordSuppliedEntry() => Interlocked.Increment(ref _synchronous);

    internal bool SelectSerializedPreparation()
    {
        bool serialized = _recipe.Options.Preparation switch
        {
            ContextPreparationStrategy.Serialized => true,
            ContextPreparationStrategy.Speculative => false,
            _ => _options.SerializeSessionPreparation
        };
        if (serialized) Interlocked.Increment(ref _serialized);
        else Interlocked.Increment(ref _speculative);
        return serialized;
    }

    internal IndexPrefix PrepareEntry(ContextContent content, bool existing)
    {
        int characters = ContextIndexTokenizer.TextLength(content);
        string? text = MemoText(content, characters);
        if (TryMemo(text, out var cached))
        {
            Interlocked.Increment(ref _synchronous);
            return new(cached, characters, true);
        }

        bool defer = UsesDeferredIndexing;
        if (_recipe.Options.Indexing == ContextIndexingStrategy.AppendOptimized)
        {
            defer &= !existing && characters >= _recipe.Options.MinimumDeferredCharacters;
            if (defer && !_canDefer(characters))
            {
                Interlocked.Increment(ref _capacityFallbacks);
                defer = false;
            }
        }
        if (defer)
        {
            var prefix = ContextIndexTokenizer.Prefix(content, _options.DeferredIndexing!);
            if (!prefix.Complete) Interlocked.Increment(ref _deferred);
            else
            {
                Interlocked.Increment(ref _synchronous);
                Remember(text, prefix.Terms);
            }
            return prefix;
        }
        var terms = Collect(text ?? ContextPolicies.Text(content), CancellationToken.None);
        Remember(text, terms);
        Interlocked.Increment(ref _synchronous);
        return new(terms, characters, true);
    }

    internal ImmutableArray<string> Complete(PendingEntryIndex pending, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string? text = MemoText(pending.Content, ContextIndexTokenizer.TextLength(pending.Content));
        if (TryMemo(text, out var cached)) return cached;
        Interlocked.Increment(ref _collections);
        var terms = _collector.Complete(pending, text, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        Remember(text, terms);
        return terms;
    }

    internal ImmutableArray<string> Collect(string text, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _collections);
        return _collector.Collect(text, cancellationToken);
    }

    private string? MemoText(ContextContent content, int characters)
    {
        if (_memo is null) return null;
        if (characters <= _memo.MaximumTextCharacters) return ContextPolicies.Text(content);
        Interlocked.Increment(ref _bypasses);
        return null;
    }

    private bool TryMemo(string? text, out ImmutableArray<string> terms)
    {
        terms = default;
        if (text is null) return false;
        if (_memo!.TryGet(text, out terms)) { Interlocked.Increment(ref _hits); return true; }
        Interlocked.Increment(ref _misses);
        return false;
    }

    private void Remember(string? text, ImmutableArray<string> terms)
    {
        if (text is not null && !_memo!.TryAdd(text, terms))
            Interlocked.Increment(ref _admissionBypasses);
    }

    internal ContextExecutionStatistics Snapshot() => new()
    {
        TermCollector = _options.IndexingMode == ContextIndexingMode.ProducerOwned ? "ProducerOwned" : _collector.Name,
        TermMemo = _memo?.Name ?? "None",
        Indexing = _recipe.Options.Indexing,
        Preparation = _recipe.Options.Preparation == ContextPreparationStrategy.Configured
            ? (_options.SerializeSessionPreparation ? ContextPreparationStrategy.Serialized : ContextPreparationStrategy.Speculative)
            : _recipe.Options.Preparation,
        EstimatedReservedBytes = _recipe.ReservedBytes,
        MemoEntries = _memo?.Count ?? 0,
        TermCollections = Interlocked.Read(ref _collections),
        MemoHits = Interlocked.Read(ref _hits),
        MemoMisses = Interlocked.Read(ref _misses),
        MemoBypasses = Interlocked.Read(ref _bypasses),
        MemoAdmissionBypasses = Interlocked.Read(ref _admissionBypasses),
        SynchronousEntries = Interlocked.Read(ref _synchronous),
        DeferredEntries = Interlocked.Read(ref _deferred),
        DeferredCapacityFallbacks = Interlocked.Read(ref _capacityFallbacks),
        SpeculativePreparations = Interlocked.Read(ref _speculative),
        SerializedPreparations = Interlocked.Read(ref _serialized)
    };

    public void Dispose() => _memo?.Dispose();
}
