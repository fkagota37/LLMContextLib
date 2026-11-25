# Development, differentials, and evidence

Use the resolved [profile](bootstrap-target-profile.md), existing lockfile, and
the [repository instructions](../../AGENTS.md). This experimental port's checks
are separate from the root's C# commands. Run these commands from
`ports\typescript` in PowerShell with Node 22 on PATH.

## Local checks and installed consumers

On a fresh checkout, `npm ci` installs the lockfile-resolved tools. Then:

```powershell
npm run build
npm run lint
node .\node_modules\vitest\vitest.mjs run --maxWorkers 2 --minWorkers 1
npm run build:packages
npm run test:packages
npm run example:build-investigation
```

`build` is no-emit type checking; `build:packages` compiles and packs the core
and two adapters. Package checks create and clean temporary installed consumers,
test public exports, real compiled worker modules, unchanged WriteOptimized,
and the adapter matrix. Vitest includes fixtures and independent semantic checks.
None of these successes alone proves all parity contracts.

The existing formatter command is `npm run format` (Prettier check). Keep edits
consistent with their file's formatting; do not blanket-reformat inherited files
or change dependencies/preset budgets to hide unrelated failures.
Use `git diff --check` for whitespace before staging.

## Prepare the pinned reference

Differentials additionally need the .NET SDK selected by the existing policy
and a separate checkout at `479d2612315cbd292da917bae6d8d3fec35fea24`.
Set `$ReferenceRoot` to that checkout, verify `git -C $ReferenceRoot rev-parse HEAD`,
and keep its tracked sources unchanged. Do not silently compare with current
`main` or a modified reference. Build it once:

```powershell
dotnet build "$ReferenceRoot\LLMContextLib.sln" -c Release -m:1
dotnet build tests\reference\MutationOracle -c Release "-p:ReferenceRoot=$ReferenceRoot" -p:BuildProjectReferences=false
dotnet build tests\reference\AdmissionOracle -c Release "-p:ReferenceRoot=$ReferenceRoot" -p:BuildProjectReferences=false
dotnet build tests\reference\ReplayOracle -c Release "-p:ReferenceRoot=$ReferenceRoot" -p:BuildProjectReferences=false
dotnet build tests\reference\MemoOracle -c Release
```

Generate new evidence outside tracked source. For example:

```powershell
$EvidenceRoot = Join-Path $env:TEMP ("llmcontextlib-ts-evidence-" + [guid]::NewGuid())
New-Item -ItemType Directory $EvidenceRoot | Out-Null
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$MutationOracle = 'tests\reference\MutationOracle\bin\Release\net9.0\MutationOracle.dll'
dotnet $MutationOracle --supported-contracts > "$EvidenceRoot\supported-contracts.json"
if ($LASTEXITCODE -ne 0) { throw 'Reference exporter failed.' }
node --import tsx tests\reference\verify-supported-contracts.ts "$EvidenceRoot\supported-contracts.json"
if ($LASTEXITCODE -ne 0) { throw 'Target differential failed.' }
```

Check each exporter and verifier exit code. A successful downstream process
does not excuse an upstream crash or partial output.

Use the corresponding verifier for other `MutationOracle` modes. Verifiers
without a filename argument read standard input; pipe the saved UTF-8 fixture
through `Get-Content` with `$OutputEncoding` set as above.

| Export mode                                                                      | Target verifier                          |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| No argument                                                                      | `verify-mutation.ts`                     |
| `--partitioned`                                                                  | `verify-partitions.ts`                   |
| `--write-optimized`                                                              | `verify-partitions.ts --write-optimized` |
| `--write-optimized-mixed`                                                        | `verify-write-optimized-mixed.ts`        |
| `--options`                                                                      | `verify-options.ts`                      |
| `--int64`                                                                        | `verify-int64.ts`                        |
| `--timestamps`                                                                   | `verify-timestamps.ts`                   |
| `--content-records`, `--scalar-records`, `--entry-records`, `--compound-records` | Matching `verify-*-records.ts`           |
| `--configuration`, `--lifecycle`, `--views`                                      | Matching `verify-*.ts`                   |

Verifier files are under `tests\reference`. `AdmissionOracle` and
`tests\admission-mailbox.spec.ts` pair the admission result with captured-read,
publication, and follow-on cleanup state. Do not replace their synchronous
admission scenario with an async-only API.

## Refresh both source inventories

Use separate PowerShell processes so framework assemblies cannot contaminate
each other's reflection inventory:

```powershell
pwsh -NoProfile -File tests\inventory-source-api.ps1 -ReferenceRoot $ReferenceRoot -Framework net8.0 > "$EvidenceRoot\api-net8.json"
pwsh -NoProfile -File tests\inventory-source-api.ps1 -ReferenceRoot $ReferenceRoot -Framework net9.0 > "$EvidenceRoot\api-net9.json"
node --import tsx tests\reference\inventory-target-api.ts "$EvidenceRoot\api-net8.json"
node --import tsx tests\reference\inventory-target-api.ts "$EvidenceRoot\api-net9.json"
```

Classify rows by supported caller scenario and observable behavior, not reflection
presence alone. Retain generated-surface and target-extension dispositions.

## Replay, ramp, and diagnostics

`ReplayOracle` exports the independent source fixtures. Save each successful
export before running its target driver:

| Source export                  | Target command suffix after `node --import tsx`                                   |
| ------------------------------ | --------------------------------------------------------------------------------- |
| No argument, or `512` entries  | `tests\reference\verify-replay.ts` (stdin; optional `--measure --soak`)           |
| `--concurrent-fixture`         | `benchmarks\concurrent-replay.ts 32 0 <fixture.json>` and `32 500 <fixture.json>` |
| `--ramp-fixture`               | `benchmarks\mixed-load-ramp.ts 100,500 300 <fixture.json> --repetitions=1`        |
| `--pressure-fixture <entries>` | Pressure/deletion drivers listed in the implementation ledger                     |

The bounded ramp has 12 isolated cases, two workers, and queue 32; it is not a
capacity/SLA test. Keep the independent oracle, exactly-one request terminal
accounting, and lease recovery enabled.

`MemoOracle`/`verify-memo.ts` cover LRU; `MemoOracle --lfu`/`verify-lfu.ts` cover
the foreground LFU diagnostic. The pinned scalar LFU failure must remain a
failed/truncated run, not a qualified matrix. Tokenization/cache/heap diagnostics
and their flags are recorded in the [ledger](implementation-work-packet.md).

Retain commands, fixture hashes, complete source identity including dirty/staged
state, package/reference assembly hashes, runtime/SDK, architecture and process/GC
configuration, and raw output. Run source-attributed tools inside the checkout.
Distinguish storage/preparation cost from output, lease, oracle, and harness cost;
alternate matched baseline/optimized runs and disclose reused evidence.
Do not equate CLR allocations with V8 samples or estimates, or label
owner-serialized service as CPU-parallel execution. See [parity](parity.md).
