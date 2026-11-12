# Walkthrough: the build-investigation example

The implementation lives in **`examples\BuildInvestigation`**. This document is
a supplementary view of that code: follow the named files and methods in your
IDE while reading. There are no implementation blocks to copy out of Markdown.

The example explains an existing kind of application with LLMContextLib plugged
into its context layer. The application still owns tool execution, reasoning,
orchestration, and its UI. The library stores and projects the context those
components share.

## Run the code

From the repository root:

```powershell
# Run the source project directly; select the runtime installed on your machine.
dotnet run --project examples\BuildInvestigation\BuildInvestigation.csproj -c Release -f net9.0
```

The project also targets `net8.0`. Its README gives the source map and focused
test command. The solution builds it along with the library and tests.

**The default example is deliberately offline.** The build adapter reports a
completion outcome, not a measured duration. The model adapter returns fixed
responses, not actual inference. No real model or build runs, and the example
does not manufacture benchmark results. Native library reads, mutations,
anchors, memory publication, and conflict checks execute normally.

## 1. Start at the composition root

Open `Program.cs`, then `BuildInvestigationAssistant.cs`.

The host creates two empty session values with the same user/repository identity.
It calls `LLMContextFactory.Create().Initialize(...)` **once** and injects that
same owner into the workers and read-tool adapter.

| Component | Application responsibility | Library interaction |
|---|---|---|
| `InvestigationCoordinator` | Record the request, obtain a trial and explanation, bookmark the result | Reads/writes investigation session A |
| `BuildRunnerWorker` | Invoke the build adapter, record the completed run, inspect reusable settings | Reads/writes A and follow-up B; reads memory/provenance |
| `KnowledgeWorker` | Publish an application-approved configuration and a temporary note | Reads A; writes the separate memory catalog |
| `ContextToolAdapter` | Serve UI commands and model-selected read tools | Opens bounded reads/views and returns JSON |

There are **three logical workers**. The read-tool adapter is not another
background worker. The host owns the lifetime; workers borrow the owner.

```text
                  BuildInvestigationAssistant
                    owns one context client
                              |
       +----------------------+----------------------+
       |                      |                      |
 Coordinator worker     Build-runner worker     Knowledge worker
 requests/plans/         tool calls/results      local/shared memory
 conclusions/anchors     configuration lookup   source references
       |                      |                      |
       +----------------------+----------------------+
                              |
              one ILLMContextPolymorphicArray
                     /                  \
             session A                  session B
          investigation                 follow-up
                              |
                     memory catalog
              A-only note + repository configuration

 UI button or agent tool call -> ContextToolAdapter -> the same owner
```

Sharing a session means sharing its canonical ID through that owner, not sharing
a mutable `LLMSessionContext` object. An immutable session value represents one
revision. `OpenRead` captures a revision; a successful update publishes a new one.
The host deliberately reopens reads for final reporting rather than consulting
its old revision-0 initialization values.

The example calls workers sequentially to reveal dependencies. In an existing
system, its scheduler can overlap readers and independent work. The coordinator
and build runner both write A, so their expected revisions still matter. The
library does not schedule workers or reconcile conflicting plans.

## 2. Understand the records before following the writes

Open `Contracts.cs`. These are **application contracts**, not new library APIs:

| Record | Purpose |
|---|---|
| `BuildSettings` | Application-defined tool/version/workload compatibility key and worker count |
| `BuildObservation` | Tool outcome; the simulation supplies completion, not invented timing data |
| `RecordedBuild` | Links settings/outcome to the committed call/result entry IDs and session revision |
| `InvestigationOutcome` | Passes the conclusion's anchors and recommended settings to the knowledge worker |
| `ContextToolCall` / `ContextToolReply` | Preserve orchestration request/reply correlation |
| `ExampleRunSummary` | Exposes observed example state/control flow to its integration tests |

`Publication.EnsureApplied` checks `IContextMutationResult.Status` before returning
the committed revision. It stops on failure rather than silently rebasing or
retrying. Merely receiving a mutation result does not mean data was stored.

Keep the identities distinct:

| Identity | What it identifies |
|---|---|
| `SessionId` | One canonical conversation history |
| `EntryId` | One transcript entry, including an individual tool call or result |
| `ToolCallContent.CallId` | A build-tool invocation paired with its recorded result |
| `AnchorId` | A named passage addressed by its start/end entry IDs |
| `ContextToolCall.CallId` | One orchestrator read-tool request and its matching reply |
| Session / memory revision | The captured or published version of that particular state |

An agent's read-tool request ID is not a session ID, an anchor ID, or the ID of
a previously recorded profiler invocation.

## 3. Follow a new investigation

Open `InvestigationCoordinator.Investigate`.

1. **Record the request.** Capture A's revision, describe a `ContextChangeSet`
   containing `AppendEntries`, call `Apply`, and check the returned status.
   The command describes a transcript update; it does not execute a build.
2. **Ask the runner for a baseline.** The runner invokes the application's build
   adapter and records its completed invocation/result in A.
3. **Invoke reasoning for a trial.** The coordinator passes explicit settings and
   the observation to `IReasoningModel.ProposeTrial`. It records the returned plan
   against the baseline's committed revision.
4. **Run the trial.** The build runner records another invocation/result pair in A.
5. **Invoke reasoning for an explanation.** The coordinator receives an explanation
   from `IReasoningModel.Explain`; the library does not infer a better setting.
6. **Create anchors.** One topic anchor spans the experiment; one decision anchor
   addresses its conclusion. Both use canonical entry IDs.
7. **Publish conclusion and anchors together.** One change set appends the
   conclusion, then creates the anchors referring to it. Readers see either the
   previous root or the complete new root.

Read `BuildRunnerWorker.RunAndRecord` alongside that method. Its comments separate
**capture -> execute -> describe -> publish -> check -> return identities**:

- Capture the session revision, then release the read before a potentially long
  external operation.
- Invoke `IBuildProfiler.Run` outside the library.
- Assign canonical entry IDs and a shared call/result correlation ID.
- Describe one atomic append of the completed call/result pair.
- Call `Apply` with the original expected revision and check its outcome.
- Return the actual committed revision and IDs to the coordinator.

If another writer advances A during the external operation, recording can fail
with `RevisionConflict`. The external work has already happened; a storage
failure does not undo it. A real host must retain the job result while deciding
how to record or discard it, rather than automatically rerunning the tool.

### Revision sequence in the runnable example

| Action | A revision | Memory catalog revision | Scripted model-adapter invocations added |
|---|---:|---:|---:|
| Initialize empty sessions | 0 | 0 | 0 |
| Record the request | 1 | 0 | 0 |
| Record baseline call/result | 2 | 0 | 0 |
| Obtain a trial; record the plan | 3 | 0 | 1 |
| Record trial call/result | 4 | 0 | 0 |
| Obtain an explanation; publish conclusion/anchors | 5 | 0 | 1 |
| Publish local/shared memory | 5 | 1 | 0 |

These are separate state domains. Publishing memory does not advance A to r6.
The follow-up run later advances **B** from r0 to r1.

## 4. Follow local notes and shared knowledge

Open `KnowledgeWorker.PublishApproved`.

The host explicitly invokes this worker after its confirmation policy permits
publication. The scripted example approves a configuration to demonstrate
sharing; it does not prove that configuration is optimal.

The method captures repository identity and the expected catalog revision, then
constructs two `ContextMemory` records:

- A session-scoped note: "Keep verbose profiler traces for this investigation only."
- Repository-scoped JSON containing the application-defined `BuildSettings`.

Both point to A's experiment through `MemorySource`. Confirmed memory requires
source anchors, which the library validates when publishing. A single
`MemoryChangeSet` publishes both records against the expected **catalog**
revision. The record's initial `Revision: 0` is not that concurrency check;
the library stamps accepted records with the new catalog revision.

```text
session A requests [A scope + repository scope] -> local note + configuration
session B requests [B scope + repository scope] -> configuration only
```

Scopes describe applicability, not authorization or automatic deletion. Session
and memory roots are not captured as one cross-catalog transaction. Expiry filters
newly captured reads; it does not evict records or alter old snapshots.

## 5. Follow the follow-up agent's cache path

Open host phase D, then `BuildRunnerWorker.TryGetReusableSettings`.

This is a **code-driven agent policy**: before planning another investigation,
ordinary application code checks existing knowledge. It does not first ask a
model to remember a previous conversation.

1. Derive repository identity from B's stored session.
2. Open a repository memory view, bounded to 16 records. Library policy filters
   applicability, confirmation, and captured expiry.
3. Decode the application's JSON format and check tool, version, workload, and
   worker-count compatibility. These are application checks, not built-in cache
   semantics.
4. Follow the returned source IDs and resolve the experiment anchor.
5. Require `Current` under this example's conservative policy. An unrelated later
   session edit can make an anchor `Edited`, so this policy can reject useful data.
6. On a hit, reuse settings and invoke the build adapter without calling the
   coordinator's planning/explanation methods.
7. On a miss, let the host choose a new investigation. A truncated view is not
   proof that no other configuration exists.

This makes the reuse branch explicit and testable. It is not automatic
memoization, a distributed cache, or a claim that every job avoids reasoning.
Unavailable provenance/admission errors also need an explicit host policy;
the example does not silently call a model on every error.

## 6. Follow a person or model-driven agent into a view

Open host phases B/C and `ContextToolAdapter.Execute`.

**Human button:** the UI knows that Navigation means navigation. It dispatches
`context_view` directly. The adapter opens a navigation view, materializes
titles/IDs/statuses, serializes the result, and disposes the view. No model is
needed merely to select the operation.

**Human chat:** a live orchestrator supplies the model with the README's tool
descriptions, argument schemas, active session ID, and instructions. The model
selects a read tool. The host executes its name/arguments through the adapter,
then associates the resulting JSON with the original tool-call ID. It may invoke
the model again to compose prose, or display structured results directly.
`ScriptedReasoningModel.SelectContextTool` is the offline stand-in for that
provider integration; it returns a fixed search request.

**Model-driven agent:** receives the same tool contracts. It can select scoped
memory, inspect its sources, and choose its next action. Tool execution is native
code, but model selection/continuation still requires inference in a live system.

The adapter exposes:

| Request | Code path |
|---|---|
| Navigation | `OpenView(ContextViews.Navigation(...))` |
| Search | `OpenView(ContextViews.Search(...))` |
| Memory | Derive requested scopes, then `OpenView(ContextViews.Memory(...))` |
| Source anchor | `OpenRead`, `ResolveAnchor`, bounded `ReadRange` |

The application validates schemas and caller access. The demonstration's host
allows its two sessions; model-supplied IDs do not grant access. The adapter
never evaluates generated C# and never returns a live disposable view to a model.
Missing/partial target status is returned rather than fabricated text.

Navigation uses stable entry endpoints, not screen offsets. Grouping and layout
are UI choices; anchors do not automatically rewrite summaries or recover
deleted entries. Lexical search can return ordinary entry hits as well as anchor
hits; only the latter have anchor IDs for the anchor-read tool.

## 7. Identify real integrations versus simulations

Open `SimulationAdapters.cs`.

`SimulatedBuildProfiler` reports `BuildObservation("Completed")`. It does not
execute a build, collect performance data, or invent a duration.
`ScriptedReasoningModel` chooses a fixed trial and search tool, counting adapter
invocations without contacting a model.

For a real system, implement `IBuildProfiler` and `IReasoningModel` and wire them
at the composition root. Your application still owns scheduling, permissions,
confirmation, provider registration, and external-operation recovery policies.

There is **one implementation**, in the example project. This document supplies
the reading order, rationale, and expected behavior.

## 8. Expected observations and validation

The output includes actual generated entry/anchor IDs, stored payloads, and:

```text
Workers sharing one owner: 3; memory revision: 1
Direct UI model-adapter invocations added: 0
Follow-up reused cached workers: 4
Follow-up model-adapter invocations added: 0
Applicable memories: investigation=2, follow-up=1
Session revisions: investigation=5, follow-up=1
Model-adapter invocations total: 3; simulated build runs: 3
```

Two scripted model-adapter invocations belong to the initial investigation;
one selects a search tool. Direct navigation/source lookup and the compatible
follow-up branch add none. No actual model inference occurs in this offline
example. These counts describe control flow, not measured provider cost or
token savings.

`tests\LLMContextLib.Tests\BuildInvestigationExampleTests.cs` exercises the project
directly on both target frameworks. It covers the whole flow, atomic call/result
publication, a competing writer without automatic tool reruns, compatibility
checks, conservative source-status policy, scope isolation, and source-ID reads.

The example is not a benchmark. Library benchmarks remain separate under
`benchmarks\LLMContextLib.Benchmarks`.
