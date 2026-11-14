// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text;
using Lucene.Net.Analysis.TokenAttributes;
using Lucene.Net.Analysis.Util;
using Lucene.Net.Util;

namespace LLMContextLib.TokenizationBenchmarks;

/// <summary>
/// Diagnostic alternatives, NOT production policies. Every method preserves the library's
/// UTF-16 char classification, per-char invariant casing, distinctness, ordinal ordering,
/// and immutable string-array output. No StandardAnalyzer, Unicode-policy change, pooled
/// buffer, intern pool, or cross-call cache participates. All scratch state is call-local.
/// </summary>
internal static class TermCollectors
{
    /// <summary>
    /// Sorting control: retain the production occurrence-by-occurrence string allocations,
    /// but sort an exact-capacity output builder rather than using LINQ materialization.
    /// This separates cheaper output construction from duplicate-aware token collection.
    /// </summary>
    internal static ImmutableArray<string> DirectSort(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var words = new HashSet<string>(StringComparer.Ordinal);
        var word = new StringBuilder();
        foreach (char character in text)
        {
            if (char.IsLetterOrDigit(character)) word.Append(char.ToLowerInvariant(character));
            else Flush();
        }
        Flush();
        if (words.Count == 0) return [];
        var result = ImmutableArray.CreateBuilder<string>(words.Count);
        foreach (string value in words) result.Add(value);
        result.Sort(StringComparer.Ordinal);
        return result.MoveToImmutable();

        void Flush()
        {
            if (word.Length == 0) return;
            words.Add(word.ToString());
            word.Clear();
        }
    }

    /// <summary>
    /// Prior duplicate-aware control: normalize one whole-input copy, deduplicate ranges
    /// over that copy, and allocate output strings only for the distinct ranges. Its
    /// whole-input allocation is deliberately included rather than hidden in setup.
    /// </summary>
    internal static ImmutableArray<string> NormalizedRanges(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        string normalized = string.Create(text.Length, text, static (destination, source) =>
        {
            for (int i = 0; i < destination.Length; i++)
                destination[i] = char.ToLowerInvariant(source[i]);
        });
        var words = new HashSet<WordRange>(new RangeComparer(normalized));
        int position = 0;
        while (position < text.Length)
        {
            while (position < text.Length && !char.IsLetterOrDigit(text[position])) position++;
            int start = position;
            while (position < text.Length && char.IsLetterOrDigit(text[position])) position++;
            if (position != start) words.Add(new(start, position - start));
        }
        if (words.Count == 0) return [];
        var result = ImmutableArray.CreateBuilder<string>(words.Count);
        foreach (var range in words) result.Add(normalized.Substring(range.Start, range.Length));
        result.Sort(StringComparer.Ordinal);
        return result.MoveToImmutable();
    }

    /// <summary>
    /// Use Lucene's growable term attribute as the scratch word. Add's SLICE overload checks
    /// for an existing key before copying a new char[]; duplicates allocate neither a key
    /// copy nor an output string. Never use Add(buffer): that overload takes ownership of
    /// the mutable array and would corrupt the set when the next word overwrites it.
    /// Lucene casing is disabled because our explicit char casing is the compatibility rule.
    /// </summary>
    internal static ImmutableArray<string> LuceneCharTerm(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var words = new CharArraySet(LuceneVersion.LUCENE_48, 0, ignoreCase: false);
        var word = new CharTermAttribute();
        foreach (char character in text)
        {
            if (char.IsLetterOrDigit(character)) word.Append(char.ToLowerInvariant(character));
            else Flush();
        }
        Flush();
        return Materialize(words);

        void Flush()
        {
            if (word.Length == 0) return;
            words.Add(word.Buffer, 0, word.Length);
            word.SetEmpty();
        }
    }

    /// <summary>
    /// Isolate the set from CharTermAttribute's incremental growth. Scan word bounds, size a
    /// call-local scratch array for that word, then fill it with the historical casing rule.
    /// The slice Add overload safely copies only distinct keys. This avoids a normalized
    /// whole-input copy, but buffer growth and distinct-key char[] copies still cost memory.
    /// </summary>
    internal static ImmutableArray<string> LuceneRangeBuffer(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var words = new CharArraySet(LuceneVersion.LUCENE_48, 0, ignoreCase: false);
        char[] buffer = [];
        int position = 0;
        while (position < text.Length)
        {
            while (position < text.Length && !char.IsLetterOrDigit(text[position])) position++;
            int start = position;
            while (position < text.Length && char.IsLetterOrDigit(text[position])) position++;
            int length = position - start;
            if (length == 0) continue;
            if (buffer.Length < length) buffer = new char[length];
            for (int i = 0; i < length; i++)
                buffer[i] = char.ToLowerInvariant(text[start + i]);
            words.Add(buffer, 0, length);
        }
        return Materialize(words);
    }

    /// <summary>
    /// The set owns char[] keys only during this call. Enumeration converts each DISTINCT
    /// key to one string, then exact-capacity sorting transfers the output array. Neither the
    /// set, its key arrays, nor the scratch buffer escapes in the returned immutable result.
    /// This intentionally measures the string-array contract, not just token-stream traversal.
    /// </summary>
    private static ImmutableArray<string> Materialize(CharArraySet words)
    {
        if (words.Count == 0) return [];
        var result = ImmutableArray.CreateBuilder<string>(words.Count);
        foreach (string word in words) result.Add(word);
        result.Sort(StringComparer.Ordinal);
        return result.MoveToImmutable();
    }

    private readonly record struct WordRange(int Start, int Length);

    private sealed class RangeComparer(string text) : IEqualityComparer<WordRange>
    {
        public bool Equals(WordRange left, WordRange right) =>
            text.AsSpan(left.Start, left.Length).SequenceEqual(text.AsSpan(right.Start, right.Length));
        public int GetHashCode(WordRange range) =>
            string.GetHashCode(text.AsSpan(range.Start, range.Length), StringComparison.Ordinal);
    }
}
