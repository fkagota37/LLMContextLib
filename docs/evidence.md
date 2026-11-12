# Evidence inventory

## Historical, not standalone performance

The inherited experiment record is `history\llm_polymorphic.md`. Historical raw
artifacts originally live under `D:\source\esp\TestResults\LlmContext`. A verified,
byte-identical independent copy is retained locally under
`TestResults\Historical` in this repository. It includes original source snapshots,
binaries, reports, and coordinating/analysis scripts where they existed.

The archive is ignored by Git, not needed to build/test the library, and is not
included in a fresh clone. Preserve or transfer it separately when moving this
checkout. Historical scripts/commands may contain original absolute paths and
require explicit adaptation before reuse. Do not run archived build trees as
though they were current source projects.

`historical-evidence.json` is the committed per-file SHA-256 and size inventory:
1,003 files, 979,314,027 bytes verified against their original locations.
Paths are relative to the original evidence root and its local archive root.
Both original and copy were hashed after copying. Windows extended-length paths
were needed for two deeply nested generated editorconfig files.

| Directory under the archive root | Purpose |
|---|---|
| `BDN-Dry`, `BDN-Dry-Final` | Early BenchmarkDotNet dry-run validation |
| `Warmed-Correction-20261111-002116-6421ad3d` | Warmed correction baseline |
| `Warmed-Correction-Coalesced-20261111-004528-8d43ae11` | Replacement-only coalescing comparison |
| `Pressure-20261111-011500-c6aab1a4` | Retained-generation and bounded-resource pressure |
| `SustainedRamp-20261111-015747-24640d1b` | Sustained bounded mixed load |
| `SustainedRamp-High-20261111-020622-2e878ee1` | Higher offered-rate experiment |
| `PreparationPolicy-20261111-024944-aa0146d0` | Speculative/serialized preparation attribution |
| `IndexOptimizations-20261111-031346-d08929c6` | Independent local-delta and entry-term-diff phases |
| `TermDiff-Alternating-20261111-034446-4330ce50` | Alternating large-text baseline/optimized timing |

## Interpretation to preserve

The segmented realization was retained for coherent captures, reader isolation,
and admission/lifetime behavior, not because it wins every throughput comparison.
The independent conventional references remain in the benchmark suite.

Serialized preparation eliminated 136,762,432 bytes of discarded session
preparation in its experiment, but had writer-latency/admission tradeoffs and
limited distributed-allocation benefit. It remains an internal experiment.

Local index accounting and entry-term diffing reduced mean successful correction
preparation from approximately 13,394 to 10,599 bytes (20.9%). That is a
correction-preparation allocation result, not a universal execution speedup.

The follow-up alternated baseline/optimized process order for 8K/32K text at
0/50/90% search shares: six adjacent pairs per profile, 72 cases, 1,440 measured
and 360 warmup replays. All correctness checks passed. Optimized won only three
or four pairs per profile; two profile means regressed. Pair ranges/order strata
are descriptive, not confidence intervals. Collection counts include setup and
oracle work; they do not establish lower GC CPU/pause overhead.

## New extraction checks

`TestResults\Extraction` contains tests, full-value oracle smoke reports, and the
bounded mixed-load reports for the newly named binaries. Current source manifests
must be nonempty and contain only standalone project/configuration paths.
`extraction-validation.json` records the actual validation settings and results.
These checks do not replace the historical matched optimization campaigns.
