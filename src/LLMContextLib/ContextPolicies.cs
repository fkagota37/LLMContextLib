// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text;

namespace LLMContextLib;

/// <summary>
/// Storage-independent semantics shared by view construction and benchmark participants.
/// These functions do not supply concurrency or indexing. Model-context costing is always
/// caller-supplied; use a deterministic estimator appropriate to the target model and account
/// separately for provider message/protocol overhead.
/// </summary>
public static class ContextPolicies
{
    /// <summary>
    /// Lazily enumerate physical segment order and each segment's entry order. Admitted roots
    /// guarantee this is canonical sequence order. No lease, validation, or owner access is
    /// created here: the caller supplies and retains the immutable root being traversed.
    /// </summary>
    public static IEnumerable<ContextEntry> Entries(LLMSessionContext session)
    {
        foreach (var segment in session.Segments.Values)
            foreach (var entry in segment.Entries)
                yield return entry;
    }

    /// <summary>
    /// Format supported payloads for lexical indexing, estimates, and model-context text.
    /// Call/result correlation IDs are included; summaries contribute only their text.
    /// This is not a provider message serializer and does not parse embedded JSON.
    /// </summary>
    /// <exception cref="ArgumentException">The content is not a supported built-in case.</exception>
    public static string Text(ContextContent content) => content switch
    {
        TextContent text => text.Text,
        ToolCallContent call => $"{call.ToolName} {call.CallId} {call.ArgumentsJson}",
        ToolResultContent result => $"{result.CallId} {result.ResultJson}",
        SummaryContent summary => summary.Text,
        _ => throw new ArgumentException("Only the immutable built-in content cases are admitted.", nameof(content))
    };

    /// <summary>
    /// Default deterministic estimate: fixed entry overhead plus two bytes per formatted UTF-16
    /// character. It is an admission heuristic, not object-graph measurement or UTF-8 wire size.
    /// </summary>
    public static long EstimateEntryBytes(ContextEntry entry) => checked(128L + 2L * Text(entry.Content).Length);

    /// <summary>
    /// One pass over UTF-16 characters followed by ordinal deduplication and ordering:
    /// O(C + U log U * L) expected work and O(C + U) temporary storage for C characters,
    /// U distinct words and maximum word length L (ordinal comparisons are not free).
    /// Pathological hash collisions can add O(U² * L). This lexical policy makes results portable.
    /// It is not a language-aware tokenizer or a semantic embedding model.
    /// </summary>
    public static ImmutableArray<string> Terms(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var words = new HashSet<string>(StringComparer.Ordinal);
        var word = new StringBuilder();
        foreach (char character in text)
        {
            if (char.IsLetterOrDigit(character))
                word.Append(char.ToLowerInvariant(character));
            else
                Flush();
        }
        Flush();
        return words.Order(StringComparer.Ordinal).ToImmutableArray();

        void Flush()
        {
            if (word.Length == 0) return;
            words.Add(word.ToString());
            word.Clear();
        }
    }

    /// <summary>
    /// Test conjunctive identity applicability. Null fields impose no condition; validate a
    /// scope separately before admitting it, since this predicate alone accepts an empty scope.
    /// Matching says nothing about caller authorization or whether a record is confirmed.
    /// </summary>
    public static bool Matches(MemoryScope scope, LLMSessionContext session) =>
        (!scope.UserId.HasValue || scope.UserId == session.UserId) &&
        (!scope.RepositoryId.HasValue || scope.RepositoryId == session.RepositoryId) &&
        (!scope.SessionId.HasValue || scope.SessionId == session.SessionId);

    /// <summary>
    /// Validate requested scopes, then select exact-scope, applicable, confirmed records with
    /// expiry strictly after now. Returns MemoryId order rather than relevance/recency order.
    /// The caller supplies the evaluation time so an entire lease sees consistent expiry.
    /// </summary>
    /// <remarks>
    /// All requested scopes must match the session; an inapplicable scope is an error, not an
    /// ignored request. Provenance freshness and application payload compatibility are not checked.
    /// This pure policy does not index candidates; the storage-backed read narrows them beforehand.
    /// </remarks>
    public static ImmutableArray<ContextMemory> ApplicableMemory(
        IEnumerable<ContextMemory> candidates, LLMSessionContext session,
        ImmutableArray<MemoryScope> scopes, DateTimeOffset now)
    {
        if (scopes.IsDefault) throw new ArgumentException("Scopes must be initialized.", nameof(scopes));
        foreach (var scope in scopes)
        {
            ValidateScope(scope);
            if (!Matches(scope, session))
                throw new ArgumentException("Requested scope does not apply to this session.", nameof(scopes));
        }
        var allowed = scopes.ToHashSet();
        return candidates.Where(memory => allowed.Contains(memory.Scope) &&
                Matches(memory.Scope, session) && memory.Status == MemoryStatus.Confirmed &&
                (!memory.ExpiresAt.HasValue || memory.ExpiresAt > now))
            .OrderBy(memory => memory.MemoryId).ToImmutableArray();
    }

    /// <summary>
    /// Require at least one populated identity and reject Guid.Empty in every populated field.
    /// This validates shape only; session applicability and access are separate concerns.
    /// </summary>
    public static void ValidateScope(MemoryScope scope)
    {
        ArgumentNullException.ThrowIfNull(scope);
        if (scope == new MemoryScope() || scope.UserId == Guid.Empty ||
            scope.RepositoryId == Guid.Empty || scope.SessionId == Guid.Empty)
            throw new ArgumentException("Memory needs nonempty, explicit scope identities.", nameof(scope));
    }

    /// <summary>
    /// This policy examines N entries and builds tool-call groups before selecting context.
    /// Work is O(S + N + C + M log M) expected, excluding caller token-estimator costs; temporary
    /// storage is O(N + M + C). C includes formatted strings, M applicable memories. It is
    /// intentionally NOT described as a bounded-tail/O(1) model view: relevance/grouping still
    /// walks the session. A future tail/group index can optimize this policy without changing
    /// its observable ordering or permitting orphaned tool results.
    /// </summary>
    /// <param name="source">Canonical sequence-ordered entries from a validated session.</param>
    /// <param name="memory">Already filtered applicable memory; this method does not validate scope/status/expiry.</param>
    /// <param name="tokenBudget">Nonnegative capacity under estimateTokens; no actual tokenizer is implied.</param>
    /// <param name="estimateTokens">Stable nonnegative estimate, invoked while considering candidate groups.</param>
    /// <param name="maximumItems">Nonnegative item cap applied before accepting each complete group.</param>
    /// <remarks>
    /// Priority is System entries, memory in MemoryId order, the latest summary if it is
    /// non-System and fits, then remaining groups newest-first. Oversized candidates are skipped
    /// rather than truncated; even high-priority items can be omitted if they do not fit. Accepted
    /// transcript items are returned in original order, with memory after leading System items.
    /// Summary coverage suppresses earlier groups only when the summary itself is selected.
    /// Call/result eligibility uses the latest invocation and latest later result per CallId.
    /// </remarks>
    public static ImmutableArray<ModelContextItem> BuildModelContext(
        IEnumerable<ContextEntry> source, IEnumerable<ContextMemory> memory,
        int tokenBudget, Func<string, int> estimateTokens, int maximumItems = int.MaxValue)
    {
        if (tokenBudget < 0) throw new ArgumentOutOfRangeException(nameof(tokenBudget));
        if (maximumItems < 0) throw new ArgumentOutOfRangeException(nameof(maximumItems));
        ArgumentNullException.ThrowIfNull(estimateTokens);
        var entries = source.ToArray();
        var selected = new Dictionary<Guid, ModelContextItem>();
        var memoryItems = new List<ModelContextItem>();
        int remaining = tokenBudget;

        // Test a complete candidate before spending either budget. In particular, rejecting
        // a tool group must not leave a selected invocation without its eligible result.
        bool Fits(IEnumerable<ModelContextItem> items)
        {
            long total = 0;
            int count = 0;
            foreach (var item in items)
            {
                int cost = estimateTokens(item.Text);
                if (cost < 0) throw new ArgumentException("Token estimates cannot be negative.");
                total += cost;
                count++;
            }
            if (total > remaining || (long)selected.Count + memoryItems.Count + count > maximumItems) return false;
            remaining -= (int)total;
            return true;
        }

        // Reserve priority items first. This is best-effort selection, not a guarantee that
        // every System instruction fits; hosts must choose a budget appropriate to their policy.
        foreach (var entry in entries.Where(entry => entry.Role == ContextRole.System))
        {
            var item = ToModel(entry);
            if (Fits([item])) selected.Add(entry.EntryId, item);
        }
        foreach (var record in memory.OrderBy(record => record.MemoryId))
        {
            var item = new ModelContextItem(null, record.MemoryId, ContextRole.System, record.Content);
            if (Fits([item])) memoryItems.Add(item);
        }

        // Only a selected summary can stand in for its covered history. If it is too large,
        // leave the coverage boundary unset so original entries remain eligible.
        long summarizedThrough = -1;
        var latestSummary = entries.LastOrDefault(entry => entry.Content is SummaryContent);
        if (latestSummary is not null && latestSummary.Role != ContextRole.System)
        {
            var item = ToModel(latestSummary);
            if (Fits([item]))
            {
                selected[latestSummary.EntryId] = item;
                summarizedThrough = ((SummaryContent)latestSummary.Content).ThroughSequence;
            }
        }

        // Group by correlation ID rather than adjacency: other messages can occur between a
        // call and result. This temporary session-wide index is why the policy is not tail-only.
        var results = entries.Where(entry => entry.Content is ToolResultContent)
            .GroupBy(entry => ((ToolResultContent)entry.Content).CallId, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last(), StringComparer.Ordinal);
        var calls = entries.Where(entry => entry.Content is ToolCallContent)
            .GroupBy(entry => ((ToolCallContent)entry.Content).CallId, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last(), StringComparer.Ordinal);
        var groups = new List<ContextEntry[]>();
        foreach (var entry in entries)
        {
            if (entry.Role == ContextRole.System || entry.Sequence <= summarizedThrough ||
                entry.Content is SummaryContent or ToolResultContent)
                continue;
            if (entry.Content is ToolCallContent call)
            {
                // A replay/retry may reuse a provider call ID. Never attach one result to
                // multiple historical calls: only its latest canonical invocation is eligible.
                if (calls[call.CallId].EntryId == entry.EntryId &&
                    results.TryGetValue(call.CallId, out var result) && result.Sequence > entry.Sequence)
                    groups.Add([entry, result]);
            }
            else
                groups.Add([entry]);
        }
        // Prefer recent groups, but skip a group that cannot fit so smaller older groups can
        // still be selected. Reconstruct transcript order only after selection is complete.
        for (int i = groups.Count - 1; i >= 0; i--)
        {
            var items = groups[i].Select(ToModel).ToArray();
            if (!Fits(items)) continue;
            foreach (var item in items) selected[item.EntryId!.Value] = item;
        }
        var ordered = entries.Where(entry => selected.ContainsKey(entry.EntryId))
            .Select(entry => selected[entry.EntryId]).ToList();
        ordered.InsertRange(ordered.TakeWhile(item => item.Role == ContextRole.System).Count(), memoryItems);
        return ordered.ToImmutableArray();
    }

    private static ModelContextItem ToModel(ContextEntry entry) =>
        new(entry.EntryId, null, entry.Role, Text(entry.Content));
}
