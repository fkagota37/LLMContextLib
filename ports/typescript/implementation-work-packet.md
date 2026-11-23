# TypeScript port implementation work packet

## Scope
This packet intentionally does not implement the library behavior yet. It is the next bounded source-inventory and architecture packet for explicit implementation direction after the bootstrap gate.

The authorized source of truth remains the C# reference in `D:\source\LLMContextLib`. The destination remains the same repository at `D:\source\LLMContextLib-Ts`, branch `port/typescript`, root `D:\source\LLMContextLib-Ts\ports\typescript`.

## Required source inventory
Use the following source anchors as the implementation contract and validation baseline:

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

## First implementation slice (approved as the next bounded step)
Implement the TypeScript port’s foundational domain layer and factory skeleton in the following order:

1. Core immutable domain models and enums
   - Session, segment, entry, content variants, memory scope, anchors, mutation statuses, and index-key shape should map 1:1 to the C# public contracts.
   - Preserve immutable semantics for session roots and content payloads.
   - Use explicit TypeScript types, readonly properties, and structural equality semantics without silently dropping invalid cases.

2. Factory and initialization contract
   - Model the same public entry point as `LLMContextFactory.Create(...)` and the builder pattern.
   - Carry `LLMContextOptions`, validation, and the execution strategy hooks without changing default semantics.
   - Keep the initialization path explicit and fail-clean before a usable owner exists.

3. Owner boundary and abstract storage contract
   - Define the TypeScript equivalent of the owning client and abstract storage interface.
   - Keep the public boundary interface-driven and separate from the concrete storage implementation.
   - Do not add a second mutable store or a public writable session array.

4. Read-lease and view contract scaffolding
   - Define the read lease and view interfaces before storage implementation.
   - Preserve lifetime and escaped-handle rules as a contract, not just a convenience function.

5. Validation and parity tests
   - Add a focused TypeScript test file covering the exact contract cases already proven by the bootstrap probe and the C# model contracts.
   - Use the C# reference as the authoritative oracle for behavior, not TypeScript-only assumptions.

## Detailed file-by-file implementation checklist

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
- Large parity blocks remain intentionally unresolved until the corresponding domain/storage slice is implemented and validated.

## Approved implementation order

1. `domain/session.ts` and `domain/anchors.ts`
2. `domain/mutations.ts` and `domain/reads.ts`
3. `domain/index-keys.ts`
4. `options.ts` and `factory.ts`
5. `storage/interfaces.ts` and `storage/owner.ts`
6. `lease.ts`, `policies/*`, and `execution/*`
7. validation tests and parity-targeted fixtures

This order keeps the public contract stable before the storage implementation depends on runtime defaults. No deeper library behavior is authorized until each preceding file set is designed and approved against the C# source contracts.

## Critical invariants to carry into the TypeScript port
- One owning client per session owner, with no public mutable root or writable array.
- Atomic publication of a complete immutable session root.
- Stable canonical IDs and no identity reuse after deletion.
- Strict expected revision conflict behavior; no silent retry/rebase.
- Captured reads/views survive writes, removal, and owner disposal.
- Text-mode and ProducerOwned-mode differences remain explicit and must not be silently collapsed.
- Synchronous admission waits must remain explicit; the port must not convert to async-only contracts without a written owner-approved deviation.
- Numeric overflow and UTF-16 ordering are contract-critical; do not silently coerce values.

## Material risks / blockers to resolve before full parity work
- JavaScript Number cannot represent the full C# `long` range safely; the port must either use BigInt or a checked-range abstraction for exact parity-sensitive counters.
- Worker scheduling, lifecycle shutdown, and bounded waiting semantics need explicit runtime choices for Node.js and async scheduling.
- Optional providers (Lucene/BitFaster equivalent adapters) are not yet approved to be implemented; they remain parity risks until the TypeScript runtime profile confirms a compatible equivalent.
- Full execution-strategy and deferred-indexing parity are not bootstrap-level evidence; they require separate implementation slices and validation.

## Implementation gate before going deeper
The next slice is approved only if all of the following are true:
- The TypeScript bootstrap project remains green (`npm run build` and `npm test`).
- The domain model mapping matches the current public C# contracts in `ContextModels.cs` and `LLMContextFactory.cs`.
- The runtime-specific numeric/text risks are explicitly delegated to checked types and tests before deeper storage logic.
- The work stays within the additive `ports/typescript` area and does not interfere with the existing C# source repository.

## Next explicit direction
Proceed with the foundational TypeScript domain model and factory skeleton only after this packet is approved. No storage or mutation implementation is authorized until the above contract mapping and runtime risk checks are explicitly accepted.
