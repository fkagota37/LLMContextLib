// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text;

namespace LLMContextLib;

/// <summary>
/// Opt-in deferred entry indexing. Foreground limits apply PER changed entry, not to an
/// entire transaction, admission wait, estimator callback, or wall-clock deadline.
/// Anchor descriptions remain synchronously indexed.
/// </summary>
public sealed record DeferredIndexingOptions
{
    /// <summary>Maximum foreground word occurrences, before deduplication.</summary>
    public int ForegroundWords { get; init; } = 128;
    /// <summary>Maximum foreground UTF-16 characters inspected, including separators.</summary>
    public int ForegroundCharacters { get; init; } = 8192;
    /// <summary>Owner-wide maximum queued PLUS running jobs, including superseded jobs.</summary>
    public int MaximumPendingEntries { get; init; } = 64;
    /// <summary>
    /// Conservative estimated queued/running payload and work reservations. This is also
    /// charged to the resident budget; it is not a hard GC heap or allocation ceiling.
    /// </summary>
    public long MaximumEstimatedWorkBytes { get; init; } = 8 * 1024 * 1024;

    internal void Validate()
    {
        if (ForegroundWords <= 0 || ForegroundCharacters <= 0 ||
            MaximumPendingEntries <= 0 || MaximumEstimatedWorkBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(DeferredIndexingOptions), "Indexing limits must be positive.");
    }
}

/// <summary>Index coverage of ONE immutable read generation, not a live progress subscription.</summary>
/// <param name="SessionRevision">Content revision captured by the lease.</param>
/// <param name="IndexGeneration">Derived-index generation; completion does not change content revision.</param>
/// <param name="PendingEntries">Entries not fully indexed, including failed entries.</param>
/// <param name="FailedEntries">Pending entries whose background attempt failed; exact search still works.</param>
/// <param name="Error">One bounded diagnostic message, or null; no automatic retry is implied.</param>
public sealed record ContextIndexStatus(
    long SessionRevision, long IndexGeneration, int PendingEntries, int FailedEntries = 0, string? Error = null)
{
    /// <summary>True only when every live entry in this captured root is fully indexed.</summary>
    public bool IsComplete => PendingEntries == 0;
}

/// <summary>Indexed-only hits and the coverage of their captured root. Partial coverage is explicit.</summary>
/// <param name="Hits">Ordered hits from published postings only.</param>
/// <param name="IndexStatus">Coverage metadata; open a new lease to observe later progress.</param>
public sealed record ContextIndexedSearchResult(
    ImmutableArray<ContextSearchHit> Hits, ContextIndexStatus IndexStatus);

internal sealed record PendingEntryIndex(
    ContextContent Content, ImmutableArray<string> PrefixTerms, int ResumeOffset,
    long ReservedIndexBytes, long ReservedWorkBytes, string? Error = null);

internal readonly record struct IndexPrefix(ImmutableArray<string> Terms, int ResumeOffset, bool Complete);

/// <summary>
/// Index the SAME character stream as Text without first copying a complete tool JSON payload.
/// A character cutoff drops an unfinished word and resumes at its start, never indexing a
/// fabricated partial token. The background pass seeds already-produced distinct terms.
/// </summary>
internal static class ContextIndexTokenizer
{
    internal static int TextLength(ContextContent content) => content switch
    {
        TextContent text => text.Text.Length,
        SummaryContent summary => summary.Text.Length,
        ToolCallContent call => checked(call.ToolName.Length + call.CallId.Length + call.ArgumentsJson.Length + 2),
        ToolResultContent result => checked(result.CallId.Length + result.ResultJson.Length + 1),
        _ => throw new ArgumentException("Only the immutable built-in content cases are admitted.", nameof(content))
    };

    // At most ceil(C/2) distinct nonempty words fit in C characters with separating characters.
    // Each contributes at most 40 bytes of retained-term membership and 160 of new posting/
    // bucket overhead, plus four bytes per character across the term and search-key charges.
    // Pending metadata and both copied/shared strings are conservatively charged in full.
    internal static long IndexReservation(int characters) =>
        checked(1024L + 200L * ((characters + 1L) / 2) + 4L * characters);

    internal static long WorkReservation(int characters) =>
        checked(512L + 8L * characters + IndexReservation(characters));

    // Include queue references and retained dictionary capacity/buckets, not only live jobs.
    internal static long InfrastructureReservation(int capacity) => checked(1024L + 128L * capacity);

    internal static IndexPrefix Prefix(ContextContent content, DeferredIndexingOptions options) =>
        Scan(content, 0, [], options.ForegroundWords, options.ForegroundCharacters, CancellationToken.None);

    internal static ImmutableArray<string> Complete(PendingEntryIndex pending, CancellationToken cancellationToken) =>
        Scan(pending.Content, pending.ResumeOffset, pending.PrefixTerms,
            int.MaxValue, int.MaxValue, cancellationToken).Terms;

    internal static ImmutableArray<string> Full(ContextContent content) =>
        Scan(content, 0, [], int.MaxValue, int.MaxValue, CancellationToken.None).Terms;

    private static IndexPrefix Scan(ContextContent content, int start, ImmutableArray<string> seed,
        int maximumWords, int maximumCharacters, CancellationToken cancellationToken)
    {
        var terms = new HashSet<string>(seed, StringComparer.Ordinal);
        var word = new StringBuilder();
        int position = 0, inspected = 0, occurrences = 0, wordStart = start;
        cancellationToken.ThrowIfCancellationRequested();
        foreach (string part in Parts(content))
        {
            if (position + (long)part.Length <= start)
            {
                position += part.Length;
                continue;
            }
            int offset = Math.Max(0, start - position);
            position += offset;
            for (int i = offset; i < part.Length; i++)
            {
                if (inspected == maximumCharacters)
                    return Result(word.Length == 0 ? position : wordStart, complete: false);
                if ((inspected & 255) == 0) cancellationToken.ThrowIfCancellationRequested();
                char character = part[i];
                inspected++;
                if (char.IsLetterOrDigit(character))
                {
                    if (word.Length == 0) wordStart = position;
                    word.Append(char.ToLowerInvariant(character));
                }
                else if (word.Length != 0)
                {
                    terms.Add(word.ToString());
                    word.Clear();
                    occurrences++;
                }
                position++;
                if (occurrences == maximumWords) return Result(position, complete: position == TextLength(content));
            }
        }
        if (word.Length != 0) terms.Add(word.ToString());
        return Result(position, complete: true);

        IndexPrefix Result(int resume, bool complete)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var sorted = terms.Order(StringComparer.Ordinal).ToImmutableArray();
            cancellationToken.ThrowIfCancellationRequested();
            return new(sorted, resume, complete);
        }
    }

    private static IEnumerable<string> Parts(ContextContent content)
    {
        switch (content)
        {
            case TextContent text:
                yield return text.Text;
                break;
            case SummaryContent summary:
                yield return summary.Text;
                break;
            case ToolCallContent call:
                yield return call.ToolName;
                yield return " ";
                yield return call.CallId;
                yield return " ";
                yield return call.ArgumentsJson;
                break;
            case ToolResultContent result:
                yield return result.CallId;
                yield return " ";
                yield return result.ResultJson;
                break;
            default:
                throw new ArgumentException("Only the immutable built-in content cases are admitted.", nameof(content));
        }
    }
}
