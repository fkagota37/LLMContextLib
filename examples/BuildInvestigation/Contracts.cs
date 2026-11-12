// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Text.Json;

namespace LLMContextLib.Examples.BuildInvestigation;

/// <summary>
/// Application-defined configuration stored as memory JSON. The runner decides whether the
/// tool, version, workload, and worker range are compatible; LLMContextLib treats it as opaque text.
/// </summary>
/// <param name="Tool">Application tool name, not a registered library operation.</param>
/// <param name="ToolVersion">Compatibility version of the external tool/configuration contract.</param>
/// <param name="WorkloadKey">Application identity for jobs allowed to share these settings.</param>
/// <param name="Workers">Proposed execution parallelism, not the number of context-library workers.</param>
public sealed record BuildSettings(
    string Tool, string ToolVersion, string WorkloadKey, int Workers);

/// <summary>
/// External-tool observation recorded in the transcript. The simulation supplies completion
/// only; a real adapter would extend this application contract with actual measured evidence.
/// </summary>
/// <param name="Outcome">Application-reported result, not a library mutation status or performance claim.</param>
public sealed record BuildObservation(string Outcome);

/// <summary>
/// Runner-to-coordinator handoff after a successful publication. Carrying canonical identities
/// lets the next worker create anchors directly instead of searching text or asking a model
/// to rediscover where a tool result occurred.
/// </summary>
/// <param name="Settings">Inputs actually passed to the profiler adapter.</param>
/// <param name="Observation">Outcome returned by that invocation.</param>
/// <param name="CallEntryId">Canonical entry containing the serialized invocation.</param>
/// <param name="ResultEntryId">Canonical entry containing the correlated result.</param>
/// <param name="PublishedSessionRevision">Accepted revision of the atomic call/result publication.</param>
public sealed record RecordedBuild(
    BuildSettings Settings, BuildObservation Observation,
    Guid CallEntryId, Guid ResultEntryId, long PublishedSessionRevision);

/// <summary>
/// Coordinator-to-knowledge-worker handoff. Anchors identify the evidence without copying its
/// transcript; recommended settings still need application approval before memory publication.
/// </summary>
/// <param name="ExperimentAnchorId">Inclusive experiment passage, including its conclusion.</param>
/// <param name="DecisionAnchorId">Separate bookmark addressing the conclusion itself.</param>
/// <param name="PublishedSessionRevision">Revision publishing both anchors and the conclusion.</param>
/// <param name="RecommendedSettings">Application/model choice, not a library-certified optimum.</param>
public sealed record InvestigationOutcome(
    Guid ExperimentAnchorId, Guid DecisionAnchorId,
    long PublishedSessionRevision, BuildSettings RecommendedSettings);

/// <summary>
/// Observable outcome of the real example implementation, used by its integration tests.
/// Counts describe scripted control flow/state, not provider requests, cost, or elapsed time.
/// </summary>
/// <param name="InvestigationRevision">Final session A revision.</param>
/// <param name="FollowupRevision">Final session B revision.</param>
/// <param name="MemoryRevision">Catalog revision returned by the initial knowledge publication.</param>
/// <param name="InvestigationMemories">Memories applicable to A's explicit local/repository scope request.</param>
/// <param name="FollowupMemories">Memories applicable to B's explicit local/repository scope request.</param>
/// <param name="ModelAdapterInvocations">Total scripted reasoning/tool-selection invocations.</param>
/// <param name="SimulatedBuildRuns">Total simulated profiler invocations, including the follow-up.</param>
/// <param name="DirectUiModelAdapterInvocations">Invocation delta for direct navigation/source reads.</param>
/// <param name="FollowupModelAdapterInvocations">Invocation delta for the follow-up branch.</param>
/// <param name="ReusedConfiguration">Whether that branch used admitted compatible memory.</param>
public sealed record ExampleRunSummary(
    long InvestigationRevision, long FollowupRevision, long MemoryRevision,
    int InvestigationMemories, int FollowupMemories,
    int ModelAdapterInvocations, int SimulatedBuildRuns,
    int DirectUiModelAdapterInvocations, int FollowupModelAdapterInvocations,
    bool ReusedConfiguration);

/// <summary>
/// Application envelope representing a model-selected read tool. Returning this value executes
/// nothing: the orchestrator validates arguments and dispatches to ContextToolAdapter separately.
/// </summary>
/// <param name="CallId">Provider/application request ID, separate from transcript entry and profiler call IDs.</param>
/// <param name="Name">Registered application handler name, not generated executable code.</param>
/// <param name="Arguments">Arguments conforming to the host-supplied tool schema.</param>
public sealed record ContextToolCall(string CallId, string Name, JsonElement Arguments);

/// <summary>
/// Executed read-tool reply. A live host maps it to its provider's tool-result message format;
/// LLMContextLib supplies neither that protocol nor an automatic continuation inference.
/// </summary>
/// <param name="CallId">Original orchestration request ID, preserved for correct reply association.</param>
/// <param name="JsonContent">Materialized output with captured revisions and canonical source IDs.</param>
public sealed record ContextToolReply(string CallId, string JsonContent);

/// <summary>
/// Existing external-tool integration seam. The library stores its invocation/result after
/// execution; it cannot roll back external side effects when a later storage publication fails.
/// </summary>
public interface IBuildProfiler
{
    /// <summary>Execute once and return observations; the caller owns recording and failure recovery.</summary>
    BuildObservation Run(BuildSettings settings);
}

/// <summary>
/// Existing reasoning/orchestration integration seam, intentionally separate from storage.
/// A live adapter builds provider prompts/schemas and calls a model; the offline implementation
/// returns fixed decisions so this example needs no credentials or inference.
/// </summary>
public interface IReasoningModel
{
    /// <summary>Propose a trial from explicit inputs, rather than asking a model to reconstruct stored history.</summary>
    BuildSettings ProposeTrial(BuildSettings baseline, BuildObservation result);
    /// <summary>Explain supplied observations; this is reasoning, not a deterministic context read.</summary>
    string Explain(BuildObservation baseline, BuildObservation trial);
    /// <summary>Select a registered read tool using host-provided schemas and the authorized session identity.</summary>
    ContextToolCall SelectContextTool(string request, Guid activeSessionId);
}

/// <summary>
/// Application-side write checking. A mutation result is not proof of success:
/// inspect Status before telling a user or another worker that data was stored.
/// </summary>
public static class Publication
{
    /// <summary>
    /// Require Applied and return the actual committed version. This teaching host fails fast
    /// on conflicts/admission errors; a production host needs an explicit recovery policy,
    /// especially when external work has completed before recording fails.
    /// </summary>
    /// <param name="result">Library outcome, not an unchecked success acknowledgement.</param>
    /// <param name="operation">Application operation label included in the exception.</param>
    /// <exception cref="InvalidOperationException">The attempted publication did not succeed.</exception>
    public static long EnsureApplied(IContextMutationResult result, string operation)
    {
        if (result.Status != ContextMutationStatus.Applied)
        {
            // This example stops rather than silently rebasing or retrying.
            // A production coordinator decides how to handle RevisionConflict,
            // AdmissionRejected, or other failures, then reports that decision.
            throw new InvalidOperationException(
                $"{operation}: {result.Status}; revision={result.Revision}; {result.Error}");
        }

        // This is the actual committed revision returned by the library,
        // not an assumed local counter. Later operations can depend on it.
        return result.Revision;
    }
}
