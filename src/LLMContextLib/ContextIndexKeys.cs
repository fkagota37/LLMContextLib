// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;

namespace LLMContextLib;

/// <summary>Determines who defines entry and anchor search memberships for an owner.</summary>
public enum ContextIndexingMode
{
    /// <summary>Preserve canonical text tokenization, including configured execution strategies.</summary>
    Text,
    /// <summary>Use complete opaque keys supplied by producers; never derive keys from content.</summary>
    ProducerOwned
}

/// <summary>
/// Immutable, producer-prepared search keys. Construction copies, ordinal-sorts and deduplicates
/// keys without tokenization, case folding, trimming, or checking their meaning against content.
/// Empty strings are valid keys; null keys are not. An empty collection explicitly indexes nothing.
/// </summary>
public sealed class ContextIndexKeys
{
    /// <summary>A reusable, explicitly empty index contribution.</summary>
    public static ContextIndexKeys Empty { get; } = new([]);

    /// <summary>Complete distinct keys, in ordinal order, safe to share between immutable commands.</summary>
    public ImmutableArray<string> Keys { get; }

    internal long EstimatedBytes { get; }

    /// <summary>Prepare this contribution independently before submitting a write or lookup.</summary>
    public ContextIndexKeys(IEnumerable<string> keys)
    {
        ArgumentNullException.ThrowIfNull(keys);
        var sorted = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var key in keys)
        {
            if (key is null) throw new ArgumentException("Index keys cannot be null.", nameof(keys));
            sorted.Add(key);
        }
        Keys = sorted.ToImmutableArray();
        EstimatedBytes = ContextStateBuilder.EstimateEntryTermsBytes(Keys);
    }
}
