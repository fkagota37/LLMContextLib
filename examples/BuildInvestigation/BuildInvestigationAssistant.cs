// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text.Json;

namespace LLMContextLib.Examples.BuildInvestigation;

/// <summary>
/// Existing application's composition root and orchestrator.
/// Owns ONE context client, injects it into THREE workers plus the UI/tool adapter,
/// and decides whether a job needs reasoning or can use deterministic retrieval.
/// Dispose this host at application/session-service shutdown, not per worker.
/// </summary>
/// <remarks>
/// This executable teaching host runs a single sequential scenario. Its three logical workers
/// are responsibilities, not dedicated threads; no background scheduler or provider SDK is hidden
/// here. All sessions/memory disappear with the in-process owner unless the application exports them.
/// </remarks>
public sealed class BuildInvestigationAssistant : IDisposable
{
    private readonly ILLMContextPolymorphicArray _contexts;
    private readonly LLMSessionContext _investigation;
    private readonly LLMSessionContext _followup;
    private readonly ScriptedReasoningModel _model;
    private readonly SimulatedBuildProfiler _profiler;
    private readonly BuildRunnerWorker _runner;
    private readonly InvestigationCoordinator _coordinator;
    private readonly KnowledgeWorker _knowledge;
    private readonly ContextToolAdapter _tools;
    private readonly TextWriter _output;
    private const string ToolVersion = "example-v1";
    private const string WorkloadKey = "example-build";

    /// <summary>
    /// Compose an isolated example with one owner, two related sessions, and offline dependencies.
    /// Each host instance is independent; its injected workers share only this instance's owner.
    /// </summary>
    /// <param name="output">Optional borrowed output sink for testing; the host never disposes this writer.</param>
    public BuildInvestigationAssistant(TextWriter? output = null)
    {
        _output = output ?? Console.Out;
        // The application establishes identities. These are empty revision-0
        // session values, not mutable session objects passed among workers.
        Guid userId = Guid.NewGuid();
        Guid repositoryId = Guid.NewGuid();
        _investigation = EmptySession(userId, repositoryId);
        _followup = EmptySession(userId, repositoryId);

        // The factory creates the ONLY owner. Both sessions and the memory catalog
        // live behind it. Workers get this same handle, not another Initialize.
        _contexts = LLMContextFactory.Create().Initialize([_investigation, _followup]);

        // Simulations make this example executable offline. In the existing system,
        // these two adapters are the real profiler and model-provider integration.
        _profiler = new SimulatedBuildProfiler();
        _model = new ScriptedReasoningModel();
        _runner = new BuildRunnerWorker(_contexts, _profiler);
        _coordinator = new InvestigationCoordinator(_contexts, _runner, _model);
        _knowledge = new KnowledgeWorker(_contexts);
        _tools = new ContextToolAdapter(_contexts, _investigation.SessionId, _followup.SessionId);
    }

    /// <summary>
    /// Run the scenario once: record an investigation, publish scoped knowledge, serve direct
    /// and model-selected reads, then reuse compatible configuration in a follow-up session.
    /// </summary>
    /// <returns>Observed revisions, scope counts, and adapter-call deltas for integration tests.</returns>
    /// <remarks>
    /// This mutates the host's existing state, not a fresh fixture per call; invoke it once on a
    /// new host for the documented output. Later-phase failure does not roll back earlier phases.
    /// Adapter invocation counts demonstrate control flow, not measured inference savings.
    /// </remarks>
    public ExampleRunSummary RunDemonstration()
    {
        // Phase A: new work. No reusable knowledge exists yet.
        // The coordinator invokes the model twice and the profiler twice, while
        // library publications build the durable-in-this-owner investigation trail.
        InvestigationOutcome outcome =
            _coordinator.Investigate(_investigation.SessionId, ToolVersion, WorkloadKey);
        long memoryRevision = _knowledge.PublishApproved(_investigation.SessionId, outcome);
        _output.WriteLine($"Workers sharing one owner: 3; memory revision: {memoryRevision}");

        // Phase B: human navigation. A button already conveys the operation.
        // Dispatch directly: do NOT ask an LLM what "Navigation" means.
        int beforeUi = _model.InvocationCount;
        string navigation = _tools.Execute("context_view", JsonSerializer.SerializeToElement(new
        {
            sessionId = _investigation.SessionId,
            view = "navigation",
            limit = 8
        }));
        _output.WriteLine($"Navigation result: {navigation}");
        string passage = _tools.Execute("context_read_anchor", JsonSerializer.SerializeToElement(new
        {
            sessionId = _investigation.SessionId,
            anchorId = outcome.ExperimentAnchorId,
            limit = 32
        }));
        _output.WriteLine($"Source passage: {passage}");
        int directUiModelInvocations = _model.InvocationCount - beforeUi;
        _output.WriteLine($"Direct UI model-adapter invocations added: {directUiModelInvocations}");

        // Phase C: a natural-language request uses the model adapter to select a tool.
        // The real model adapter receives the README's tool descriptions/schemas
        // and active session ID. Our offline fixture returns one fixed tool call.
        ContextToolCall selected =
            _model.SelectContextTool("Find the decision about workers.", _investigation.SessionId);
        string toolResult = _tools.Execute(selected.Name, selected.Arguments);
        var toolReply = new ContextToolReply(selected.CallId, toolResult);
        _output.WriteLine($"Chat-selected search result: {toolReply.JsonContent}");
        // A live orchestrator sends toolReply.JsonContent under toolReply.CallId.
        // It may then invoke the model again to compose prose. That extra inference
        // is not included here: this example displays structured results directly.

        // Phase D: an application-driven agent starts the follow-up build.
        // Its first step is deterministic cache lookup, NOT "ask the LLM to recall".
        int beforeFollowup = _model.InvocationCount;
        bool reusedConfiguration = false;
        if (_runner.TryGetReusableSettings(_followup.SessionId, ToolVersion, WorkloadKey, out var cached)
            && cached is not null)
        {
            reusedConfiguration = true;
            // A compatible, current configuration lets this branch skip the
            // coordinator's planning/explanation calls. The build adapter still
            // runs (the adapter is a simulation in this executable example).
            _runner.RunAndRecord(_followup.SessionId, cached);
            _output.WriteLine($"Follow-up reused cached workers: {cached.Workers}");
        }
        else
        {
            // Cache absence, incompatibility, expiry, or our conservative status
            // check can require new reasoning. We do not pretend every job hits.
            InvestigationOutcome fresh =
                _coordinator.Investigate(_followup.SessionId, ToolVersion, WorkloadKey);
            _knowledge.PublishApproved(_followup.SessionId, fresh);
        }
        int followupModelInvocations = _model.InvocationCount - beforeFollowup;
        _output.WriteLine($"Follow-up model-adapter invocations added: {followupModelInvocations}");

        // Phase E: show scope isolation and actual current session revisions.
        // The original _investigation record is still revision 0; reopen reads
        // rather than treating that old immutable value as live shared state.
        using var first = _contexts.OpenRead(_investigation.SessionId);
        using var second = _contexts.OpenRead(_followup.SessionId);
        var repoScope = new MemoryScope(RepositoryId: first.Session.RepositoryId);
        int firstMemories = first.GetApplicableMemory(
            [new MemoryScope(SessionId: first.Session.SessionId), repoScope]).Length;
        int secondMemories = second.GetApplicableMemory(
            [new MemoryScope(SessionId: second.Session.SessionId), repoScope]).Length;
        _output.WriteLine($"Applicable memories: investigation={firstMemories}, follow-up={secondMemories}");
        _output.WriteLine($"Session revisions: investigation={first.Session.Revision}, follow-up={second.Session.Revision}");
        _output.WriteLine($"Model-adapter invocations total: {_model.InvocationCount}; simulated build runs: {_profiler.RunCount}");
        return new ExampleRunSummary(
            first.Session.Revision, second.Session.Revision, memoryRevision,
            firstMemories, secondMemories, _model.InvocationCount, _profiler.RunCount,
            directUiModelInvocations, followupModelInvocations, reusedConfiguration);
    }

    private static LLMSessionContext EmptySession(Guid userId, Guid repositoryId) => new(
        Guid.NewGuid(), userId, repositoryId, 0, SessionStatus.Active,
        ImmutableSortedDictionary<long, ContextSegment>.Empty,
        ImmutableDictionary<Guid, ConversationAnchor>.Empty);

    /// <summary>
    /// Release the sole library owner after its workers finish. Workers borrow it, and the output
    /// writer remains caller-owned. There are no background tasks to cancel in this sequential host.
    /// </summary>
    public void Dispose() => _contexts.Dispose();
}
