// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;

namespace LLMContextLib;

/// <summary>
/// View definitions are repeatable queries, not mutable mirrored histories. Open the same
/// definition again to capture newer state; each returned view remains a stable captured revision.
/// Storage-specific indexes remain behind the read lease, including navigation and search.
/// </summary>
/// <remarks>
/// These helpers construct recipes; no storage is touched until OpenView. All limits bound
/// returned items, not necessarily candidate enumeration, sorting, or model-context grouping.
/// Definition errors may therefore surface at opening/evaluation rather than construction.
/// Dispose each returned view even if only its first item is needed.
/// </remarks>
public static class ContextViews
{
    /// <summary>
    /// Read up to limit canonical entries at or after fromSequence, in sequence order. Gaps
    /// from deletion are skipped; this is an indexed range read, not a scan of preceding text.
    /// </summary>
    /// <param name="sessionId">Session captured when opened.</param>
    /// <param name="fromSequence">Inclusive nonnegative sequence boundary, not a list offset.</param>
    /// <param name="limit">Nonnegative result cap within the owner's configured maximum.</param>
    public static ILLMContextViewDefinition<ContextEntry> Timeline(Guid sessionId, long fromSequence = 0, int limit = 64) =>
        new Definition<ContextEntry>(sessionId, limit, read => read.ReadRange(fromSequence, limit));

    /// <summary>
    /// Select plain-text User/Assistant entries in transcript order, from the beginning.
    /// Tool payloads, summaries, System, and Internal entries are not conversation text here.
    /// Filtering may inspect more entries than the output limit; this is not a latest-tail view.
    /// </summary>
    public static ILLMContextViewDefinition<ContextEntry> Conversation(Guid sessionId, int limit = 64) =>
        new Definition<ContextEntry>(sessionId, limit, read => ContextPolicies.Entries(read.Session)
            .Where(entry => entry.Role is ContextRole.User or ContextRole.Assistant && entry.Content is TextContent));

    /// <summary>
    /// Select all recorded calls/results with this correlation ID, in transcript order.
    /// Reused IDs may match several invocations, and truncation can cut a pair: this diagnostic
    /// view does not apply the whole-pair selection policy used for model context.
    /// </summary>
    public static ILLMContextViewDefinition<ContextEntry> Tool(Guid sessionId, string callId, int limit = 64) =>
        new Definition<ContextEntry>(sessionId, limit, read => ContextPolicies.Entries(read.Session)
            .Where(entry => entry.Content is ToolCallContent call && call.CallId == callId ||
                            entry.Content is ToolResultContent result && result.CallId == callId));

    /// <summary>
    /// Resolve bookmarks ordered by AnchorId, including degraded endpoint statuses. Labels and
    /// summaries are stored metadata; opening navigation does not ask a model to generate an outline.
    /// A UI can group/reorder these results itself rather than treating ID order as topic ranking.
    /// </summary>
    public static ILLMContextViewDefinition<AnchorResolution> Navigation(Guid sessionId, int limit = 64) =>
        new Definition<AnchorResolution>(sessionId, limit, read => read.Session.Anchors.Values
            .OrderBy(anchor => anchor.AnchorId).Select(anchor => read.ResolveAnchor(anchor.AnchorId)));

    /// <summary>
    /// Search normalized lexical terms in entry content and anchor metadata. All query terms
    /// must occur at the same indexed address; no substring, embedding, or relevance ranking is used.
    /// Results are deterministic by sequence/anchor ID, with canonical IDs for subsequent navigation.
    /// </summary>
    public static ILLMContextViewDefinition<ContextSearchHit> Search(Guid sessionId, string query, int limit = 64) =>
        new Definition<ContextSearchHit>(sessionId, limit, read => read.Search(query, limit));

    /// <summary>Look up producer-prepared opaque keys without tokenization or normalization.</summary>
    public static ILLMContextViewDefinition<ContextSearchHit> SearchKeys(Guid sessionId, ContextIndexKeys keys, int limit = 64) =>
        new Definition<ContextSearchHit>(sessionId, limit, read => read.SearchKeys(keys, limit));

    /// <summary>
    /// Select confirmed, unexpired memories for exactly the requested applicable scopes, ordered
    /// by MemoryId. Use an initialized empty array to request none; default arrays are invalid here.
    /// Applicability is not permission checking, cache compatibility, or source-freshness validation.
    /// </summary>
    public static ILLMContextViewDefinition<ContextMemory> Memory(
        Guid sessionId, ImmutableArray<MemoryScope> scopes, int limit = 64) =>
        new Definition<ContextMemory>(sessionId, limit, read => read.GetApplicableMemory(scopes));

    /// <summary>
    /// Assemble bounded model-input text with System entries, requested memory, a fitting summary,
    /// and recent eligible transcript groups. Tool invocation/result groups are selected together.
    /// This performs native selection, not inference, and still examines the session for grouping.
    /// </summary>
    /// <param name="sessionId">Session captured when opened.</param>
    /// <param name="tokenBudget">Nonnegative selection budget under the supplied estimate, not a provider guarantee.</param>
    /// <param name="estimateTokens">Deterministic, nonnegative text-cost function; no tokenizer is supplied implicitly.</param>
    /// <param name="scopes">Explicit memory scopes; omitted/default means no memory for this helper.</param>
    /// <param name="limit">Maximum selected items, also applied inside grouping to avoid truncating a selected pair.</param>
    /// <remarks>
    /// The application maps results to provider messages and accounts for its own protocol overhead.
    /// Reopening the definition reevaluates both captured state and the caller's estimator.
    /// </remarks>
    public static ILLMContextViewDefinition<ModelContextItem> Model(
        Guid sessionId, int tokenBudget, Func<string, int> estimateTokens,
        ImmutableArray<MemoryScope> scopes = default, int limit = 1024) =>
        new Definition<ModelContextItem>(sessionId, limit, read => ContextPolicies.BuildModelContext(
            ContextPolicies.Entries(read.Session),
            read.GetApplicableMemory(scopes.IsDefault ? [] : scopes), tokenBudget, estimateTokens, limit));

    /// <summary>
    /// Filter/project canonical entries in sequence order without creating a mirrored transcript.
    /// Delegates execute synchronously during opening; the first result may require scanning many
    /// entries. Exceptions propagate with the borrowed read cleaned up by the owner.
    /// </summary>
    /// <typeparam name="T">Application projection type; prefer immutable payloads for stable results.</typeparam>
    /// <param name="sessionId">Session captured when opened.</param>
    /// <param name="predicate">Non-null filter; must not reenter or dispose the owning client.</param>
    /// <param name="projection">Non-null transformation; configure output estimates for large custom results.</param>
    /// <param name="limit">Nonnegative materialized-result cap within the owner's maximum.</param>
    public static ILLMContextViewDefinition<T> Project<T>(
        Guid sessionId, Func<ContextEntry, bool> predicate, Func<ContextEntry, T> projection, int limit = 64)
    {
        ArgumentNullException.ThrowIfNull(predicate);
        ArgumentNullException.ThrowIfNull(projection);
        return new Definition<T>(sessionId, limit,
            read => ContextPolicies.Entries(read.Session).Where(predicate).Select(projection));
    }

    // Keep a definition free of leases: it can be reused across publications without holding
    // old roots alive. The bridge supplies the short-lived read and controls materialization.
    private sealed record Definition<T>(
        Guid SessionId, int MaximumResults, Func<ILLMContextReadLease, IEnumerable<T>> Query) : ILLMContextViewDefinition<T>
    {
        public IEnumerable<T> Evaluate(ILLMContextReadLease context) => Query(context);
    }
}
