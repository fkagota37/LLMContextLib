# Owner-scoped BitFaster term memoization

Experimental comparison of the existing tokenizer with and without a bounded,
owner-private exact-text memo. It is **not** a new tokenizer or production cache
integration. This project is deliberately outside `LLMContextLib.sln` and is not
referenced by production, tests, the example, or the existing benchmark projects.
`BitFaster.Caching` is pinned to **2.6.1**, with a generated dependency lock file.

## What is compared?

| Policy | Behavior |
|---|---|
| Uncached | Calls the real `ContextPolicies.Terms` for every request |
| Lru | `ConcurrentLru`, capacity 64, one instance per experimental owner |
| LfuForeground | `ConcurrentLfu`, capacity 64, concurrency level 4, explicit `ForegroundScheduler` |

LFU's foreground scheduler deliberately differs from its default thread-pool
scheduler: maintenance runs on the measured thread, so current-thread allocation
does not omit asynchronous work. These are **not default-LFU performance results**.
Both cached policies use `GetOrAdd`; concurrent misses may execute the factory
more than once. We do not enable atomic single-flight factory wrappers.

Only exact, ordinal-equal text reuses a value. The original classification/casing/
ordering policy runs on every miss. Case/punctuation changes can miss even when
their lexical results happen to be equal. Returned arrays are immutable and may
share across entries/calls, but values survive eviction and disposal if a caller
still retains them.

There is no static/global payload cache. Stop and join borrowers before disposing
an experimental owner. Disposal drains foreground LFU maintenance, clears entries,
and drops the private cache reference; this is not a concurrent-shutdown wrapper.

## Bounds and accounting limitations

The configured capacity is an **entry-count** policy, not a byte budget. Keys over
8,192 UTF-16 characters bypass caching but still tokenize normally. This limits
cacheable key size without claiming to bound transient tokenization/input work.
Reports distinguish end-of-batch counts from settled counts after LFU maintenance;
instantaneous peak occupancy under concurrent writes is not measured.

The footprint estimate charges each live membership 256 bytes plus its complete
key (`32 + 2 * key.Length`) and term array/strings
(`128 + 8 * termCount + sum(32 + 2 * term.Length)`). It is a quiescent membership
estimate, not exact node/buffer sizing or enforceable byte admission. It does not
discount strings already held by callers or session roots. Separate heap samples
include keys, values, nodes, and policy buffers rather than just returned outputs.

Eviction bounds only the memo's holdings: it cannot release arrays still held by
session generations or callers. A production integration would need explicit
resident/retained accounting for memo keys, nodes, buffers and escaped values,
including transient overshoot and publication/rollback/disposal. This prototype
is NOT charged to `LLMContextOptions` budgets and is not installed in the owner.

## Restore and run

From the repository root with its pinned SDK:

```powershell
$project = 'benchmarks\LLMContextLib.CachingBenchmarks\LLMContextLib.CachingBenchmarks.csproj'
dotnet restore $project --source https://api.nuget.org/v3/index.json --locked-mode
dotnet build $project -c Release --no-restore
foreach ($framework in @('net8.0', 'net9.0')) {
    $probe = "benchmarks\LLMContextLib.CachingBenchmarks\bin\Release\$framework\LLMContextLib.CachingBenchmarks.dll"
    dotnet $probe --verify-only
    dotnet $probe "TestResults\BitFasterTerms\$framework-forward.json"
    dotnet $probe "TestResults\BitFasterTerms\$framework-reverse.json" --reverse
}
& benchmarks\LLMContextLib.CachingBenchmarks\Analyze.ps1
```

If the v3 endpoint or mirror cannot supply the pinned version, the official v2
download route can populate the ignored local source without changing global
package settings or relaxing TLS validation:

```powershell
$packages = Join-Path $PWD 'TestResults\BitFasterTerms\packages'
New-Item -ItemType Directory -Force -Path $packages | Out-Null
curl.exe --location --fail --output "$packages\BitFaster.Caching.2.6.1.nupkg" `
    https://www.nuget.org/api/v2/package/BitFaster.Caching/2.6.1
if ($LASTEXITCODE -ne 0) { throw 'Package download failed.' }
dotnet restore $project --locked-mode `
    --configfile benchmarks\LLMContextLib.CachingBenchmarks\NuGet.Fallback.Config
```

## Measurement protocol

Three text profiles: short query, repeated words (3,583 characters, two distinct
terms), and mostly-unique words (5,119 characters, 512 distinct terms). Each has
equal-content hot requests, cold unique keys, and an 80/20 hot/cold trace with
16 hot keys. Additional traces walk 256 keys against capacity 64 and repeatedly
request oversized text that must bypass memoization.

Seven rounds of 512 calls run per scenario/policy/process, with rotating/reversed
policy order. Each round uses a new owner; only declared hot keys are seeded.
Hot requests use different string instances, not just repeated references.
Inputs and text formatting are prepared outside measurement. Factory counters
are paid equally by the uncached control and by actual cache computations.

Batch timing/allocation and individually bracketed latency use SEPARATE owners
seeded identically. Raw per-call stopwatch ticks support pooled p50/p95/p99 over
7,168 calls per case across two processes. These instrumented percentiles INCLUDE
timer overhead; a separate empty-bracket calibration is recorded, never silently
subtracted. They are method-call timings, not application/service latency SLAs.
Batch averages use only one timing bracket around 512 calls.

Separate heap samples create/churn keys inside a non-inlined helper so caller
collections do not retain them. Full collections approximate live incremental
owner memory before and after disposal. The static base fixture remains alive;
cache key strings are fresh complete copies. No results escape those heap samples.
There are no forced collections in timed loops or GC/runtime tuning.

Every process verifies 263 lexical inputs plus null handling, key-size bypass,
owner isolation, quiescent eviction bounds, retained-result survival, disposal,
and concurrent calls. Reports retain runtime/SDK/GC settings, selected dependencies,
actual assembly/source hashes, raw timing traces, computation counts and heap data.
`Analyze.ps1` verifies hashes/completeness and pools raw latency ticks; it does not
average round percentiles. Evidence is ignored under `TestResults\BitFasterTerms`.

These are bounded in-process diagnostics, not BenchmarkDotNet isolation or
end-to-end storage measurements. Cache hits avoid work; they do not prove a faster
tokenizer. Changing only content within a string still misses, and poor reuse can
add overhead and retained payloads with no tokenization benefit.

## Measured result

SDK 9.0.320, Windows x64, workstation GC, default tiering; .NET 8.0.34 and
.NET 9.0.22. Four reports retain 924 batch samples, 473,088 individually timed
calls, and 108 heap samples, with verified source/assembly hashes. Build and
whitespace validation passed; all four processes passed the correctness checks.

The following .NET 9 results use the 3,583-character repeated-word profile.
Times are **microseconds per call**, lower is better. Average is the median of
fourteen batch-average times. Percentiles pool 7,168 individually bracketed calls
from the SEPARATE latency pass; these are not percentiles of batch averages.
Allocation is median managed current-thread bytes per call in the batch pass.

| Traffic | Policy | Average us | p50 us | p95 us | p99 us | B/call |
|---|---|---:|---:|---:|---:|---:|
| Hot equal text | Uncached | 21.40 | 20.60 | 34.70 | 42.70 | 19,032 |
| Hot equal text | Lru | 1.26 | 1.20 | 1.40 | 1.60 | 0 |
| Hot equal text | LfuForeground | 3.85 | 1.30 | 1.70 | 2.10 | 0 |
| Cold unique text | Uncached | 25.39 | 24.50 | 36.90 | 51.80 | 19,096 |
| Cold unique text | Lru | 28.73 | 28.70 | 44.70 | 58.10 | 19,194 |
| Cold unique text | LfuForeground | 41.53 | 39.00 | 55.40 | 78.50 | 19,217 |
| 80% hot / 20% cold | Uncached | 26.96 | 25.00 | 42.50 | 49.70 | 19,090 |
| 80% hot / 20% cold | Lru | 7.39 | 1.70 | 29.80 | 36.10 | 3,869 |
| 80% hot / 20% cold | LfuForeground | 12.65 | 1.70 | 55.70 | 69.80 | 3,827 |
| 256-key churn | Uncached | 19.99 | 19.50 | 22.20 | 37.90 | 19,093 |
| 256-key churn | Lru | 20.98 | 22.00 | 25.20 | 39.20 | 17,255 |
| 256-key churn | LfuForeground | 30.24 | 30.80 | 36.20 | 61.10 | 17,677 |

Timer-bracket p95/p99 were 100 ns on both .NET 9 processes. The values above
include instrumentation overhead. Batch averages and latency percentiles come
from separate passes; they need not numerically align, and rare expensive work
above p99 can affect averages. No application/service tail-latency claim follows.
All scenarios/profiles/runtimes, including the short query and mostly-unique
payload, are available in `summary.json` and `timing.csv`.

The corresponding .NET 8 LRU comparison (same units and aggregation):

| Traffic | Average us: uncached / LRU | p95 us: uncached / LRU | B/call: uncached / LRU |
|---|---:|---:|---:|
| Hot equal text | 26.45 / 1.27 | 44.20 / 1.90 | 19,000 / 0 |
| Cold unique text | 21.86 / 24.99 | 36.60 / 42.20 | 19,064 / 19,162 |
| 80% hot / 20% cold | 25.30 / 6.64 | 26.80 / 27.90 | 19,058 / 3,862 |

Even LRU's mixed-case p95 was slightly worse than uncached on .NET 8 despite its
lower average. These process/order-sensitive diagnostics do not establish that
memoization improves every runtime's tail latency.

All hot requests avoided tokenization. In the mixed trace LRU performed 1,440
computations in 7,168 requests, foreground LFU 1,434; uncached performed 7,168.
Under 256-key churn, LRU still computed 6,440 requests and foreground LFU 6,594.
The reduced mixed-case average therefore comes from reuse, not a faster miss.
Foreground LFU's mixed p95/p99 were worse than uncached even though its average
improved. These traces do not establish an LFU advantage or test default LFU.

Full-cache traces settled at 64 entries after maintenance, and the maximum
OBSERVED end-of-batch count was 64. This is not measurement of instantaneous
concurrent-write overshoot.
Oversized requests always recomputed and added no memo entries.

### Retained owner memory

Median incremental live bytes after generating/churning 1,024 keys, with no
caller-held key/result arrays, on .NET 9:

| Text profile | Uncached owner | LRU owner | Foreground LFU owner | LRU estimated key bytes | LRU estimated memberships |
|---|---:|---:|---:|---:|---:|
| Short query | 696 B | 28,416 B | 36,008 B | 5,150 B | 40,252 B |
| Repeated text | 696 B | 485,728 B | 492,916 B | 462,110 B | 497,212 B |
| Mostly-unique terms | 696 B | 2,247,468 B | 2,256,492 B | 658,718 B | 2,587,708 B |

Each cached owner retained 64 entries. Whole text keys dominate repeated-text
retention; term arrays dominate much of the mostly-unique case. Estimated
memberships include their keys; do NOT add the two estimate columns together.
Policy buffers and fixed infrastructure explain why a membership estimate is not
an exact graph measurement. .NET 8 showed comparable retained footprints.
After disposal, the no-escape heap samples returned to about 184 incremental
bytes of fixed owner/measurement state for every policy; this is approximate
managed heap accounting, not an assertion of zero process memory.

### Interpretation and production boundary

This supports further evaluation of a small **owner-scoped LRU memo for genuinely
reused whole text**. Cold inputs, large working sets, key hashing, and retained keys
can erase the gain. Identical-text replacements might also be optimized by
comparing old/new payloads before tokenization, without adding a memo; that
alternative has not been measured here.

The production per-entry retained terms still avoid old-content retokenization
and preserve old generations. This memo experiment does not remove that state,
measure full mutation/search execution, or automatically solve its memory cost.
Possible array sharing across entries and real workload reuse need separate
end-to-end measurement.

In particular, calling GetOrAdd during speculative preparation could retain new
text even when a transaction later conflicts or is rejected. A production design
must decide publication/rollback semantics and reserve cache bytes explicitly;
it must not silently change failed-operation accounting or rely on item capacity
as a resident-byte cap. No production source, binary, or dependency was changed.
