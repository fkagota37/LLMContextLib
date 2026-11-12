// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Text.Json;

namespace LLMContextLib.Examples.BuildInvestigation;

/// <summary>
/// Offline stand-in for an existing build/profiler integration.
/// Reports completion only: it neither executes a build nor invents timings.
/// </summary>
public sealed class SimulatedBuildProfiler : IBuildProfiler
{
    /// <summary>Number of synchronous simulation invocations, not a real build/performance counter.</summary>
    public int RunCount { get; private set; }

    /// <summary>
    /// Count one adapter call and return completion. Settings are intentionally not executed:
    /// replace this method with the application's actual profiler before interpreting outcomes.
    /// </summary>
    public BuildObservation Run(BuildSettings settings)
    {
        RunCount++;
        return new BuildObservation("Completed");
    }
}

/// <summary>
/// Offline fixture for an existing model adapter. Counts adapter invocations,
/// not actual API requests, tokens, latency, or billing: no model is called here.
/// A live adapter supplies prompts/tool definitions and invokes its chosen provider.
/// </summary>
public sealed class ScriptedReasoningModel : IReasoningModel
{
    /// <summary>Total scripted reasoning/tool-selection calls; no provider request is made.</summary>
    public int InvocationCount { get; private set; }

    /// <summary>
    /// Return a fixed four-worker trial while preserving the compatibility fields. This ignores
    /// observed performance and must not be read as a learned or measured optimization.
    /// </summary>
    public BuildSettings ProposeTrial(BuildSettings baseline, BuildObservation result)
    {
        InvocationCount++;
        return baseline with { Workers = 4 };
    }

    /// <summary>Produce fixed explanatory text from completion labels, explicitly disclaiming a measured improvement.</summary>
    public string Explain(BuildObservation baseline, BuildObservation trial)
    {
        InvocationCount++;
        return $"Simulated outcomes: baseline={baseline.Outcome}, trial={trial.Outcome}. " +
            "Reuse the trial configuration to demonstrate context sharing, not a measured improvement.";
    }

    /// <summary>
    /// Stand in for model tool selection by returning a fixed lexical search in the host-supplied
    /// session. The natural-language request is not interpreted; a live adapter supplies schemas,
    /// obtains provider output, and preserves its correlation ID.
    /// </summary>
    public ContextToolCall SelectContextTool(string request, Guid activeSessionId)
    {
        InvocationCount++;
        // This fixed response represents the model selecting a registered tool.
        // Execute belongs to the host; returning this record does not run the tool.
        return new ContextToolCall(Guid.NewGuid().ToString("N"), "context_view", JsonSerializer.SerializeToElement(new
        {
            sessionId = activeSessionId,
            view = "search",
            query = "workers",
            limit = 8
        }));
    }
}
