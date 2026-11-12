// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text.RegularExpressions;
using LLMContextLib;

namespace LLMContextLib.Benchmarks;

/// <summary>
/// Untimed executable specification. Ordered dictionaries, full transaction copies, regex word
/// extraction, and deliberately straightforward searches are independent of every competitor.
/// This class is never returned by BenchmarkParticipants or measured as a speed baseline.
/// Its full-value observations detect errors that aggregate checksums could otherwise conceal.
/// </summary>
internal sealed class SemanticOracle : IContextBenchmarkParticipant
{
    private sealed class SessionData(LLMSessionContext session)
    {
        internal LLMSessionContext Header = session;
        internal SortedDictionary<long, ContextEntry> Entries = new(session.Segments.Values
            .SelectMany(segment => segment.Entries).ToDictionary(entry => entry.Sequence));
        internal Dictionary<Guid, ConversationAnchor> Anchors = session.Anchors.ToDictionary();
        internal long Next = session.Segments.Values.SelectMany(segment => segment.Entries)
            .Select(entry => entry.Sequence + 1).DefaultIfEmpty().Max();
    }

    private readonly Dictionary<Guid, SessionData> _sessions;
    private readonly Dictionary<Guid, ContextMemory> _memory = [];
    private long _memoryRevision;
    private readonly DateTimeOffset _now;
    internal SemanticOracle(ContextFixture fixture)
    {
        _sessions = fixture.Sessions.ToDictionary(session => session.SessionId, session => new SessionData(session));
        _now = fixture.Options.TimeProvider.GetUtcNow();
    }

    public long Revision(Guid id) => _sessions[id].Header.Revision;
    public IContextMutationResult Apply(ContextChangeSet changes)
    {
        var state = _sessions[changes.SessionId];
        if (state.Header.Revision != changes.ExpectedRevision) return Result(ContextMutationStatus.RevisionConflict, state.Header.Revision);
        var entries = new SortedDictionary<long, ContextEntry>(state.Entries);
        var anchors = new Dictionary<Guid, ConversationAnchor>(state.Anchors);
        long next = state.Next;
        var status = state.Header.Status;
        foreach (var change in changes.Changes)
        {
            if (status != SessionStatus.Active && change is not SetSessionStatus)
                return Result(ContextMutationStatus.InvalidOperation, state.Header.Revision);
            switch (change)
            {
                case AppendEntries append:
                    foreach (var draft in append.Entries)
                        entries.Add(next, new(draft.EntryId, next++, draft.Role, draft.CreatedAt, draft.Content));
                    break;
                case ReplaceEntry replace:
                    var old = entries.Values.Single(entry => entry.EntryId == replace.EntryId);
                    entries[old.Sequence] = old with { Content = replace.Content };
                    break;
                case DeleteEntry delete:
                    entries.Remove(entries.Values.Single(entry => entry.EntryId == delete.EntryId).Sequence);
                    break;
                case PutAnchor put: anchors[put.Anchor.AnchorId] = put.Anchor; break;
                case RemoveAnchor remove: anchors.Remove(remove.AnchorId); break;
                case SetSessionStatus set: status = set.Status; break;
                default: throw new InvalidOperationException("Oracle does not recognize this trace operation.");
            }
        }
        state.Entries = entries;
        state.Anchors = anchors;
        state.Next = next;
        state.Header = state.Header with { Revision = state.Header.Revision + 1, Status = status };
        return Result(ContextMutationStatus.Applied, state.Header.Revision);
    }

    public IContextMutationResult ApplyMemory(MemoryChangeSet changes)
    {
        if (changes.ExpectedRevision != _memoryRevision) return Result(ContextMutationStatus.RevisionConflict, _memoryRevision);
        foreach (var record in changes.Upserts)
            if (record.Status == MemoryStatus.Confirmed && record.Sources.IsDefaultOrEmpty)
                return Result(ContextMutationStatus.InvalidOperation, _memoryRevision);
        _memoryRevision++;
        foreach (var id in changes.Deletes) _memory.Remove(id);
        foreach (var record in changes.Upserts) _memory[record.MemoryId] = record with { Revision = _memoryRevision };
        return Result(ContextMutationStatus.Applied, _memoryRevision);
    }

    public ContextObservation Read(Guid id, ContextReadRequest request)
    {
        var state = _sessions[id];
        var result = ContextObservation.Empty(state.Header.Revision, _memoryRevision);
        var scopes = request.Scopes.IsDefault ? ImmutableArray<MemoryScope>.Empty : request.Scopes;
        var memory = _memory.Values.Where(record => scopes.Contains(record.Scope) &&
            (!record.Scope.UserId.HasValue || record.Scope.UserId == state.Header.UserId) &&
            (!record.Scope.RepositoryId.HasValue || record.Scope.RepositoryId == state.Header.RepositoryId) &&
            (!record.Scope.SessionId.HasValue || record.Scope.SessionId == id) &&
            record.Status == MemoryStatus.Confirmed && (!record.ExpiresAt.HasValue || record.ExpiresAt > _now))
            .OrderBy(record => record.MemoryId).ToImmutableArray();
        switch (request.Kind)
        {
            case ContextReadKind.Range:
                return result with { Entries = state.Entries.Values.Where(entry => entry.Sequence >= request.FromSequence).Take(request.Limit).ToImmutableArray() };
            case ContextReadKind.Conversation:
                return result with
                {
                    Entries = state.Entries.Values.Where(entry => (entry.Role == ContextRole.User || entry.Role == ContextRole.Assistant) &&
                        entry.Content.GetType() == typeof(TextContent)).Take(request.Limit).ToImmutableArray()
                };
            case ContextReadKind.Memory: return result with { Memories = memory };
            case ContextReadKind.Model: return result with { Model = Model(state.Entries.Values.ToArray(), memory, request) };
            case ContextReadKind.Anchor:
                var anchor = state.Anchors[request.AnchorId];
                var start = state.Entries.Values.SingleOrDefault(entry => entry.EntryId == anchor.StartEntryId);
                var end = state.Entries.Values.SingleOrDefault(entry => entry.EntryId == anchor.EndEntryId);
                bool unavailable = anchor.PinnedRevision.HasValue && anchor.PinnedRevision != state.Header.Revision;
                var status = unavailable ? AnchorTargetStatus.HistoryUnavailable :
                    start is null && end is null ? AnchorTargetStatus.Missing :
                    start is null || end is null ? AnchorTargetStatus.Partial :
                    anchor.SourceRevision == state.Header.Revision ? AnchorTargetStatus.Current : AnchorTargetStatus.Edited;
                return result with { Anchors = [new(anchor, status, unavailable ? null : start, unavailable ? null : end, state.Header.Revision)] };
            case ContextReadKind.Search:
                var words = Words(request.Query);
                var hits = new List<ContextSearchHit>();
                if (words.Count == 0) return result;
                foreach (var entry in state.Entries.Values)
                    Add(entry, null, Text(entry.Content));
                foreach (var bookmark in state.Anchors.Values)
                {
                    var entry = state.Entries.Values.SingleOrDefault(candidate => candidate.EntryId == bookmark.StartEntryId);
                    if (entry is not null) Add(entry, bookmark.AnchorId, $"{bookmark.Title} {bookmark.Summary} {string.Join(' ', bookmark.Topics)}");
                }
                return result with { Hits = hits.OrderBy(hit => hit.Sequence).ThenBy(hit => hit.AnchorId).Take(request.Limit).ToImmutableArray() };

                void Add(ContextEntry entry, Guid? anchorId, string text)
                {
                    var sourceWords = Words(text);
                    if (words.All(sourceWords.Contains))
                        hits.Add(new(entry.EntryId, anchorId, text[..Math.Min(text.Length, 160)], entry.Sequence, state.Header.Revision));
                }
            default: throw new ArgumentOutOfRangeException(nameof(request));
        }
    }

    private static HashSet<string> Words(string text) => Regex.Matches(text.ToLowerInvariant(), @"[\p{L}\p{Nd}]+")
        .Select(match => match.Value).ToHashSet(StringComparer.Ordinal);

    private static string Text(ContextContent content) => content switch
    {
        TextContent text => text.Text,
        ToolCallContent call => call.ToolName + " " + call.CallId + " " + call.ArgumentsJson,
        ToolResultContent result => result.CallId + " " + result.ResultJson,
        SummaryContent summary => summary.Text,
        _ => throw new InvalidOperationException()
    };

    private static ImmutableArray<ModelContextItem> Model(
        ContextEntry[] entries, ImmutableArray<ContextMemory> memories, ContextReadRequest request)
    {
        var chosen = new List<ModelContextItem>();
        int budget = request.TokenBudget;
        bool Add(params ModelContextItem[] items)
        {
            int cost = items.Sum(item => ContextFixture.EstimateTokens(item.Text));
            if (cost > budget || chosen.Count + items.Length > request.Limit) return false;
            chosen.AddRange(items);
            budget -= cost;
            return true;
        }
        ModelContextItem Item(ContextEntry entry) => new(entry.EntryId, null, entry.Role, Text(entry.Content));
        foreach (var entry in entries.Where(entry => entry.Role == ContextRole.System)) Add(Item(entry));
        foreach (var record in memories) Add(new ModelContextItem(null, record.MemoryId, ContextRole.System, record.Content));
        long through = -1;
        var summary = entries.LastOrDefault(entry => entry.Content is SummaryContent);
        if (summary is not null && summary.Role != ContextRole.System && Add(Item(summary)))
            through = ((SummaryContent)summary.Content).ThroughSequence;
        var groups = new List<ContextEntry[]>();
        foreach (var entry in entries)
        {
            if (entry.Role == ContextRole.System || entry.Sequence <= through || entry.Content is SummaryContent or ToolResultContent)
                continue;
            if (entry.Content is ToolCallContent call)
            {
                var latest = entries.Last(candidate => candidate.Content is ToolCallContent other && other.CallId == call.CallId);
                if (latest.EntryId != entry.EntryId) continue;
                var response = entries.LastOrDefault(candidate => candidate.Content is ToolResultContent result && result.CallId == call.CallId);
                if (response is not null && response.Sequence > entry.Sequence) groups.Add([entry, response]);
            }
            else groups.Add([entry]);
        }
        for (int i = groups.Count - 1; i >= 0; i--) Add(groups[i].Select(Item).ToArray());
        var byId = chosen.Where(item => item.EntryId.HasValue).ToDictionary(item => item.EntryId!.Value);
        var ordered = entries.Where(entry => byId.ContainsKey(entry.EntryId)).Select(entry => byId[entry.EntryId]).ToList();
        ordered.InsertRange(ordered.TakeWhile(item => item.Role == ContextRole.System).Count(), chosen.Where(item => item.MemoryId.HasValue));
        return ordered.ToImmutableArray();
    }

    public IContextRetention Retain(Guid id) => new OracleRetention(Revision(id), _sessions[id].Entries.Values.ToArray());
    private sealed class OracleRetention(long revision, ContextEntry[] entries) : IContextRetention
    {
        public long Revision => revision;
        public ContextEntry? FirstEntry => entries.FirstOrDefault();
        public void Dispose() { }
    }
    private static IContextMutationResult Result(ContextMutationStatus status, long revision) => new BenchmarkMutationResult(status, revision);
    public void Dispose() { }
}
