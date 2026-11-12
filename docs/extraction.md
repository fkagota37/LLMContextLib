# Standalone extraction

## Origin and scope

Extracted on November 12, 2026 from local repository `D:\source\esp`, commit
`683a6bab58aac6ec92bed0ada4b43115df4216af`
(`Reduce LLM correction index preparation allocations`).
The original repository and its history remain intact. This is a new local
repository with no remote publication; it is the continuation point for LLM work.
The extraction is a snapshot with explicit provenance, not a filtered rewrite of
the original Git history.

`extraction-source.json` records SHA-256 hashes of all 37 carried original
source/test/benchmark/configuration/design files. The SDK pin (`global.json`) and
editor settings were uncommitted in the source checkout; they are explicitly
identified as such. The original source commit alone does not include them.

Copied only the LLM production project, its tests, its independent benchmark
project, the relevant build configuration, and the original LLM design record.
No generic engines, overlay implementation, SQLite strategy, DI integration, or
unrelated tests/benchmarks were imported. No original `bin`/`obj` files were
imported into the live projects.

No tracked LICENSE/NOTICE/COPYING file was present in the origin. Existing file
content/notices were retained; the original extraction added no new licensing
terms. The standalone project subsequently adopted the MIT terms in the root
`LICENSE` and added source attribution headers. Those are post-extraction changes,
not notices inherited from the origin snapshot.

## API and project mapping

| Origin | Standalone |
|---|---|
| Namespace `ScalablePolymorphicArray.Llm` | `LLMContextLib` |
| Production project `ScalablePolymorphicArray.Llm` | `src\LLMContextLib` |
| Tests `ScalablePolymorphicArray.Llm.Tests` | `tests\LLMContextLib.Tests` |
| Benchmarks `ScalablePolymorphicArray.Llm.Benchmarks` | `benchmarks\LLMContextLib.Benchmarks` |
| `ScalablePolymorphicArray.sln` | `LLMContextLib.sln` |
| Generic factory + `.WithLLMContext(options)` | `LLMContextFactory.Create(options)` |
| `.Initialize(sessions)` | Unchanged, one owning LLM client |
| `ILLMContextPolymorphicArray : IPolymorphicArray<LLMSessionContext, Guid>` | `ILLMContextPolymorphicArray : IDisposable`, explicit `TryFind` |

Old construction:

```csharp
PolymorphicArrayFactory.For<LLMSessionContext, Guid>(s => s.SessionId)
    .WithLLMContext(options).Initialize(sessions);
```

New construction:

```csharp
LLMContextFactory.Create(options).Initialize(sessions);
```

An optional `sessionIdSelector` preserves canonical identity validation, including
rejection of mismatched selectors. Duplicate initial session rejection and
partial-owner failure cleanup remain unchanged. Generic overlay/custom-equality
settings are no longer expressible, so their integration-only checks disappear.

All domain models, mutation statuses, revisions, leases, view definitions,
resource policies, and experimental preparation behavior remain unchanged.
Internal friend assembly names and all factory call sites were adapted.
No storage/index algorithm was modified during extraction.

`RunEvidence.cs` now discovers `LLMContextLib.sln`, hashes only the standalone
library/benchmark sources and configuration, and includes `global.json`. Benchmark
participants, workloads, oracle behavior, and dependency versions were preserved.
The tests still reference the benchmark project for shared fixtures/oracle support.

## Durable context

The current contract is in `llm_polymorphic.md`; the original full record is
unchanged in `history\llm_polymorphic.md`. Historical paths/measurements there
remain literal rather than being silently relabeled as standalone measurements.
`AGENTS.md` records invariants, project map, commands, and measurement rules.
`evidence.md` and its inventory identify the original raw artifacts and their
verified independent local copy.

Important origin commits:

| Commit | Context |
|---|---|
| `33841fc2b96cf8291b562b0f4f3f20cd58ca92da` | LLM implementation, correction coalescing, pressure suite |
| `abb6d1b278b71e9eefe92ab64c409ed4e4998c54` | Bounded sustained mixed-load experiments |
| `87207720941c02ef0a98703d23f2b7733df56399` | Optional diagnostics and experimental serialized preparation |
| `683a6bab58aac6ec92bed0ada4b43115df4216af` | Local index accounting and entry-term diffing |

Speculative preparation remains the default. Serialization reduced discarded
preparation allocation but introduced admission/latency tradeoffs and stays
internal. Entry-term diffing reduced correction-preparation allocation; alternating
timing results were mixed. Neither is an unconditional speed/GC-overhead claim.

## Extraction validation

Validation uses the normal pinned SDK, without an SDK wrapper or any source/build
reference back to `esp`. Detailed results and the final checks are recorded in
`extraction-validation.json`; raw outputs are ignored under `TestResults\Extraction`.
These are correctness/regression checks, not a fresh performance campaign.

The system SDK/runtime installation changed during final checks: SDK 9.0.320
stopped resolving and the shared .NET 9 runtime changed from 9.0.22 to 9.0.23.
The pinned SDK was restored into ignored `TestResults\Tools\dotnet`, without
changing the shared installation or the SDK pin. That isolated SDK includes
.NET 9.0.22; the existing .NET 8.0.34 runtime was copied there for both-framework
validation. Final formatting, rebuild, tests, smoke, and load checks all used this
isolated toolchain. The README documents its optional local `PATH` setup.

The complete formatter check required whitespace fixes in the adapted factory
call in `SustainedRampTests.cs` and metadata layout in `RunEvidence.cs`. Only
those two touched files were formatted. The final complete check reported zero
changes and no workspace warnings. Final source-attributed reports are under
`TestResults\Extraction\Final`; earlier runs remain separately preserved.

The source repository's only pre-existing worktree changes are its uncommitted
`.vscode` settings and `global.json`. Extraction does not commit or remove them.

## Next investigation, not part of this extraction

Deletion allocation attribution is the next candidate, not an already justified
builder rewrite. Historical applied-operation preparation was approximately:

| Operation | Calls | Mean bytes/call | Total |
|---|---:|---:|---:|
| Correct | 15,113 | 10,599 | 160.18 MB |
| Append | 9,949 | 17,866 | 177.75 MB |
| Delete | 4,777 | 61,857 | 295.49 MB |

Deletion accounted for roughly 47% of useful preparation allocation in that
instrumented workload. Repeated `locations.SetItem` for shifted offsets in
`ReplaceSegment` is a hypothesis, not an attributed cause.

Measure beginning/middle/end deletions, separating locations, index maintenance,
and segment copying. Consider transaction-local immutable builders only if
profiling supports them. Preserve intermediate checked accounting, rollback,
atomic publication, lifetime isolation, and caller policies; measure changes
independently and alternate matched timing runs.

Other deferred candidates include append coalescing, range traversal, and limited
search candidate selection. Pooling published immutable graphs and GC tuning are
not the starting point. No such optimization was implemented during extraction.
