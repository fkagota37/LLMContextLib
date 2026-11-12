// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

namespace LLMContextLib.Examples.BuildInvestigation;

/// <summary>
/// Application worker that coordinates one NEW investigation.
/// It shares the session with BuildRunnerWorker, but owns the request, plan,
/// conclusion, and bookmarks. The model dependency is explicit and separate
/// from the storage dependency so inference-free paths are easy to identify.
/// </summary>
public sealed class InvestigationCoordinator
{
    private readonly ILLMContextPolymorphicArray _contexts;
    private readonly BuildRunnerWorker _runner;
    private readonly IReasoningModel _model;

    /// <summary>
    /// Borrow the common owner, tool-running worker, and reasoning capability. This separation
    /// makes it visible which calls incur inference in a live integration and which only store data.
    /// </summary>
    public InvestigationCoordinator(
        ILLMContextPolymorphicArray contexts, BuildRunnerWorker runner, IReasoningModel model)
    {
        _contexts = contexts;
        _runner = runner;
        _model = model;
    }

    /// <summary>
    /// Orchestrate a fresh investigation as several dependent publications, not one transaction
    /// spanning external tools and reasoning. Only the final conclusion/anchor update is atomic
    /// as a group; an earlier successful phase remains recorded if a later phase fails.
    /// </summary>
    /// <param name="sessionId">Shared session whose canonical history receives all investigation entries.</param>
    /// <param name="toolVersion">Compatibility version propagated into baseline/trial settings.</param>
    /// <param name="workloadKey">Application job identity, later used to decide safe configuration reuse.</param>
    /// <returns>Stable evidence bookmarks and the accepted conclusion revision for the knowledge worker.</returns>
    /// <remarks>
    /// A live coordinator needs recovery for partial workflow completion. Storage atomicity does
    /// not imply exactly-once builds, model calls, or an all-or-nothing multi-step investigation.
    /// </remarks>
    public InvestigationOutcome Investigate(
        Guid sessionId, string toolVersion, string workloadKey)
    {
        // Step 1: store the incoming request as a real transcript entry.
        // Capture the current revision; do not keep using the revision-0 object
        // that the host originally passed to Initialize.
        long expectedRevision;
        using (var read = _contexts.OpenRead(sessionId))
            expectedRevision = read.Session.Revision;
        var requestEntry = new ContextEntryDraft(
            Guid.NewGuid(), ContextRole.User, DateTimeOffset.UtcNow,
            new TextContent($"Investigate the slow build for {workloadKey}."));
        var requestChange = new ContextChangeSet(
            sessionId, expectedRevision, [new AppendEntries([requestEntry])]);
        IContextMutationResult requestResult = _contexts.Apply(requestChange);
        Publication.EnsureApplied(requestResult, "Record investigation request");

        // Step 2: the existing profiler runs the baseline. Its worker records
        // the invocation and result in this SAME session, advancing its revision.
        var baselineSettings = new BuildSettings("build-profiler", toolVersion, workloadKey, 2);
        RecordedBuild baseline = _runner.RunAndRecord(sessionId, baselineSettings);

        // Step 3: this IS a model-adapter invocation. We ask for a candidate
        // experiment, not for the model to search/reconstruct our transcript.
        BuildSettings trialSettings = _model.ProposeTrial(baseline.Settings, baseline.Observation);
        var planEntry = new ContextEntryDraft(
            Guid.NewGuid(), ContextRole.Assistant, DateTimeOffset.UtcNow,
            new TextContent($"Try {trialSettings.Workers} workers for this workload."));
        var planChange = new ContextChangeSet(
            sessionId, baseline.PublishedSessionRevision, [new AppendEntries([planEntry])]);
        IContextMutationResult planResult = _contexts.Apply(planChange);
        Publication.EnsureApplied(planResult, "Record proposed experiment");

        // Step 4: execute and store the proposed trial. Again, tool execution is
        // not LLM inference; the library only stores its inputs and observed output.
        RecordedBuild trial = _runner.RunAndRecord(sessionId, trialSettings);

        // Step 5: this is the second reasoning invocation. Keeping it explicit
        // prevents us from calling the entire investigation "inference-free".
        string explanation = _model.Explain(baseline.Observation, trial.Observation);
        Guid decisionEntryId = Guid.NewGuid();
        var conclusion = new ContextEntryDraft(
            decisionEntryId, ContextRole.Assistant, DateTimeOffset.UtcNow,
            new TextContent(explanation));

        // Step 6: create navigation over canonical entries. An anchor is metadata
        // addressing a passage, not a second transcript or an embedding.
        long nextRevision = checked(trial.PublishedSessionRevision + 1);
        var experiment = new ConversationAnchor(
            Guid.NewGuid(), baseline.CallEntryId, decisionEntryId,
            "Worker-count experiment", "Baseline, proposed trial, observed outcomes, and conclusion.",
            ["build", "workers", "profiling"], AnchorKind.Topic, nextRevision, null);
        var decision = experiment with
        {
            AnchorId = Guid.NewGuid(),
            StartEntryId = decisionEntryId,
            Title = $"Decision: use {trial.Settings.Workers} workers",
            Summary = explanation,
            Kind = AnchorKind.Decision
        };

        // Step 7: publish the conclusion and BOTH anchors atomically. The command
        // order lets the anchors refer to the entry appended earlier in this
        // transaction. Readers see either the old root or this complete new root.
        var conclusionChange = new ContextChangeSet(
            sessionId, trial.PublishedSessionRevision,
            [new AppendEntries([conclusion]), new PutAnchor(experiment), new PutAnchor(decision)]);
        IContextMutationResult conclusionResult = _contexts.Apply(conclusionChange);
        long publishedRevision = Publication.EnsureApplied(conclusionResult, "Publish conclusion and anchors");
        return new InvestigationOutcome(
            experiment.AnchorId, decision.AnchorId, publishedRevision, trial.Settings);
    }
}
