# Working on LLMContextLib

## Project status and housekeeping

This library is experimental work in progress, not production-ready, and has no
stable, versioned release or compatibility promise. Keep that status visible in
the README and source headers. `TODO.md` is the live design backlog, not an
approved implementation plan or release commitment.

Maintained C# files use the copyright/author/SPDX/experimental header found in
`src\LLMContextLib\ContextModels.cs`. Apply it to new source, test, benchmark, and
example files; do not edit generated files or remove existing attribution.
The standalone project uses the MIT terms in the root `LICENSE`.

## Scope and repository map

This repository is the independent continuation of the LLM realization extracted
from `esp`, not a rewrite or a generic collection framework. Read
`docs\extraction.md` and `docs\llm_polymorphic.md` before changing architecture.
The detailed inherited contract, non-goals, complexity analysis, and experiment
history are in `docs\history\llm_polymorphic.md`; historical names and commands
there are not current build instructions.

- `src\LLMContextLib`: public contracts, native factory, internal bridge/storage.
- `tests\LLMContextLib.Tests`: mutation, retention, projection, preparation,
  concurrency, replay, and sustained-load correctness.
- `benchmarks\LLMContextLib.Benchmarks`: conventional Scan/Indexed references,
  independent semantic oracle, fixtures, finite replays, and pressure/ramp tools.
- `examples\BuildInvestigation`: runnable, commented human/agent context example;
  its offline adapters report no fabricated performance measurements.
- `ContextModels.cs`: public interfaces, immutable models, options, statistics.
- `LLMContextFactory.cs`: one owning client, validated initialization, failure cleanup.
- `LLMContextPolymorphicArray.cs`: owner lifetime fence and view bridge.
- `SegmentedContextStorage.cs`: session/memory publication, admission, retention.
- `ContextState.cs`: immutable entry locations, segments, postings, change preparation.
- `ContextReadLease.cs`, `ContextViews.cs`, `ContextPolicies.cs`: captured reads
  and caller-facing selection/projection behavior.
- `MutationDiagnostics.cs`: optional internal preparation attribution.

The tests deliberately reference the benchmark project for its oracle/fixtures.
Keep this existing dependency unless a separate refactoring is requested.
They also reference the runnable example for its focused integration tests.
Production has no project/package dependency on a generic engine or benchmark.

## Preserve these invariants

- One owning client; no writable top-level session array or public storage instance.
- Publish a complete immutable session root, including locations, ordered segments,
  anchors, and matching search indexes, atomically.
- Stable canonical IDs; tombstones prevent identity reuse.
- Strict expected revisions: conflict means conflict, with no silent retry/rebase.
- Session and memory roots are captured independently, not cross-catalog atomically.
- Existing reads/views survive writes, removal, and owner disposal.
- Readers do not acquire a session writer gate. Writers have per-session gates;
  resource admission and memory publication have separate owner-wide gates.
- Speculative preparation remains the default. Serialized preparation is an internal
  experimental switch, not a promoted public option.
- Estimator callbacks must be stable and non-reentrant. Account for conservative
  active/retained/view estimates without presenting them as hard heap caps.
- Public synchronous admission has no cancellation token.
- Preserve rollback, disposal, resource accounting, caller selection policies, and
  whole-tool-pair model-context behavior.
- Replacement-only batches coalesce; mixed/append transactions do not inherit that
  optimization automatically.
- Entry replacement diffs terms and retains unchanged postings. Anchor relocation
  still removes/adds complete memberships.
- Immutable dictionaries/hash sets use balanced trees of hash buckets, not HAMTs.

## Validation

Use the existing pinned SDK/dependency versions and both target frameworks.
From the repository root:

```powershell
dotnet build LLMContextLib.sln -c Release -m:1
dotnet test tests\LLMContextLib.Tests\LLMContextLib.Tests.csproj -c Release --no-build
dotnet format whitespace LLMContextLib.sln --verify-no-changes --no-restore
dotnet benchmarks\LLMContextLib.Benchmarks\bin\Release\net9.0\LLMContextLib.Benchmarks.dll --smoke --entries 128 --output TestResults\smoke.json
```

For the example implementation, run:

```powershell
dotnet run --project examples\BuildInvestigation\BuildInvestigation.csproj -c Release -f net9.0
dotnet test tests\LLMContextLib.Tests\LLMContextLib.Tests.csproj -c Release --filter FullyQualifiedName~BuildInvestigationExampleTests
```

For bounded mixed-load validation, use a NEW output directory:

```powershell
dotnet benchmarks\LLMContextLib.Benchmarks\bin\Release\net9.0\LLMContextLib.Benchmarks.dll --ramp --rates 100,500 --stageMs 300 --workers 2 --queue 32 --entries 512 --repetitions 1 --output TestResults\Ramp-check
```

That command runs twelve isolated cases: three participants, hot/distributed
sessions, normal/slow readers. It is not a capacity/SLA experiment.
Use focused tests for local edits, then run relevant oracle scenarios before
claiming semantic equivalence. Do not copy build outputs into source projects.

## Measurement and next work

Keep the semantic oracle, request terminal accounting, and lease recovery enabled.
Retain source hashes, runtime/SDK, architecture, process/GC configuration, raw
outputs, and commands. `RunEvidence.cs` finds `LLMContextLib.sln` and hashes current
library/benchmark sources and build configuration. Run the built executable inside
this checkout when collecting source-attributed evidence.

Separate storage/preparation allocation from output, lease, oracle, and harness
allocation. Compare optimizations independently against matched sources. Alternate
adjacent baseline/optimized runs when evaluating timing; disclose reused evidence.
Historical `esp` measurements do not measure newly named binaries in this repo.

Current narrow result: less correction-preparation allocation. Timing remains mixed;
do not claim broadly faster execution or lower GC overhead. Do not start with
pooling published immutable graphs or GC tuning.

The next candidate is deletion allocation attribution, NOT an approved location
builder rewrite. Measure beginning/middle/end deletion phases and distinguish
location maintenance, index work, and segment copying first. See
`docs\extraction.md` for the pending investigation and original evidence.
