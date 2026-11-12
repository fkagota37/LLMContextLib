# LLMContextLib

> **Experimental / work in progress.** This library is **not production-ready**
> and has **no stable, versioned release**. APIs, behavior, resource policies, and
> any future persistence formats may change without compatibility guarantees.
> Use it for evaluation and prototyping; passing tests or benchmark results are
> not production-readiness certification. See `TODO.md` for open design concerns
> and opportunities.

**Turn a conversation into a shared, navigable workspace for people and agents,
not just a growing prompt.**

LLMContextLib is a .NET library for applications that need to revisit decisions,
connect tool results to their reasoning, and reuse knowledge across related
conversations. Store a session once; expose conversation, navigation, search,
memory, and model-input views without maintaining separate transcripts.

```text
                       One session history
                               |
        +----------------------+----------------------+
        |                      |                      |
  Conversation UI        Navigation outline      Tool inspection
  messages to show       topics and decisions    calls and results
                               |
                       anchors into the text
                               |
                     scoped, reusable memory
                               |
                  model input within a token budget
```

The application still runs tools, calls models, renders its UI, and schedules
workers. **LLMContextLib is its shared context layer**, not a model runtime,
autonomous-agent framework, or build runner.

For integration details, see **Resource ownership and lifetime**, **Loading
existing sessions**, and **Memory-growth safeguards and their limits** below.

## Example Use Case: an automated build-investigation assistant

Consider an existing coding assistant that investigates slow builds. It already
has a build/profiler integration, a model adapter, and a user interface. We plug
LLMContextLib into that system so it can:

- Record what was tried and which tool output supported the conclusion.
- Let a person jump directly to the experiment behind a recommendation.
- Keep temporary notes local to the investigation.
- Let a follow-up agent reuse compatible settings without repeating the planning.

Our example has **exactly three logical application workers**, sharing **one**
owning library client. The UI/tool adapter is an additional reader, not a fourth
background worker:

| Component | What it does | What it shares |
|---|---|---|
| Coordinator worker | Records the request, asks the model for a trial and an explanation, creates decision anchors | Reads/writes investigation session A |
| Build-runner worker | Executes the existing profiler, records settings/results, checks reusable configurations | Reads/writes A and follow-up session B; reads repository memory |
| Knowledge worker | Publishes an application-approved configuration and a temporary note, each linked to its source | Reads A; writes the separate memory catalog |
| UI / context-tool adapter | Serves navigation clicks, search requests, memory views, and source jumps | Reads the same owner; returns bounded results |

```text
                  Existing application / orchestrator
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

 Person's UI command ----> context-tool adapter <---- Agent's tool call
                                      |
                               the SAME owner
```

**What does "sharing a session" mean?** Workers receive the same
`ILLMContextPolymorphicArray` handle and the same canonical `SessionId`. They
do not pass around a mutable conversation object. `LLMSessionContext` is one
immutable revision; `OpenRead` captures a revision, and a write publishes a new
one. Creating a separate owner for every worker would create separate stores.

The three workers are roles in the application, not library threads. The
executable example invokes them sequentially to expose the causal order.
A real scheduler can overlap readers and independent work. The coordinator and
build runner can both write A, so their writes must check expected revisions.
The library does not schedule those jobs or resolve their competing intentions.

> **Run and read the fully commented implementation:** `examples\BuildInvestigation`.
> It contains the host, all three worker classes, the tool adapter, and explicit
> offline simulations. `docs\build-investigation-assistant.md` is a supplementary
> walkthrough of those source files, not a second implementation to copy.

## Two ways in: a person asks, or an agent decides

### A person clicks a view or asks a question

**Button path:** the user clicks **Navigation**. The UI already knows the desired
operation, so it dispatches a typed command directly. No model needs to interpret
the button. The adapter opens `ContextViews.Navigation`, materializes the anchor
titles/IDs/statuses, releases the view, and returns rows the UI can render.

**Chat path:** the user asks **"Find the decision about workers."** The orchestrator
supplies the model with the available context-tool definitions and active session
ID. The model selects a search operation; the host executes it through the adapter.
The model may then explain the results, or the UI can display the structured
results directly. Tool selection and optional prose generation are inference;
executing the library search is not.

```text
User clicks [Navigation]                     User types a question
          |                                          |
    direct command                          model selects a tool
          |                                          |
          +----------------------+-------------------+
                                 |
                    context_view(sessionId, arguments)
                                 |
                    Application's ContextToolAdapter
                                 |
                    contexts.OpenView(view definition)
                                 |
                   IDs + snippets/titles + revisions
                                 |
                 UI renders links / model explains results
                                 |
                     User selects a source anchor
                                 |
                  context_read_anchor(sessionId, anchorId)
                                 |
                   OpenRead -> ResolveAnchor -> ReadRange
                                 |
                     bounded source text for display
```

| User request | Application tool | Native library operation |
|---|---|---|
| Open the topic/decision outline | `context_view`, `view: "navigation"` | `ContextViews.Navigation` |
| Find mentions of workers | `context_view`, `view: "search", query: "workers"` | `ContextViews.Search` |
| Show this session's working notes | `context_view`, `view: "memory", memoryScope: "session"` | `ContextViews.Memory` |
| Open the experiment behind a result | `context_read_anchor`, using returned IDs | `ResolveAnchor` and a bounded `ReadRange` |

These are **application-defined tool contracts**, not built-in agent bindings
shipped by the library. Your host registers their handlers. The linked walkthrough
explains their implementation in `examples\BuildInvestigation\ContextToolAdapter.cs`.

### An agent knows through tool contracts, instructions, and runtime results

The agent does not discover a .NET DLL by intuition. Its host supplies:

1. **Descriptions and argument schemas:** what each registered operation does and
   which arguments it accepts. These are supplied through the orchestrator's
   tool/function-calling interface.
2. **Task context and instructions:** the active session ID, when to consult
   memory, and what must match before reusing a configuration.
3. **Actual results:** canonical IDs, captured revisions, content, and target
   statuses returned by executed tools. Follow-up calls use these references.

For example, the host can instruct a model-driven agent:

```text
Before configuring a tool, inspect applicable session/repository memory.
Check the cached payload's tool, version, and workload key.
Use returned source IDs to inspect the supporting experiment when needed.
Do not invent entry IDs or anchors.
If the evidence is inadequate, perform a new investigation rather than claiming reuse.
```

<details>
<summary>Concrete read-tool definitions supplied to the model</summary>

The descriptions explain the operations; the schemas describe their arguments.
The application must also register the corresponding executable handlers.
This provider-neutral example is adapted to your chosen orchestrator's format,
not passed to a library-specific registration API.

```json
[
  {
    "name": "context_view",
    "description": "Retrieve navigation, lexical search results, or applicable memory. Use returned IDs for follow-up calls. Search requires query; memory requires memoryScope.",
    "parameters": {
      "type": "object",
      "properties": {
        "sessionId": { "type": "string", "format": "uuid" },
        "view": { "type": "string", "enum": ["navigation", "search", "memory"] },
        "query": { "type": "string" },
        "memoryScope": { "type": "string", "enum": ["session", "repository", "sessionAndRepository"] },
        "limit": { "type": "integer", "minimum": 1, "maximum": 32 }
      },
      "required": ["sessionId", "view", "limit"],
      "additionalProperties": false
    }
  },
  {
    "name": "context_read_anchor",
    "description": "Read the bounded passage behind an anchor returned by navigation, search, or memory provenance. Check the returned target status.",
    "parameters": {
      "type": "object",
      "properties": {
        "sessionId": { "type": "string", "format": "uuid" },
        "anchorId": { "type": "string", "format": "uuid" },
        "limit": { "type": "integer", "minimum": 1, "maximum": 32 }
      },
      "required": ["sessionId", "anchorId", "limit"],
      "additionalProperties": false
    }
  }
]
```

</details>

Now the model can request repository memory, receive settings plus their source
references, and request the source passage. It does not need the entire transcript
in its prompt just to locate that passage. The orchestrator returns each executed
result under its corresponding model tool-call ID, then resumes the model if
further reasoning is needed.

For writing agents, expose additional application handlers with their own schemas:
record a completed tool run through `AppendEntries`, bookmark its conclusion
through `PutAnchor`, and publish approved knowledge through `ApplyMemory`.
Return status/revision rather than telling the agent that a failed write succeeded.
The full walkthrough implements these native operations in its worker classes.

## What actually happens during a new investigation?

The runnable example demonstrates the following sequence. Its simulated tool
reports completion states, not invented durations or benchmark results:

```text
1. Coordinator stores the user's request                         session A -> r1
2. Build runner invokes baseline adapter; stores call + outcome   session A -> r2
3. Model proposes four workers; coordinator stores that plan      session A -> r3
4. Build runner invokes trial adapter; stores call + outcome      session A -> r4
5. Model explains; coordinator stores conclusion + two anchors    session A -> r5
6. Knowledge worker publishes local note + reusable settings      memory    -> r1
```

Steps 3 and 5 invoke the model adapter. The other steps execute application/tool
code and library operations. Each successful session change advances one session
revision. Publishing memory advances a **different** catalog revision; it does
not make the session revision 6.

### Follow the implementation as code

Start with `examples\BuildInvestigation\Program.cs`, then follow these classes:

| Source file | What to follow |
|---|---|
| `BuildInvestigationAssistant.cs` | Create one owner, inject it into three workers, route human/agent requests |
| `BuildRunnerWorker.cs` | Capture revision, invoke the build adapter, construct a change set, publish and check its result |
| `InvestigationCoordinator.cs` | Store the request/plan, invoke reasoning, publish conclusion and anchors |
| `KnowledgeWorker.cs` | Publish session-local and repository-scoped memory with provenance |
| `ContextToolAdapter.cs` | Map named read-tool requests to native views and anchor resolution |
| `SimulationAdapters.cs` | See exactly what is scripted and replace it with real application integrations |

The source retains class-level responsibility comments and numbered behavioral
steps. `Contracts.cs` explains the application records and publication check.
There is deliberately no second code implementation embedded in this README.

In the worker, read publication as **capture -> execute -> describe -> publish ->
check**. Constructing a `ContextChangeSet` does not execute the external tool;
calling `Apply` does not guarantee success. `ExpectedRevision` comes from the
captured session; the successful result returns the actual committed revision.

## Navigate the experiment instead of asking the model to rediscover it

The coordinator creates one topic anchor spanning the experiment and one decision
anchor at the conclusion. Each stores a title, summary, topics, source revision,
and stable start/end entry IDs:

```text
Navigation panel                         Session text

Worker-count experiment ----------------> Baseline tool call            [start]
                                          Baseline outcome: completed
                                          Plan: try four workers
                                          Trial tool call
                                          Trial outcome: completed
  Decision: use four workers -----------> Conclusion                    [end]
```

When a user clicks **Why four workers?**, the application already has the source
anchor ID. It calls `ResolveAnchor`, reads a bounded page between the resolved
endpoints, and renders the actual stored text. This path does not need an LLM to
summarize the conversation merely to locate the evidence.

Your application creates the anchors and UI layout. Anchors address whole entries;
store paragraph entries for paragraph-level navigation. Edits retain entry IDs,
but later revisions can conservatively report `Edited`. Deleted endpoints can
make a target `Partial` or `Missing`. Anchors do not regenerate summaries or
recover deleted text.

## Session-local memory and shared tool configuration

The knowledge worker publishes two records, both with a `MemorySource` pointing
to the experiment anchor:

```text
One owner, one repository
|
+-- Investigation session A
|     session scope: "Keep verbose profiler traces for this investigation only."
|     repository scope: reusable build-profiler configuration
|
+-- Follow-up session B
      session scope: no note of its own yet
      repository scope: the SAME reusable configuration
```

The application serializes settings such as the following into memory content.
These are application-defined fields; the library does not interpret them:

```json
{
  "Tool": "build-profiler",
  "ToolVersion": "example-v1",
  "WorkloadKey": "example-build",
  "Workers": 4
}
```

The surrounding `ContextMemory` carries repository scope, confirmation status,
expiry, and source anchors. The follow-up worker:

1. Requests repository memory for B. Library policy filters applicability,
   confirmation, and expiry for the captured read.
2. Parses its own payload and checks tool/version/workload compatibility.
3. Resolves the source anchor. This example additionally requires `Current`;
   that is a conservative application policy, not automatic cache invalidation.
4. If suitable settings are found, runs the next build directly with those
   settings and records the result in B.
5. Otherwise, takes a fresh-investigation branch that can call the model again.

This keeps an **optimization journey**, not just a winning number:

```text
Tool result -> experiment anchor -> approved scoped configuration
                                        |
                              another worker/session
                                        |
                              "Why this setting?"
                                        |
                           original inputs and results
```

The actual scope counts in the example are **A: 2 memories, B: 1 memory**.
Session B does not inherit A's local note. Sharing requires the same owner;
scope is applicability, not authorization. Expiry filters new reads but does not
evict stored records or change old snapshots. Refresh, confirmation, retraction,
tool-specific keys, and cache-miss behavior remain application responsibilities.

## Where does this avoid expensive LLM inference?

**By doing retrieval as ordinary code and reusing compatible stored results,
not by making model-selected tool calls magically free.**

| Path | What runs | Does this path require model inference? |
|---|---|---|
| Open a navigation panel | Native navigation view | No |
| Click an existing source link | Anchor resolution and bounded range read | No |
| Fetch scoped memory | Native memory selection | No |
| Deterministic agent finds compatible cached settings | Application checks plus library reads, then the real build tool | No model call in this example's cache-hit branch |
| Interpret "find the workers decision" | Model selects a registered search tool; host executes it | Yes for selection; the handler itself is not inference |
| Plan a new trial or explain new measurements | Existing model adapter | Yes |
| Produce a natural-language answer after a tool result | Optional model continuation | Yes, if the host requests it |

A model-driven agent receives tool definitions and decides which tool to call.
A code-driven agent can follow a predefined lookup/reuse policy and invoke the
same native operations directly. Both are agentic workflows; they have different
inference boundaries.

The executable example makes this visible: two model-adapter invocations for
the initial investigation, one for natural-language search selection, **zero**
additional invocations for direct UI navigation, and **zero** for the compatible
follow-up branch. It still invokes the simulated build adapter three times.
The simulations count adapter invocations, not real provider requests, tokens,
cost, or latency; no real build or model runs in the default example.

The library supplies the context operations that make these paths possible.
It does not automatically eliminate inference, guarantee cache hits, or establish
a universal cost/speed improvement. Search and reads still use CPU and allocations.
When inference is needed, `ContextViews.Model` can assemble applicable memory and
conversation content within a caller-supplied estimated token budget, preserving
selected tool-call/result pairs rather than sending the whole history blindly.

## Build, run the walkthrough, and verify

The library targets .NET 8 and .NET 9. Use the SDK selected by `global.json`;
running the full suite requires both runtimes. From the repository root:

```powershell
# Build the library and its existing test/benchmark projects.
dotnet build LLMContextLib.sln -c Release -m:1

# Exercise both supported target frameworks.
dotnet test tests\LLMContextLib.Tests\LLMContextLib.Tests.csproj -c Release --no-build

# Run the existing contextual-view demonstration.
dotnet benchmarks\LLMContextLib.Benchmarks\bin\Release\net9.0\LLMContextLib.Benchmarks.dll --demo
```

Run the **class-based assistant explained here** directly:

```powershell
# Use the supported framework installed on your machine.
dotnet run --project examples\BuildInvestigation\BuildInvestigation.csproj -c Release -f net9.0
```

The project also targets `net8.0`. It builds with the solution and has integration
tests in `tests\LLMContextLib.Tests\BuildInvestigationExampleTests.cs`.
Read `examples\BuildInvestigation\README.md` for the source map and
`docs\build-investigation-assistant.md` for the supplementary step-by-step view.
The offline simulations make the example runnable without a model provider or
an actual profiler. It is not a benchmark.

## Resource ownership and lifetime

**The host owns one client; workers borrow it; each operation owns its reads/views.**
Choose the owner lifetime around the sessions that need to share a memory catalog,
not around each individual request. Separate owners do not share memory.

The following is an application composition-root helper, not a library scheduler:

```csharp
static async Task RunApplicationAsync(
    IEnumerable<LLMSessionContext> initialSessions,
    Func<ILLMContextPolymorphicArray, CancellationToken, Task> runAndDrainWorkers,
    CancellationToken stoppingToken)
{
    // Create the sole owner. Inject this instance into every participating worker.
    // The using scope also disposes it if the orchestration reports an exception.
    using var contexts = LLMContextFactory.Create().Initialize(initialSessions);

    // This callback is YOUR orchestration. It must not finish, fault, or report
    // cancellation until every child worker has stopped using the owner.
    // For parallel children, await Task.WhenAll rather than leaving fire-and-forget
    // tasks behind; order dependent workers according to your workflow.
    await runAndDrainWorkers(contexts, stoppingToken);

    // Only the host disposes contexts, after all workers have finished.
}
```

In a service, shut down in this order: **stop accepting work -> signal worker
cancellation -> await every worker -> dispose the owner**. A worker's cancellation
token belongs to application orchestration; synchronous library calls do not
accept it. Owner disposal drains in-flight library calls, not arbitrary application
tasks that might try to call the owner again.

### Keep read/view scopes short

Open a read or view only while extracting the data needed by one operation.
`OpenView` already owns an underlying read lease; do not open another read merely
to use the view. For example, an application handler can return JSON, not a live
library handle:

```csharp
static string ReadNavigationJson(
    ILLMContextPolymorphicArray contexts,
    Guid sessionId)
{
    // This view owns both a captured read and its output-retention charge.
    // using releases both even if enumeration or serialization throws.
    using var view = contexts.OpenView(
        ContextViews.Navigation(sessionId, limit: 16));

    // Enumerate and serialize before disposing the view. The caller receives
    // ordinary JSON with canonical IDs, not an iterator tied to a disposed lease.
    return System.Text.Json.JsonSerializer.Serialize(
        view.Select(item => new
        {
            item.Anchor.AnchorId,
            item.Anchor.Title,
            item.Status
        }));
}
```

When metadata is needed before an external operation, copy the small value and
release the read first:

```csharp
long expectedRevision;
using (var read = contexts.OpenRead(sessionId))
{
    // Keep the concurrency token, not the whole session root or an open lease.
    expectedRevision = read.Session.Revision;
}

// Invoke the external tool/model after leaving the read scope.
// Then publish using expectedRevision and inspect the mutation result.
// A conflict does not undo external work and must not trigger a blind tool rerun.
```

Do not cache reads/views or return lazy enumerations over them. If a caller needs
data after disposal, materialize bounded application records first; those records
then have a caller-owned memory lifetime. Holding a raw session root from
`TryFind`, or retaining returned entry arrays, can keep data alive outside lease
accounting. A disposed handle does not invalidate already returned immutable data.

Already issued reads/views survive session removal and owner disposal, but that is
a supported snapshot guarantee, not the preferred shutdown order. Always dispose
every handle explicitly; garbage collection is not a substitute for releasing
retention accounting. Before shutdown, `GetStatistics()` can help check that
`RetainedReads`, `EstimatedRetainedBytes`, and `EstimatedViewBytes` have returned
to zero after work drains. Statistics describe this owner, not the process heap.

For a long-lived owner, explicitly remove finished sessions with `RemoveSession`
and delete unneeded memory with `ApplyMemory`, checking expected revisions and
outcomes. Closed/expired sessions are not automatically removed. Memory expiry
filters reads; it does not evict records. Removing a source session does not
cascade-delete memories that refer to it; coordinate evidence retention and cleanup
in the host.

## Loading existing sessions

**Existing decoded sessions can be ingested; file/network loading is not built in.**
The supported paths are:

| Situation | Library entry point | Behavior |
|---|---|---|
| Start a new owner with existing sessions | `LLMContextFactory.Create(options).Initialize(decodedSessions)` | Validates/indexes each graph; failure disposes the partially initialized owner |
| Add a session to a running owner | `contexts.CreateSession(decodedSession)` | Returns a mutation result; duplicate or previously removed session IDs are rejected |

```text
File / HTTP response / database
             |
   Application-owned bounded reader and decoder
   (schema/version checks, payload decoding, identity mapping)
             |
   LLMSessionContext values with immutable segments/anchors
             |
   Initialize(...) or CreateSession(...)
             |
   Validated session graphs + rebuilt internal indexes
```

Your host owns file/stream/HTTP response disposal, credentials, cancellation,
transport and decoded-size limits, and the persisted format. Define how payloads
such as `TextContent`, `ToolCallContent`, `ToolResultContent`, and `SummaryContent`
are distinguished and decoded; the library ships no persistence codec, JSON
discriminator configuration, `LoadFromFile`, or network-loading API.

Imported sessions preserve their supplied nonnegative revision. Their IDs,
entry ordering, segment limits, content, and anchors are validated; internal
location/search metadata is rebuilt rather than trusted from outside. Decoding
and index preparation happen before final resident-budget admission, so loading
an arbitrarily large graph is not made safe merely by configuring that budget.
Bound transport bytes, decoded sizes, session counts, and import concurrency first.

Import requires both endpoints of every included anchor to exist. A live session
can retain partial/missing bookmarks after deletion; importing such a root requires
an explicit application policy to omit or repair those bookmarks first. Not every
root that remains readable in a running owner is therefore directly re-importable.

This is **session ingestion, not full owner checkpoint/restore**. A new owner
starts with an empty memory catalog at revision zero. Memory must be loaded
separately through `ApplyMemory`, after its source sessions/anchors exist; accepted
records receive the new catalog revision. Session roots do not carry the owner's
removed-session reservations or previously deleted entry IDs, and initialization
reconstructs sequence counters from surviving entries. Do not treat them as a
durable archive of identity history, old snapshots, or a cross-catalog transaction.

## Memory-growth safeguards and their limits

**The library provides estimated admission/backpressure, not a hard heap cap or
automatic eviction policy.** With stable, meaningful estimators, publication
rejects proposed state that exceeds the configured estimated resident budget.
That is useful protection for cooperative workloads, but it does not make
arbitrarily large inputs or unlimited parallel work bounded.

The default construction policies are:

| Control | Default | What it bounds |
|---|---|---|
| `MaximumEntriesPerSegment` | 128 | Entries in one physical segment, not the whole session |
| `MaximumEstimatedBytesPerSegment` | 256 KiB | Sum of entry estimates in one segment |
| `EstimatedResidentByteBudget` | 64 MiB | Estimated active state plus retained roots and view output |
| `MaximumRetainedReads` | 128 | Open read leases, including leases owned by views |
| `MaximumEstimatedRetainedBytes` | 64 MiB | Estimated captured-root and view-output retention |
| `MaximumViewResults` | 4,096 | Requested view-result cap, not query/evaluator work |
| `AdmissionTimeout` | Zero | Fail without waiting for unavailable gate/budget capacity; not an end-to-end deadline |

Same-root leases share an identity-based root charge; different revisions are
conservatively charged in full even when their immutable graphs share objects.
An active root can also be charged as retained, so leave budget headroom for reads
instead of filling the entire resident estimate with active state.

Mutations report `AdmissionRejected` on gate/resource rejection. Opening reads or
views can throw when retention/output admission fails. These failures must produce
backpressure or an explicit application decision, not an unbounded retry queue.
Failed view evaluation/estimation/admission releases its acquired read lease.

The important remaining boundaries are:

| Growth path | Current limitation | Host responsibility |
|---|---|---|
| Import or mutation preparation | Candidate graphs and indexes are prepared before final budget admission; there is no public transaction-size or in-flight-preparation quota | Bound import/batch sizes, input bytes, worker concurrency, and queued work |
| Custom projections and model-context selection | Output is materialized before its byte admission; result limits do not bound intermediate allocation, candidate scans, or sorting | Bound projection payloads/work; provide meaningful projection estimates |
| Direct read results and escaped immutable roots | `ReadRange`/`ReadPage` arrays and caller-retained records are not tracked as retained view output | Enforce request/page limits and bounded caller caches; avoid retaining whole roots |
| Expired, superseded, or unused records | No background sweep, LRU eviction, or automatic summarization/pruning | Explicitly remove sessions/memory and define retention/evidence policy |
| Identity history and physical metadata | Deleted entry IDs, removed session IDs, and empty segments can remain; their estimates are charged, but there is no compaction API for them | Plan owner lifetimes/rotation; do not assume deleting payloads returns every byte or permits ID reuse |
| Process-wide load | Budgets are per owner and estimate selected structures, not all CLR/host allocations | Bound owner count, external payloads/caches, and pending operations; monitor actual heap/process memory too |

For an unbounded-duration service, do not claim memory is fully bounded without
those host controls. Stronger library-side hardening would need explicit
input/transaction/preparation limits and a defined import/retention policy; those
capabilities are not implied by the existing options.

## Other boundaries

Session and memory roots are captured independently, not as one cross-catalog
transaction. Writers use expected revisions; conflicts are not silently retried
or rebased. Resource byte limits are conservative estimates, not hard process-heap
caps. Persistence, distributed storage, model KV-cache replacement, and
exactly-once external-tool execution are outside the library's scope.

See `docs\llm_polymorphic.md` for the detailed contract,
`docs\evidence.md` for benchmark methodology and limitations, and `AGENTS.md`
for contributor guidance.

## License

MIT licensed. See `LICENSE` for the copyright notice and full terms. Dependencies
remain subject to their own licenses.
