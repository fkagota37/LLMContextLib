// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text.Json;

namespace LLMContextLib.Examples.BuildInvestigation;

/// <summary>
/// Application boundary shared by human UI commands and agent read-tool calls.
/// It borrows the SAME owner used by the workers. Tool registration, caller
/// authentication, model execution, and UI rendering belong to the existing host.
/// This is example application code, not a built-in LLMContextLib tool server.
/// </summary>
public sealed class ContextToolAdapter
{
    private readonly ILLMContextPolymorphicArray _contexts;
    private readonly ImmutableHashSet<Guid> _allowedSessions;
    private readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
    };

    /// <summary>
    /// Borrow the worker owner and install the host's authorization decision for this adapter.
    /// In a multi-user service, derive this set per caller rather than trusting tool arguments.
    /// </summary>
    public ContextToolAdapter(ILLMContextPolymorphicArray contexts, params Guid[] allowedSessions)
    {
        _contexts = contexts;
        // This demo's host supplies its two sessions. A real service derives this
        // set from the caller; a model-supplied ID does not itself grant access.
        _allowedSessions = allowedSessions.ToImmutableHashSet();
    }

    /// <summary>
    /// Dispatch an already schema-validated human/agent read request through native library
    /// operations. Return ordinary JSON while every disposable capture is still correctly scoped.
    /// No model is called, no generated code is evaluated, and no library handle crosses the boundary.
    /// </summary>
    /// <param name="name">Registered context_view or context_read_anchor application tool name.</param>
    /// <param name="arguments">Host-validated JSON carrying an allowed session ID and a limit from 1 through 32.</param>
    /// <returns>Materialized items, canonical IDs, captured revisions, and optional source status.</returns>
    /// <remarks>
    /// This is a dispatch example, not a complete protocol server: missing/malformed properties,
    /// unknown targets, and admission failures propagate as exceptions for the host to map into
    /// its own error envelope. Caller access is checked independently of model/tool selection.
    /// </remarks>
    public string Execute(string name, JsonElement arguments)
    {
        // Step 1: the orchestrator validates its tool schema before dispatch.
        // Independently check the session and read bound at our application edge.
        Guid sessionId = arguments.GetProperty("sessionId").GetGuid();
        if (!_allowedSessions.Contains(sessionId))
            throw new InvalidOperationException("Session unavailable to this caller.");
        int limit = arguments.GetProperty("limit").GetInt32();
        if (limit is < 1 or > 32) throw new ArgumentOutOfRangeException(nameof(limit));

        // Step 2: select an explicit operation, never evaluate model-generated C#.
        if (name == "context_read_anchor")
            return ReadAnchor(sessionId, arguments.GetProperty("anchorId").GetGuid(), limit);
        if (name != "context_view") throw new ArgumentException("Unknown tool.");
        return arguments.GetProperty("view").GetString() switch
        {
            "navigation" => Navigation(sessionId, limit),
            "search" => Search(sessionId, arguments.GetProperty("query").GetString()
                ?? throw new ArgumentException("Search needs a query."), limit),
            "memory" => Memory(sessionId, arguments.GetProperty("memoryScope").GetString(), limit),
            _ => throw new ArgumentException("Unknown view.")
        };
    }

    private string Navigation(Guid sessionId, int limit)
    {
        // Enumerate resolved anchors for an outline; no model must reread the
        // transcript and manufacture a table of contents on every button click.
        using var view = _contexts.OpenView(ContextViews.Navigation(sessionId, limit));
        var items = view.Select(target => new
        {
            target.Anchor.AnchorId,
            target.Anchor.Title,
            target.Anchor.Summary,
            target.Status
        }).ToArray();
        return Reply(sessionId, view.SessionRevision, view.MemoryRevision, items);
    }

    private string Search(Guid sessionId, string query, int limit)
    {
        // This is the library's lexical search, not semantic model inference.
        // Results carry canonical entry/anchor IDs for a subsequent jump.
        using var view = _contexts.OpenView(ContextViews.Search(sessionId, query, limit));
        return Reply(sessionId, view.SessionRevision, view.MemoryRevision, view.ToArray());
    }

    private string Memory(Guid sessionId, string? requestedScope, int limit)
    {
        // Derive repository identity from the stored session, not the prompt.
        // This metadata read and the later view are independent captures. Revisions in the
        // reply belong to the view actually producing the items, not this earlier read.
        Guid? repositoryId;
        using (var read = _contexts.OpenRead(sessionId))
            repositoryId = read.Session.RepositoryId;
        var ownScope = new MemoryScope(SessionId: sessionId);
        var repoScope = repositoryId is { } id
            ? new MemoryScope(RepositoryId: id) : null;
        ImmutableArray<MemoryScope> scopes = requestedScope switch
        {
            "session" => [ownScope],
            "repository" when repoScope is not null => [repoScope],
            "sessionAndRepository" when repoScope is not null => [ownScope, repoScope],
            _ => throw new ArgumentException("Requested scope unavailable.")
        };
        using var view = _contexts.OpenView(ContextViews.Memory(sessionId, scopes, limit));
        return Reply(sessionId, view.SessionRevision, view.MemoryRevision, view.ToArray());
    }

    private string ReadAnchor(Guid sessionId, Guid anchorId, int limit)
    {
        // Resolve against one captured root, then return a bounded passage.
        // Missing/partial endpoints are reported, not reconstructed by a model.
        using var read = _contexts.OpenRead(sessionId);
        AnchorResolution target = read.ResolveAnchor(anchorId);
        ImmutableArray<ContextEntry> passage = [];
        // TakeWhile enforces the inclusive end even when the requested count extends beyond
        // this passage. A long passage can still be truncated by limit; this is not pagination.
        if (target.Start is { } start && target.End is { } end)
            passage = read.ReadRange(start.Sequence, limit)
                .TakeWhile(entry => entry.Sequence <= end.Sequence).ToImmutableArray();
        var items = passage.Select(entry => new
        {
            entry.EntryId,
            entry.Sequence,
            entry.Role,
            text = ContextPolicies.Text(entry.Content)
        }).ToArray();
        return Reply(sessionId, read.Session.Revision, read.MemoryRevision, items, target.Status.ToString());
    }

    private string Reply(Guid sessionId, long sessionRevision, long memoryRevision,
        object items, string? status = null)
    {
        // Serialize while the caller still owns its read/view. Only materialized
        // JSON crosses the tool boundary: no disposable view escapes to a model.
        return JsonSerializer.Serialize(new
        {
            sessionId,
            sessionRevision,
            memoryRevision,
            items,
            status
        }, _json);
    }
}
