# Build-investigation assistant

> **Experimental example for an experimental library.** This is work in progress,
> not a production-ready assistant or a stable, versioned library integration.
> See the repository's `TODO.md` for open design and readiness work.

A runnable, commented example of LLMContextLib plugged into an application's
context layer. Three workers share one owner and two sessions. The example
records a simulated investigation, creates navigation anchors, publishes scoped
memory, serves human/agent read requests, and reuses a configuration in a
follow-up session.

**Configuration status:** this runnable example still uses the original
`LLMContextFactory.Create()` Text-mode path and text search, not the recommended
`WriteOptimized` preset. The [root startup example](../../README.md#recommended-startup)
uses the current preset. Migrating this application requires complete keys on
entries/anchors, key-based tool search and synchronization/outcome handling;
changing only its factory call would not be sufficient.

## Run

From the repository root:

```powershell
dotnet run --project examples\BuildInvestigation\BuildInvestigation.csproj -c Release -f net9.0
```

Use `-f net8.0` to run on the other supported framework. The project is included
in `LLMContextLib.sln` and references only the library; it adds no packages.

**This is an offline simulation, not a benchmark.** No real build or model runs.
`SimulatedBuildProfiler` reports a completion outcome without fabricated timings.
`ScriptedReasoningModel` returns fixed decisions so the example needs no credentials,
network access, or provider SDK. The library operations themselves are real.

## Follow the implementation

| File | Read it to understand |
|---|---|
| `Program.cs` | Entry point and simulation notice |
| `BuildInvestigationAssistant.cs` | One owner's lifetime, dependency injection, and the human/agent orchestration phases |
| `Contracts.cs` | Application payloads, canonical entry IDs, tool request/reply correlation, and publication result checking |
| `InvestigationCoordinator.cs` | Store the request/plan, invoke reasoning, then publish conclusion and anchors |
| `BuildRunnerWorker.cs` | Record completed calls/results with expected revisions; inspect compatible cached settings without a model |
| `KnowledgeWorker.cs` | Publish an approved local note and repository configuration, with source anchors |
| `ContextToolAdapter.cs` | Translate read-tool names/JSON arguments into bounded library views and anchor reads |
| `SimulationAdapters.cs` | See the scripted dependencies; replace these when integrating an actual profiler/model |

`docs\build-investigation-assistant.md` at the repository root is the supplementary
walkthrough. It explains the sequence and points to these classes rather than
maintaining another copy of their code.

## What to observe

The JSON output includes actual generated entry/anchor IDs and stored content.
The summary reports:

```text
Workers sharing one owner: 3; memory revision: 1
Direct UI model-adapter invocations added: 0
Follow-up reused cached workers: 4
Follow-up model-adapter invocations added: 0
Applicable memories: investigation=2, follow-up=1
Session revisions: investigation=5, follow-up=1
Model-adapter invocations total: 3; simulated build runs: 3
```

These are control-flow/state observations, not measurements of inference cost,
token savings, latency, throughput, or build performance. Reusing the scripted
configuration demonstrates sharing; it does not establish that it is optimal.

## Tests and extension points

`tests\LLMContextLib.Tests\BuildInvestigationExampleTests.cs` references this
project directly. It tests the whole flow, atomic call/result publication,
conflicts without rerunning the tool, cache compatibility, source-status policy,
scope isolation, and source-ID navigation.

To run those tests from the repository root:

```powershell
dotnet test tests\LLMContextLib.Tests\LLMContextLib.Tests.csproj -c Release --filter FullyQualifiedName~BuildInvestigationExampleTests
```

For a real integration, implement `IBuildProfiler` and `IReasoningModel`, replace
their construction in the host, and register the read-tool contracts with your
orchestrator. The provider-neutral schemas and usage instructions are in the
[technical usage guide](../../docs/usage-documentation.md). Your application still
owns scheduling, permissions, confirmation, external-tool error handling, and
decisions after revision conflicts.
The demonstration runs sequentially to make dependencies visible; it is not
a concurrent scheduler or distributed cache.
