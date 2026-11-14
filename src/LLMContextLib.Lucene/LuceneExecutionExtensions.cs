// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using Lucene.Net.Analysis.TokenAttributes;
using Lucene.Net.Analysis.Util;
using Lucene.Net.Util;

namespace LLMContextLib;

/// <summary>Lexically equivalent Lucene-backed collection candidates, not language analyzers.</summary>
public enum LuceneTermCollection
{
    /// <summary>Deduplicate normalized slices using a call-local word-sized scratch buffer.</summary>
    RangeBuffer,
    /// <summary>Deduplicate words accumulated in a call-local CharTermAttribute.</summary>
    CharTerm
}

/// <summary>Optional Lucene composition; the core library has no Lucene dependency.</summary>
public static class LuceneExecutionExtensions
{
    /// <summary>
    /// Return a recipe using the selected full-term collector for entry and anchor indexing.
    /// Bounded prefixes and exact-query evaluation retain the native lexical implementation.
    /// Each Initialize creates its own collector; scratch buffers never escape a call.
    /// </summary>
    public static LLMContextFactoryBuilder WithLuceneTermCollection(
        this LLMContextFactoryBuilder builder, LuceneTermCollection collection = LuceneTermCollection.RangeBuffer)
    {
        ArgumentNullException.ThrowIfNull(builder);
        if (!Enum.IsDefined(collection)) throw new ArgumentOutOfRangeException(nameof(collection));
        return builder.WithTermCollector(() => new LuceneContextTermCollector(collection));
    }
}

internal sealed class LuceneContextTermCollector(LuceneTermCollection collection) : IContextTermCollector
{
    public string Name => collection == LuceneTermCollection.RangeBuffer ? "LuceneRangeBuffer" : "LuceneCharTerm";

    public ImmutableArray<string> Collect(string text, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(text);
        cancellationToken.ThrowIfCancellationRequested();
        var words = new CharArraySet(LuceneVersion.LUCENE_48, 0, ignoreCase: false);
        if (collection == LuceneTermCollection.CharTerm)
        {
            var word = new CharTermAttribute();
            for (int i = 0; i < text.Length; i++)
            {
                if ((i & 255) == 0) cancellationToken.ThrowIfCancellationRequested();
                char character = text[i];
                if (char.IsLetterOrDigit(character)) word.Append(char.ToLowerInvariant(character));
                else Flush();
            }
            Flush();

            void Flush()
            {
                if (word.Length == 0) return;
                words.Add(word.Buffer, 0, word.Length);
                word.SetEmpty();
            }
        }
        else
        {
            char[] buffer = [];
            int position = 0;
            while (position < text.Length)
            {
                if ((position & 255) == 0) cancellationToken.ThrowIfCancellationRequested();
                if (!char.IsLetterOrDigit(text[position])) { position++; continue; }
                int start = position;
                while (position < text.Length && char.IsLetterOrDigit(text[position]))
                {
                    if ((position & 255) == 0) cancellationToken.ThrowIfCancellationRequested();
                    position++;
                }
                int length = position - start;
                if (buffer.Length < length) buffer = new char[length];
                for (int i = 0; i < length; i++)
                {
                    if ((i & 255) == 0) cancellationToken.ThrowIfCancellationRequested();
                    buffer[i] = char.ToLowerInvariant(text[start + i]);
                }
                // The slice overload copies only a distinct key, never the mutable scratch array.
                words.Add(buffer, 0, length);
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        var result = ImmutableArray.CreateBuilder<string>(words.Count);
        foreach (string word in words) result.Add(word);
        result.Sort(StringComparer.Ordinal);
        cancellationToken.ThrowIfCancellationRequested();
        return result.MoveToImmutable();
    }
}
