# TypeScript port implementation work packet

Consumer documentation starts at the [port README](README.md). See
[parity](parity.md) for the public qualification statement and
[validation](validation.md) for reproducible checks. This packet retains the
engineering inventory and historical investigation record; proposed checklist
filenames below are not a literal map of the completed source tree.

## Scope
This packet is the active parity inventory for the TypeScript port. It keeps staging as an internal implementation/validation order, not as a recurring scope approval gate. The required outcome remains full functional and contractual parity with the C# reference in `D:\source\LLMContextLib`; no partial slice is treated as completion.

The authorized source of truth remains the C# reference in `D:\source\LLMContextLib`. The destination remains the same repository at `D:\source\LLMContextLib-Ts`, branch `port/typescript`, root `D:\source\LLMContextLib-Ts\ports\typescript`.

## Full parity inventory
The port must remain synchronized with the C# surface area below. The categories below are the work queue; each item is implemented and validated as a coherent slice, not deferred by a blanket "later stage" note.

| C# contract | TypeScript implementation and evidence | Qualification boundary |
|---|---|---|
| Core models, factory, options | `domain/session.ts`, `domain/int64.ts`, `options.ts`, `factory.ts`; `supported-contracts.spec.ts` and `configuration-contracts.spec.ts` pin construction/copy, callback identity, reusable builders, strict recipe replacement, nested limits and operational errors; timestamp, record, option and arithmetic traces below | Finite supported-scenario evidence, not exhaustive enumeration or CLR runtime emulation |
| Owner publication, session and memory mutations | `storage/owner.ts`, `session-store.ts`, `memory-store.ts`; rollback, tombstone, provenance and ordered collector attribution; replacement-only and mixed pinned differentials, mailbox admission, independent worker writers and resource recovery | Overlapping speculative preparation and owner publication are distinct; no CPU-parallel service or CLR allocation/lock equivalence claim |
| Explicit reads, `WithCurrent`, and views | Local and worker captures, lazy scopes, 46 pinned built-in view observations; exact owner-local materialized-item estimator identity, rejection/recovery, disposed-handle error precedence and retained views after publication/removal/disposal | Worker-local estimation is an opt-in TypeScript extension, not a .NET transfer contract |
| Exact text/key search and producer-owned indexing | `policies/lexical.ts`, `storage/session-index.ts`; UTF-16 classification, exact/indexed pending search, captured-posting tests, mutation/partition/view and finite semantic-oracle differentials | Producer keys remain opaque; no inferred NLP semantics |
| Deferred lifecycle | Native and both maintained Lucene variants complete off-thread; paired lifecycle trace covers pending wait disposal, quiescence before memo teardown, retained exact fallback and completed captures | Arbitrary internal custom collectors and noncooperative worker termination are extension diagnostics, not supported .NET public-provider parity |
| Partitioned synchronization | Off-thread rebuilding and owner publication; seven paired snapshots plus cancellation/shared-wait, failure-before-compaction, strict write fencing, reopening and recovery traces | Between-partition failure injection is TypeScript-only; it is not paired source evidence |
| Execution and adapters | Maintained providers install separately with a core peer dependency; 12 installed concurrent-caller combinations, memo attribution/retained-key checks, native/Lucene shutdown, 320 LRU traces and 72 foreground-LFU diagnostic traces | Composed collectors/memos remain owner-serialized. LFU is a diagnostic only; pinned dependency's scalar matrix crashes and is not qualified |
| Example and verification tools | Offline BuildInvestigation outputs match C#. Native, Scan and Indexed match the independent oracle on canonical finite/concurrent replays and bounded ramp. Historical pressure evidence is retained separately; source-attributed fresh evidence is listed below. | Node diagnostics do not establish CLR lock/allocation equivalence, CPU overlap, throughput, capacity, or production readiness |

The implementation order remains internal and can be adjusted by coherent capability slices, but the outcome remains full parity and not a partial milestone claim.

## Required source inventory
Use the following source anchors as the implementation contract and validation baseline:

Run `tests/inventory-source-api.ps1 -ReferenceRoot D:\source\LLMContextLib -Framework net9.0` to export the pinned core and adapter assemblies' public types, declared members, signatures, enum values, optional parameters, and reflected defaults. Run each target framework in its own PowerShell process. The two Release inventories agreed: 62 exported types and 611 member rows, including compiler-generated record members. This is the source-side member denominator; it does not mark target mappings or behavior as verified.

Run `node --import tsx tests/reference/inventory-target-api.ts <source-inventory.json>` from the TypeScript port to emit the member ledger as JSONL. Both framework inventories account for all 611 rows: 304 declaration mappings, 268 explicit generated-record operations with differential evidence, and 39 generated CLR surface differences. Each difference records a caller scenario, observable result, source-use disposition and behavioral evidence. Options copying is supported through object spread; broader object equality and CLR-specific options formatting/hash/delegate representation are language-generated differences, not 39 behavioral blockers. Declaration mappings link to scenario tests but do not alone certify behavior. The 42 enum-member rows link to the separate encoding check. No parity percentage is inferred.

1. Core public contracts and immutable models
   - `D:\source\LLMContextLib\src\LLMContextLib\ContextModels.cs`
   - `D:\source\LLMContextLib\src\LLMContextLib\ContextIndexKeys.cs`
   - `D:\source\LLMContextLib\src\LLMContextLib\LLMContextFactory.cs`
   - `D:\source\LLMContextLib\src\LLMContextLib\LLMContextPolymorphicArray.cs`

2. Storage and lifecycle boundaries
   - `D:\source\LLMContextLib\src\LLMContextLib\SegmentedContextStorage.cs`
   - `D:\source\LLMContextLib\src\LLMContextLib\ContextState.cs`
   - `D:\source\LLMContextLib\src\LLMContextLib\ContextReadLease.cs`
   - `D:\source\LLMContextLib\src\LLMContextLib\ContextViews.cs`
   - `D:\source\LLMContextLib\src\LLMContextLib\ContextPolicies.cs`

3. Optional behavior and execution contracts
   - `D:\source\LLMContextLib\src\LLMContextLib\ContextExecution.cs`
   - `D:\source\LLMContextLib\src\LLMContextLib\ContextIndexing.cs`
   - `D:\source\LLMContextLib\src\LLMContextLib\DeferredContextIndexing.cs`
   - `D:\source\LLMContextLib\src\LLMContextLib\PartitionedContextIndex.cs`

4. Tests, example, and oracle assets
   - `D:\source\LLMContextLib\tests\LLMContextLib.Tests`
   - `D:\source\LLMContextLib\examples\BuildInvestigation`
   - `D:\source\LLMContextLib\benchmarks\LLMContextLib.Benchmarks`
   - `D:\source\LLMContextLib\benchmarks\LLMContextLib.TokenizationBenchmarks`
   - `D:\source\LLMContextLib\benchmarks\LLMContextLib.CachingBenchmarks`

## Historical implementation order
The implementation order is a staging aid for validation, not a missing-approval gate. The port continues in coherent capability slices while preserving the full parity target.

1. Core immutable domain models and enums
   - Session, segment, entry, content variants, memory scope, anchors, mutation statuses, and index-key shape should map 1:1 to the C# public contracts.
   - Preserve immutable semantics for session roots and content payloads.
   - Use explicit TypeScript types, readonly properties, and structural equality semantics without silently dropping invalid cases.

2. Factory and initialization contract
   - Model the same public entry point as `LLMContextFactory.Create(...)` and the builder pattern.
   - Carry `LLMContextOptions`, validation, and the execution strategy hooks without changing default semantics.
   - Keep the initialization path explicit and fail-clean before a usable owner exists.

3. Owner boundary and storage contract
   - Define the TypeScript equivalent of the owning client and storage interface.
   - Keep the public boundary interface-driven and separate from the concrete storage implementation.
   - Do not add a second mutable store or a public writable session array.

4. Read-lease and view semantics
   - Define the read lease and view interfaces before storage implementation.
   - Preserve lifetime and escaped-handle rules as a contract, not just a convenience function.

5. Mutation, publication, and search/index parity
   - Add the exact revision/update, memory, and producer-owned key behavior from the C# reference.
   - Validate against explicit parity tests before treating a slice as complete.

## Historical file-by-file implementation checklist

### A. Domain and public API files

- `ports/typescript/src/domain/session.ts`
  - `LLMSessionContext`, `ContextSegment`, `ContextEntry`, `ContextContent`, `TextContent`, `ToolCallContent`, `ToolResultContent`, `SummaryContent`
  - `ContextRole`, `SessionStatus`, `AnchorKind`, `MemoryStatus`, `ContextMutationStatus`, `AnchorTargetStatus`
  - Keep all fields `readonly` and all generated/derived IDs explicit.

- `ports/typescript/src/domain/anchors.ts`
  - `ConversationAnchor`, `MemoryScope`, `MemorySource`, `ContextMemory`
  - Add the `IndexKeys` optional property and preserve producer-owned key semantics.

- `ports/typescript/src/domain/mutations.ts`
  - `ContextEntryDraft`, `ContextChange`, `AppendEntries`, `ReplaceEntry`, `DeleteEntry`, `ReplaceSegment`, `PutAnchor`, `RemoveAnchor`, `SetSessionStatus`, `ContextChangeSet`, `MemoryChangeSet`
  - `IContextMutationResult`, `ContextMutationResult`
  - Keep successful vs conflict vs invalid status mappings explicit.

- `ports/typescript/src/domain/reads.ts`
  - `ContextCursor`, `ContextPage`, `ContextSearchHit`, `AnchorResolution`, `ModelContextItem`
  - `ILLMContextReadLease`, `ILLMContextViewDefinition<T>`, `ILLMContextView<T>`, `ILLMContextPolymorphicArray`, `LLMContextStatistics`, `LLMContextOptions`
  - Document which operations are default implementations and which are unsupported by default.

- `ports/typescript/src/domain/index-keys.ts`
  - `ContextIndexingMode`, `ContextIndexKeys`
  - Mirror the exact behavior: dedupe + ordinal sort, no content-derived normalization, explicit `Empty` value.

### B. Factory and configuration files

- `ports/typescript/src/factory.ts`
  - `LLMContextFactory.Create(...)`
  - `LLMContextFactoryBuilder`
  - builder chain methods for `WithExecutionStrategies`, `WithNativeTermCollection`, `WithProducerOwnedIndexing`, `WithPartitionedIndexing`, and `WithoutTermMemoization`
  - `Initialize(...)` entry path and fail-clean initialization semantics.

- `ports/typescript/src/options.ts`
  - `LLMContextOptions`
  - Validation rules for budgets, defaults, deferred-indexing config, and execution strategy compatibility.
  - Preserve ordinary factory defaults separately from any explicit WriteOptimized preset logic.

- `ports/typescript/src/execution/strategy.ts`
  - `ContextIndexingStrategy`, `ContextPreparationStrategy`, `ContextExecutionOptions`, `ContextExecutionStatistics`
  - execution recipe and scheduling behaviors without changing public semantics.

- `ports/typescript/src/execution/collectors.ts`
  - collector and memo interfaces and their native/default implementations
  - ensure producer-owned mode rejects memo/collector usage explicitly

### C. Storage and owner boundary files

- `ports/typescript/src/storage/interfaces.ts`
  - abstract storage interface contracts for `TryFind`, `Create`, `Remove`, `Apply`, `ApplyMemory`, `OpenRead`, and statistics

- `ports/typescript/src/storage/owner.ts`
  - the single owning client implementation that gates disposal but not reads
  - `TryFind`, `CreateSession`, `RemoveSession`, `Apply`, `ApplyMemory`, `OpenRead`, `OpenView`, `GetStatistics`, `WaitForIndexingAsync`, `SynchronizeIndexAsync`
  - read-view retention and output accounting semantics

- `ports/typescript/src/storage/lease.ts`
  - a concrete lease that captures session/memory roots independently and preserves read lifetimes
  - `Search`, `SearchKeys`, `ResolveAnchor`, `GetApplicableMemory` semantics

- `ports/typescript/src/storage/indexing.ts`
  - deferred-indexing, pending-entry coverage, index generation, and synchronization state
  - keep precise behavior separate from production storage logic until proven

### D. Policy and helper files

- `ports/typescript/src/policies/text.ts`
  - canonical text/term extraction, UTF-16 handling, ordinal comparison, snippet generation, and prefix semantics

- `ports/typescript/src/policies/search.ts`
  - search hit ordering and result filtering rules
  - empty/no-token behavior and exact-match vs text-derived semantics

- `ports/typescript/src/policies/estimation.ts`
  - conservative byte accounting, retained-root estimates, and projection output accounting

### E. Validation files

- `ports/typescript/tests/domain-contract.spec.ts`
  - type-level and runtime validation of the public domain model surface
  - exact integer and UTF-16 checks, plus immutable-object contract tests

- `ports/typescript/tests/factory.spec.ts`
  - builder behavior, default options, fail-clean initialization, and invalid input rejection

- `ports/typescript/tests/lease-view.spec.ts`
  - lease lifetime, disposed-read rejection, and view retention semantics

- `ports/typescript/tests/sync-conflict.spec.ts`
  - strict expected revision behavior and no hidden retry/rebase

- `ports/typescript/tests/search-rules.spec.ts`
  - exact Search vs SearchKeys behavior and empty-query semantics

### F. Port-only bootstrap notes to keep separate from implementation

- `ports/typescript/bootstrap-target-profile.md` remains a bootstrap record, not an implementation spec.
- Pending entries stay in the implementation queue; a green subset does not defer them.

## Historical internal implementation order

1. `domain/session.ts` and `domain/anchors.ts`
2. `domain/mutations.ts` and `domain/reads.ts`
3. `domain/index-keys.ts`
4. `options.ts` and `factory.ts`
5. `storage/interfaces.ts` and `storage/owner.ts`
6. `lease.ts`, `policies/*`, and `execution/*`
7. validation tests and parity-targeted fixtures

This order is an internal validation sequence, not an approval gate. Full implementation against the C# source is already authorized.

## Critical invariants to carry into the TypeScript port
- One owning client per session owner, with no public mutable root or writable array.
- Atomic publication of a complete immutable session root.
- Stable canonical IDs and no identity reuse after deletion.
- Strict expected revision conflict behavior; no silent retry/rebase.
- Captured reads/views survive writes, removal, and owner disposal.
- Text-mode and ProducerOwned-mode differences remain explicit and must not be silently collapsed.
- Synchronous admission waits must remain explicit; the port must not convert to async-only contracts without a written owner-approved deviation.
- Numeric overflow and UTF-16 ordering are contract-critical; do not silently coerce values.

## Contract dispositions and runtime-specific evidence
These dispositions follow the pinned library's supported caller paths; they do not require a user decision.
- No direct record `Equals(object)` call was found in the pinned library or maintained adapters. Equal-ID independently constructed `MemoryScope` values match both policy and storage lookups in the paired fixture. Publication/change detection retains reference identity, and typed helpers separately preserve element versus immutable-array backing identity. Record construction is unchanged; nominal branding is not introduced to close reflection rows.
- Owner-local projection estimation receives the exact materialized item, with paired admission/release and callback-failure evidence. .NET defines no Node worker-transfer contract. An explicitly authorized worker-local estimator plus owner-side admission is a separately tested TypeScript extension; arbitrary closure transfer or worker-local object identity is not counted as missing .NET behavior.
- Checked signed `Int64` revisions, sequences, cursors, segment IDs, generations, byte limits/estimators and aggregate reservations are implemented, with wide cumulative statistics. Numeric qualification uses pinned finite matrices, not exhaustive enumeration of the signed range.
- Node's same-isolate callbacks cannot release retained capacity while the isolate is blocked in a synchronous admission call. `admission-mailbox.spec.ts` exercises bounded read, projected-output, create, update, and memory resident admission with an independent trusted peer. Create rechecks its ID reservation and deferred queue capacity after waiting. A waiting update holds its session publication gate at commit; a waiting memory write holds the separate memory gate. Partitioned preconstruction waits preserve the captured revision and synchronization epoch: a competing publication conflicts, speculative preparation cannot cross synchronization, and serialized preparation admits the write before synchronization starts. Direct same-isolate reentry cannot queue.
- `worker-context-peer.spec.ts` exercises `ReplaceSegment`, strict revision conflicts, paging, entry lookup, exact/indexed/key search, anchors, captured memory, and cancellation of asynchronous indexing waits alongside synchronous calls. Older captures see their original roots, even after owner disposal, and disconnected workers release captures. Two independent workers writing against one revision produce one publication and one conflict. The installed-package check covers factory-created endpoints, session lookup/create/removal, a lazy `withCurrent` scope, deferred indexing waits, and real partition compaction from a worker. The bounded worker route also prepares unpartitioned text, deferred text, and producer-owned mutations on a projected slice; the owner still computes and publishes the index and checks revision, resource, and backlog admission. `entry-preparation-workers.spec.ts` compares these modes against inline publication and verifies two offloaded candidates conflict rather than silently rebasing. Composed strategies keep their collectors and memos owner-local; rejected worker preparations rerun inline on the same captured revision so callback ordering and statistics match rollback on the inline path. Custom entry estimators still require inline preparation. Concurrent installed-adapter callers, attribution and retained hot keys are covered by the 12-case matrix; composed CPU-parallel service is not claimed.
- The installed package runs two barrier-coordinated workers against one owner created with the unmodified `WriteOptimized` preset. It checks overlapping replacement-only batches, one applied write and one revision conflict, old captures, winning-key visibility after compaction, no intermediate key visibility, and zero remaining reads and view charges. It also checks a whole-segment replacement and an atomic replacement/deletion/generated-ID append transaction. The bounded speculative preparation path covers built-in session commands, including mixed transactions, from peers with the default estimator and no composed execution strategy. Mixed requests transfer only addressed segments/anchors, the append tail when needed, allocator counters, and relevant identity membership; they run the inline rules on that slice. The owner materializes the persistent paths, checks epoch/revision and admission, and publishes. `entry-preparation-workers.spec.ts` checks inline value/accounting equivalence, intermediate and final size validation, partition capacity and rollover, tombstones, anchor validation, captured roots, fences, saturation, and disposal. Direct same-isolate callers, custom estimators, composed strategies, and work that cannot be safely transferred still use inline preparation.
- Worker `openView` runs arbitrary local projections (including non-cloneable values) with the default estimator. A trusted endpoint can explicitly authorize a `WorkerContextPeer`-local `ProjectionSizeEstimator`; that callback receives the actual materialized values and the owner retains final budget admission and release. The installed checks cover authorization, function identity, custom charges, estimator exceptions, invalid estimates, output rejection, and capture cleanup. An owner-side RPC cannot apply an arbitrary owner closure to an original worker item: a Node 22 `MessageChannel` rejects a function with `DataCloneError`; a cloned class instance loses identity and custom prototype. The worker option is an additive target mechanism, not equivalence for arbitrary closures across isolates. Owner-local `OpenView` continues to use the configured estimator unchanged.
- Pipe `MutationOracle --write-optimized-mixed` to `node --import tsx tests/reference/verify-write-optimized-mixed.ts`. Five exact-preset snapshots match the C# reference directly against the TypeScript worker preparation path: rollback, a mixed replace/delete/append/anchor publication, compaction, the older read, and rejection of an appended-then-deleted ID. Observations include exact key hits, revision/generation, appended IDs, retained and active bytes, and per-rewrite accounting.
- Native and maintained Lucene deferred term collection and partition compaction now compute on a worker; publication and memo ownership remain on the owner, with content-revision, generation and reservation checks. Tests verify a synchronous output admission can progress during native collection, shutdown preserves old captures, and a waiting partition writer rechecks its original revision after compaction. The installed packages exercise the compiled native worker and both Lucene variants with BitFaster. A custom collector without a worker module still uses the owner event loop; worker-transport failure shutdown is bounded and falls back to termination if the graceful acknowledgment never arrives.
- A worker transport failure closes its channel and marks the worker stopped before invoking owner error handling, so the owner can dispose from the callback without waiting on its own exit notification. The regression test forces an uncloneable custom-worker result. This does not show strict join equivalence for arbitrary noncooperative custom providers.
- Cooperative deferred collectors acknowledge cancellation after the running callback has unwound; abrupt worker exit also signals the shared stop word from inside the worker, so synchronous disposal does not depend on processing a parent-side event. `index-maintenance-thread.spec.ts` checks both paths with a shared marker. The bounded fallback for noncooperative providers remains unchanged.
- Worker mutation completion can publish and reply directly from the mailbox while the owner waits synchronously for read admission. In the regression, a peer holds the last lease, waits for its offloaded append to publish, then releases the lease. The admitted reader still sees its captured revision 0 while the owner is at revision 1, matching the pinned C# `AdmissionOracle`. A Promise-only relay could not publish or reply until the blocked call returned.
- Build `ReplayOracle` against the pinned C# reference and save its `--concurrent-fixture` output to a JSON file. Run `tsx benchmarks/concurrent-replay.ts 32 0 <fixture.json>` and `tsx benchmarks/concurrent-replay.ts 32 500 <fixture.json>` with Node 22. The bounded driver uses four reader and two writer threads with matched Scan, Indexed and native requests over the same transport, across hot and distributed sessions of the pinned C# Interactive fixture. The verified pair emitted 12 cases and 2,304 requests. The independent oracle replays accepted commits in revision order and checks every captured range, model, search and anchor observation. The JSONL records all terminals, observations, raw queue/service/end-to-end timing, percentiles, memory samples, source/fixture digests and runtime. These are Node host-serialized service measurements, not independently parallel preparation, mixed-load ramp, or capacity evidence.
- Save `ReplayOracle --ramp-fixture` to `mixed-load-csharp-fixture.json`; with Node 22 run `tsx benchmarks/mixed-load-ramp.ts 100,500 300 <fixture.json>`. `mixed-load-ramp-retainer-100-500.jsonl` records 2,160 offered requests and exactly one terminal each across 12 isolated processes (Native/Scan/Indexed, hot/distributed, normal/slow). The scheduler matches the reference operation/session schedule; independent retention cycles trigger admission rejection and release every capture. The oracle checks successful reads and retained observations against accepted history. This does not demonstrate parallel service, the reference ramp's memory-ceiling/cancellation controls, or capacity.
- `mixed-load-ramp-controls-100-500.jsonl` reruns those 12 cases with active stop controls. `--max-heap-bytes=1` and `--max-rss-bytes=1` each stop a selected case before its first offer. The cancellation test stops future offers, reconciles queued work as cancelled, and permits in-flight service to finish. V8 `heapUsed` and process RSS are the target metrics; they are not C# managed/private memory measurements. `mixed-load-ramp-repeated-100-500.jsonl` uses `--repetitions=2` (now the default), with 24 seeded, randomized, isolated cases and 4,320 requests. The producer samples queued, in-flight, and terminal counts at each stage end; the independent counters can straddle service transitions. Parallel service and capacity remain unproven.
- `mailbox-reply-replay-{0,500}.jsonl` and `mailbox-reply-ramp-100-500.jsonl` rerun the `worker-preparation-*` experiments after the mailbox completion change. All four native replay cases and all four native ramp cases reached two in-flight preparations. The bounded ramp uses `--repetitions=1`, checked all 2,160 request terminals, and checks session and memory observations against the independent histories at their captured revisions. Native publication remains serialized by the owner; these runs do not establish CPU overlap, throughput, or capacity.
- Generate `pressure-{512,1024,4096,16384}.json` by running `ReplayOracle --pressure-fixture <entries>` against the pinned checkout. `tsx benchmarks/finite-pressure.ts <fixture-directory> 2 1` validated 54 isolated cases: begin/middle/end deletion across three history sizes, and the 3-by-3 changed-text/search payoff grid, each for Native, Scan and Indexed. `finite-pressure-54-cases.jsonl` includes separately timed initialization and replay, full oracle comparison before timing, and full final-entry verification after timing. This is a reduced-iteration mechanism check; it does not measure source-equivalent thread allocations or C# lock waits.
- The remaining pressure cases ran in isolated processes: `snapshot-pressure.ts <fixture-directory>` holds eight revisions through correction and append at each of three sizes; `admission-pressure.ts <pressure-512.json>` checks count timeout/release, retained-byte rejection and resident-byte recovery across the three participants; `contention-pressure.ts <fixture-directory>` additionally needs `pressure-2048.json` and checks 576 terminals across six 32-round cases. Raw outputs: `snapshot-pressure-9-cases.jsonl`, `admission-pressure-3-cases.jsonl`, and `contention-pressure-6-cases.jsonl`. Conventional admission is a harness poll, not a byte admission policy. Contention has three independent issuing threads but serializes actual service. V8 forced collection is kept out of operation timings.
- `tsx benchmarks/deletion-allocation.ts <pressure-fixture.json> 5` verified 45 individual deletions against the independent oracle across the three positions and sizes (512, 4,096, 16,384). The `deletion-allocation-{512,4096,16384}.json` traces retain all sampled stacks and distinguish index work, location-directory copy, and segment copy/construction. Median sampled index bytes by position at 16,384 entries were 13.9–14.5 MB, compared with about 2.63 MB for the location copy and about 1 KB for the named segment operations. These are V8 samples, not exact managed allocations, timing, retained bytes, or evidence that a storage rewrite is warranted.
- Postings, entry terms, anchors, and pending entries now share immutable balanced tree paths. On the same fixtures, `deletion-allocation-persistent-entries-{512,4096,16384}.json` records about 0.55 MB median sampled index allocation by position at 16,384 entries, versus 13.9–14.5 MB in the earlier reused baseline. This is stack-sampled allocation evidence, not interleaved timing evidence. The 125-step replay, mutation and partition differentials, and captured-root tests preserve the behavioral checks.
- Entry locations, identity tombstones, sequence order, segment and partition directories now also share tree paths. Range/paging uses a lower-bound seek on the pinned root; derived index generations reuse that order. Segment and partition totals are tree weights; mutation updates the anchor estimate only for changed anchors. Published segment iteration remains numerically ordered across the safe-integer boundary. Public anchor maps still copy on anchor edits, and bounded per-partition override maps still copy on override edits.
- `deletion-allocation-persistent-directories-{512,4096,16384}.json` verifies another 45 matched deletions. At 16,384 entries, median sampled index bytes by position fell to 17–20 KB and location updates sampled 2–194 KB, versus 13.9–14.5 MB for index work and about 2.63 MB for the original full location copy. At 512 entries, beginning/middle location updates cost about 120 KB versus about 82 KB for the original copy; independent path updates have a real cost when many offsets shift. The comparison reuses the saved baseline, measures neither latency nor managed allocations, and does not establish a general allocation win for every phase and fixture.
- The subsequent offset batch copies shared ancestor paths once per segment rewrite. In `deletion-allocation-offset-batch-{512,4096,16384}.json`, all 45 deletions still match the oracle. Median sampled location-update stacks for beginning/middle were approximately 42–44 KB at all three fixture sizes; end remained about 1–3 KB. These buckets measure the named directory operation stacks; the small temporary list of shifted offsets is built in storage preparation and is outside that bucket.
- `mutation-diagnostics.spec.ts` verifies opt-in synchronous owner timing and terminal attribution for stale, invalid, resource-rejected, and applied mutations under both preparation strategies. The diagnostic separates preparation, gate attempt, and resource/publication timing without a public API change. It does not measure current-thread allocation bytes, asynchronous worker service, or independently overlapping preparation.
- The main `MutationOracle` trace now matches 15 checkpoints, including `ReplaceSegment` with an invalid sequence, a valid replacement, and an intentional stale revision. It compares revision, read/search results, retained roots, segment rewrite estimates, and execution counters against the pinned C# source. The raw reference is `mutation-with-segment-replacement.jsonl`.
- `MutationOracle --timestamps` piped to `tsx tests/reference/verify-timestamps.ts` matched 10,014 `DateTimeOffset` observations covering range endpoints, offset rollover, leap-century/calendar rejection, and seeded instants at 100 ns precision. Raw output: `date-time-offset-differential.jsonl`.
- `MutationOracle --options` piped to `tsx tests/reference/verify-options.ts` matched five core/preset/deferred/partitioned/execution profiles, including the recovery reserve derived from the effective partition budget. `MutationOracle --int64` piped to `tsx tests/reference/verify-int64.ts` matched 4,217 checked additions, comparisons, overflow rejections and wrapping increments around signed and JS exact-number boundaries. Raw reference outputs: `option-defaults-differential.json` and `int64-differential.jsonl`.
- `MutationOracle --write-optimized` piped to `tsx tests/reference/verify-partitions.ts --write-optimized` matches seven exact-preset snapshots, including active/retained accounting, search, replacement, compaction, and deletion. It detected a phantom 512-byte TypeScript execution reserve when an options object carried the default execution settings; ordinary preset selection now leaves optional execution disabled unless routing is nondefault or explicitly composed on the builder.
- Maintained-adapter routing, reservation/lifetime, execution attribution, background cancellation/failure and shutdown are now covered by the paired lifecycle and installed-package matrices below. Noncooperative custom workers remain separately tracked extension diagnostics.

## Internal validation gate
The port proceeds in coherent slices while the project remains green and each changed slice is validated against the relevant C# contract:
- The TypeScript project remains green (`npm run build` and `npm test`).
- The domain model mapping remains aligned with the current public C# contracts in `ContextModels.cs` and `LLMContextFactory.cs`.
- Runtime-specific numeric/text risks are delegated to checked types and tests before deeper storage logic.
- The work remains in the additive `ports/typescript` area and does not interfere with the read-only C# source repository.

### Current executable evidence

- On Node 22.23.5, TypeScript type checking, ESLint, and all 112 Vitest tests passed. `npm run example:build-investigation` runs the offline example.
- Build `tests/reference/MemoOracle/MemoOracle.csproj` in Release and pipe the built assembly's JSONL output to `tsx tests/reference/verify-memo.ts`. The reference package is pinned independently of the TypeScript adapter.
- Build `tests/reference/MutationOracle/MutationOracle.csproj` in Release with `-p:ReferenceRoot=D:\source\LLMContextLib`, then pipe the executable assembly's JSONL to `tsx tests/reference/verify-mutation.ts`. The 15 checkpoints compare publication and captured revision, entries and anchor relocation/degradation, per-command collector attribution (including rollback and unchanged payloads), segment rewrites, and exact wide active/retained/view totals.
- Run that assembly with `--partitioned` and pipe its JSONL to `tsx tests/reference/verify-partitions.ts`. The seven checkpoints compare override shadowing, partial and compacted index generations, retained reads, deletion and recovery estimates. Capture the lazy read before sampling its retention charge.
- Build `tests/reference/ReplayOracle/ReplayOracle.csproj` with the same reference parameter and pipe its executable assembly's JSONL to `tsx tests/reference/verify-replay.ts`. With 128 entries per session, it compares all 125 full-value steps across the seven finite reference scenarios. The C# exporter runs its independent oracle against all three C# participants before emitting expectations. The scenario named `Concurrent` is a finite replay here, not a claim of concurrent execution.
- With both 128 and 512 entries per session, the independent TypeScript oracle and each of the three TypeScript participants matched the exported steps. Passing `--measure` to `verify-replay.ts` reports per-operation nanoseconds and a checked output digest for the three participants, excluding the oracle and full-value checks from timing. `--soak` runs 32 grow/capture rounds and eight released observations per participant on fresh state, and verifies all leases are released. On Node 22.23.5 the combined 128-entry run emitted 21 finite replay rows (375 terminal samples) and three retention rows. These runs are diagnostics, not latency or capacity claims.
- `npm run build:packages` emits three private, MIT-licensed local tarballs under `dist`. `npm run test:packages` installs the core by itself in an offline consumer before installing and composing the two optional adapters. Nothing is published.
- For early access on Node 22, run `npm run build:packages` then `npm run test:packages` in the TypeScript port. `examples/write-optimized-smoke.mjs` runs inside a clean consumer of the installed tarball and prints the actual mutation terminals, compaction, old/current key hits, and cleanup counters. An integrator can also copy the script into their own consumer of the tarball and run `node write-optimized-smoke.mjs`. It uses no adapters or external services. The overlap assertion is a separate installed-package check, not part of the smoke program.
- Run `tests/inventory-source-api.ps1` in a fresh PowerShell process for each reference framework, then `tsx tests/reference/verify-enums.ts <source-inventory.json>`. The net8.0 and net9.0 traces agree on all 42 members of 11 public enums; TypeScript intentionally uses each case's ordinal name as a string, not its CLR numeric ordinal. The installed-package check also verifies that storage and maintenance implementation classes are not public exports or accessible through a storage deep import.
- Pipe `MutationOracle --content-records` to `tsx tests/reference/verify-content-records.ts`. The 11 payload fixtures verify explicit `ContextContentRecords` equality, clone, positional deconstruction and invariant display. Equality is checked across 121 pairs each for operators and base-record dispatch, and 143 pairs for object dispatch including lookalikes and unrelated values. The scope is the four built-in payloads, not arbitrary CLR subclasses. Equality implies the same target-local 32-bit hash; JavaScript operators and storage identity checks are unchanged.
- Pipe `MutationOracle --scalar-records` to `tsx tests/reference/verify-scalar-records.ts`. The 46 fixtures and 529 comparisons cover 14 `ContextScalarRecords` schemas plus the BitFaster adapter's `BitFasterTermMemoOptionRecords`. Tests compare declared positional fields, invariant display, clones, same-type equality, command-tag mismatch, and the equal-values hash guarantee. The partitioned timeout is displayed in the CLR form for values representable as both milliseconds and TimeSpan ticks. Broader runtime-type equality overloads, numeric CLR hash identity and JavaScript operator substitution are not claimed.
- Pipe `MutationOracle --entry-records` to `tsx tests/reference/verify-entry-records.ts`. The 14 fixtures and 66 comparisons verify explicit `ContextEntryRecords` operations for entries, drafts and replacement commands with built-in content. DateTimeOffset equality compares UTC instants to 100 ns while invariant display keeps the supplied offset. Keys compare by reference (the `ContextIndexKeys.Keys` array is the TypeScript identity token); copies preserve that reference and the original payload. This does not claim general `Equals(object)`, `Equals(ContextChange)`, or custom CLR payload extensibility.
- Pipe `MutationOracle --compound-records` to `tsx tests/reference/verify-compound-records.ts`. The 55 fixtures and 181 concrete comparisons check `ContextCompoundRecords` and all seven command schemas. The 462 additional comparisons check `ContextChangeRecords` against base-type CLR dispatch, including cross-command tags and null. Collection fields compare by backing reference rather than contents; nested records use typed equality. Tests check positional collection identity, shallow copy, invariant display, and equal-values hash consistency. Required collection fields do not represent an uninitialized CLR `ImmutableArray<T>`; arbitrary-object equality and numeric CLR hashes are not claimed.
- `benchmarks/foreground-lfu.ts` is a diagnostic-only, MIT-attributed adaptation of BitFaster.Caching 2.6.1 at `a71bec32a6b7f621af7a9d2b1d7c4edd0209b289`. `MemoOracle --lfu` and `verify-lfu.ts` match 72 foreground W-TinyLFU traces and 147,456 hit/count observations, including retained membership, buffered reads, aging and adaptive partitioning, using matched deterministic UTF-16 hashes. The 894-step pinned regression fixture additionally checks owner isolation and retained values after disposal. The maintained adapter remains LRU; no library preset was changed.
- Foreground LFU qualification is for the pinned reference's AVX sketch-aging path. Repeating the source trace with `DOTNET_EnableAVX2=0` crashes inside BitFaster.Caching `EvictFromMain` after six traces. `scalar-lfu-reference-error.log` and the partial JSONL retain that failure; the strengthened target verifier rejects the truncated matrix. Scalar-path qualification is not claimed, and the reference/package remains unchanged. This benchmark diagnostic failure is not an unsupported .NET public-library contract decision.
- Tokenization/cache/heap diagnostics support `--verify-only` and `--reverse`. The current three caching policies are uncached, maintained LRU, and diagnostic foreground LFU. LRU uses a diagnostic-only 32 MiB reservation so each source-admitted <=8192-character payload fits its allowance; this does not alter production budgets or WriteOptimized. Fresh batch/per-call caches, retained-key hashes, rotating adjacent order and raw percentiles remain enabled. V8 heap snapshots, estimated key/membership bytes, sampled allocation, and observed release are distinct metrics; no CLR heap equivalence or performance win is inferred.
- `tests/compare-build-investigation.ps1 -Dotnet <dotnet.exe> -ReferenceAssembly <built-example.dll>` passed against the pinned C# Release example. It checks generated ID associations before normalizing them, preserves passage/search order, and separately checks navigation order against each run's generated IDs.
- The source SDK, reference test counts, and raw smoke/ramp paths are recorded in `bootstrap-target-profile.md`. Those reference runs do not certify the TypeScript tools; the current target replay/ramp and diagnostic evidence is recorded below.

### Supported-contract qualification matrix

The current supported profile is Node 22.23.5, ESM, Windows x64, against the read-only
reference pin `479d2612315cbd292da917bae6d8d3fec35fea24`. This closes the identified
supported-contract gaps, not CLR binary/runtime emulation or production qualification.

| Pinned trace | Matched observations and observable contract |
|---|---|
| `--supported-contracts` / `verify-supported-contracts.ts` | 90: construction/copy, callback/clock identity, reusable builders, exact owner-local projected objects, admission/release, overflow, paging/search errors, independent equal-ID scopes and follow-on resource recovery |
| `--configuration` / `verify-configuration.ts` | 79: nested deferred/partition/execution/memo limits, invalid selectors, null arguments, strategy replacement resetting unspecified fields, and collector/memo mode compatibility |
| `--views` / `verify-views.ts` | 46: all nine built-in recipes, default limits, model memory and pair selection, callback errors, disposed-handle precedence, reopening after publication, retained views after removal/disposal, zero residual charges |
| `--lifecycle` / `verify-lifecycle.ts` | 13: shared synchronization with caller cancellation, failure before compaction, reopening/recovery, native and maintained collector shutdown with/without memo, pending waiter disposal and worker quiescence before memo teardown |
| `AdmissionOracle` plus mailbox tests | Waiting admission keeps captured revision 0 while another writer publishes revision 1; synchronous admission is not replaced by an async-only API |

`npm run test:packages` additionally checks 12 clean-installed provider/memo/deferred
combinations with two independent worker callers, 384 worker mutation terminals and
24 retained-key probe terminals (408 total), full
entry/search oracle checks, memo hit attribution, retained hot-key probes and zero
remaining capture/output/preparation/index work. These are owner-serialized composed
services, not CPU-parallel adapter execution.

The 39 generated-record inventory rows have individual dispositions: one supported
options-copy operation and 38 language-generated surface differences. Declaration
rows and typed record helpers link to their scenario evidence; a declaration link
is not itself behavioral certification. Worker projection authorization, arbitrary
custom-worker termination, and between-partition failure injection remain separately
labelled TypeScript extensions, not unresolved supported .NET contracts.

Fresh raw outputs are under
`C:\Users\felixlu\.copilot\session-state\6e18b0f3-c27c-40ca-bbaf-4dadffbc7720\files`.
These locally retained outputs/manifests are not committed repository artifacts
or npm package contents. Public consumers can rerun the committed exporters,
fixtures, tests, and verifiers rather than depend on access to that local path.
The `sealed-*` runs supersede the earlier `final-*`, `mailbox-reply-*`, and historical
pressure runs for current-source qualification. The complete source fingerprint is
`6bd042a33936ffa0fa7137b9a01ce1fdfb1fa05d403425d1bd8ddd63e904641f`.
The replay/finite-retention tools use their older core/benchmark hash domain,
`2df6684a736d7d55f7d7d60b1f6f835e14878bd88145db391047149572f1820a`;
both are recomputed from the same current checkout, not interpreted as equal hash
algorithms. The complete domain additionally includes adapters and package-build
configuration. The final evidence manifest records file hashes, built package and
reference assembly hashes, runtime/SDK, commands and staged/unstaged identities.

`sealed-worker-replay-{0,500}.jsonl` reconciles 2,304 terminals across 12 cases.
`sealed-worker-ramp-100-500.jsonl` reconciles 2,160 terminals across 12 isolated cases
using `100,500 300 <final-ramp-fixture.json> --repetitions=1`, two workers and queue 32.
Every native replay and ramp case reaches two in-flight preparations; publication
remains owner-serialized. Independent semantic histories and lease recovery remain
enabled. The finite 128- and 512-entry exports each match all 125 steps in seven
scenarios, with fresh 32-round retention/release checks. These are bounded correctness
observations on a shared host, not CPU-overlap, capacity or throughput qualification.

`sealed-{tokenization,cache,cache-heap}-{forward,reverse}.json` contains 280, 231 and
84 verified samples per direction respectively, all under the complete source
fingerprint above. All three caching policies run in rotating adjacent order with
fresh caches. The diagnostics retain raw per-call timings and retained-key hashes;
heap runs distinguish baseline/live/disposed V8 samples from logical estimates.
Other validation processes and other host users were not excluded; no timing,
allocation or GC superiority claim is made. `qualification-source-manifest.json`
and `qualification-run-manifest.json` retain the final source/build/artifact identities.

## Current outcome
All identified supported-contract gaps in this inventory are closed by implementation
and pinned or independent-oracle validation for the stated target profile. No
supported-contract item currently requires an owner decision. This is not literal
CLR API/runtime emulation: the generated surface dispositions and target-only worker
extensions remain explicit, and the scalar foreground-LFU diagnostic remains
unqualified because its pinned dependency fails. The library remains experimental,
without a stable release, production qualification, capacity/SLA or performance-win
claim. The qualified implementation/tests were committed as
`b2d3dfa567be7e0a17227e026f0e4dc8db6ad1e7`. The source/run manifests describe
the pre-commit staged identity; that historical record is not the current Git
status. Governance documentation is included in the subsequent documentation
publication; raw local evidence remains outside Git.
