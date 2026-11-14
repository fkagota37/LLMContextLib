# Current owner-composition benchmark

This diagnostic measures the actual integrated owner, not the earlier isolated
tokenizer/cache experiments. It is intentionally outside the default solution so
the default benchmark/example dependency graphs remain free of optional providers.
The benchmark references both maintained adapters and the existing semantic oracle.
The composed-policy tables below measure the source before producer-owned indexing.
Those exact measured sources and both runtime DLL sets are SHA-256 verified and
preserved under `TestResults\ProducerOwnedIndexing\Baseline`. Do not attribute
their numbers to a later build. The new producer-owned experiment is documented
at the end of this file.

## Run and verify

Use the repository's pinned SDK and both runtimes. If needed, use the isolated
toolchain documented in the root README:

```powershell
Set-Location D:\source\LLMContextLib
$local = Join-Path $PWD 'TestResults\Tools\dotnet'
$env:DOTNET_ROOT = $local
$env:DOTNET_ROOT_X64 = $local
$env:PATH = "$local;$env:PATH"

.\benchmarks\LLMContextLib.StrategyBenchmarks\Run.ps1 `
    -OutputDirectory TestResults\ComposedPerformance\AnotherRun
```

The runner refuses to overwrite an existing output directory. It restores locked
dependencies, builds both target frameworks, and runs four **non-overlapping**
processes: .NET 8 forward, .NET 9 forward, .NET 9 reverse, .NET 8 reverse.
It preserves JSON, logs and `dotnet --info`. Individual runs can select
`--suite sequential`, `--suite load`, or `--suite memory`; complete analysis expects
four `--suite all` reports. `--calls` accepts 16-512, with 128 the measured default.

```powershell
python benchmarks\LLMContextLib.StrategyBenchmarks\Analyze.py `
    --output TestResults\ComposedPerformance\Final-v3 `
    --source-root TestResults\ProducerOwnedIndexing\Baseline\source `
    --binary-root TestResults\ProducerOwnedIndexing\Baseline\bin `
    --analysis-output TestResults\ComposedPerformance\Final-v3\preserved-verification
```

The analyzer checks every compiled source/project/lock/configuration fingerprint,
every output DLL, runtime pair identity, report dimensions, baseline order,
per-call samples and loaded request terminals. It writes `summary.json` and
`sequential.csv`, `paired.csv`, `loads.csv`, `load-latencies.csv`,
`load-query-coverage.csv`, `memory.csv`.
The summary fingerprints its raw reports and analyzer. Changing measured sources
or binaries deliberately invalidates verification against that checkout.
Use `--analysis-output <new-directory>` to regenerate derived files separately
when an existing CSV is open in another application. The final checked analysis
is also preserved under `Final-v3\verified-analysis`; raw reports are unchanged.

## Compared policies

| Name | Full collector | Memo | Entry indexing |
|---|---|---|---|
| Native | Native | None | Original synchronous factory |
| PinnedNative | Native | None | Instrumented synchronous control |
| LuceneRange | Lucene RangeBuffer | None | Synchronous |
| LuceneChar | Lucene CharTerm | None | Synchronous |
| MemoNative1M | Native | 1 MiB reservation | Synchronous |
| MemoRange1M | Lucene RangeBuffer | 1 MiB | Synchronous |
| Deferred | Native | None | Fixed deferred, including corrections |
| AppendRouter | Native | None | AppendOptimized |
| ComposedNative1M | Native | 1 MiB | AppendOptimized |
| ComposedRange1M | Lucene RangeBuffer | 1 MiB | AppendOptimized |
| ComposedNative4M | Native | 4 MiB | AppendOptimized |
| ComposedRange4M | Lucene RangeBuffer | 4 MiB | AppendOptimized |

Memo capacity is 64 and maximum key length 8192 UTF-16 characters. The default
1 MiB allowance is about 15.2 KiB per entry; 4 MiB permits about 62.5 KiB.
This explicitly tests whether byte admission prevents useful reuse.

Deferred policies use 16 foreground words, 1024 foreground characters, 32
queued/running slots and 16 MiB estimated work allowance. Composed routers consider
new entries at/above 1024 characters; corrections remain synchronous.
All measured owners use 128 MiB estimated resident and retained ceilings, at most
32 entries/1 MiB estimated payload per segment, and **zero admission wait**.
These are experiment parameters, not changes to library defaults.

Before each process, all twelve policies pass the seven existing independent
oracle traces. Only this semantic gate uses 256 pending slots and five seconds
admission wait: legitimate transient gate rejection must not be mistaken for a
semantic mismatch. The measured workload retains its stated zero-wait limits.

## Workloads and measurement boundaries

**Payloads.** Repeated input has 512 occurrences of two body words plus a changing
suffix (2826 characters, three distinct terms). Unique input has 512 distinct body
words plus the suffix (5130 characters, 513 terms). Both have identical lexical
shape across policies. Each mutation has its own immutable content wrapper, so
reusing an exact text does not turn the comparison into a reference-identity no-op.

**Sequential calls.** Eight initial fully indexed entries seed each fresh owner.
Hot traffic reuses eight complete payloads. Cold traffic uses fresh suffixes.
Mixed traffic uses a deterministic 80/20 hot/cold pattern. Appends grow history;
corrections rotate over eight entries. Each candidate gets its own **adjacent
native control**, with baseline/candidate order reversed in the second process.
Every policy gets separate 32-call warmup for each profile/reuse/operation case.
This is bounded warmup, not BenchmarkDotNet steady-state convergence certification.

Every Apply and exact Search has a raw Stopwatch sample and same-thread allocation
sample. Apply requests/payloads are prebuilt. Completion is timed from Apply start
through immediate `WaitForIndexingAsync`, without interposing query/statistics work.
Process-wide allocation through completion includes worker/runtime/wait allocation;
it is not isolated worker allocation. Search uses a fresh, complete captured root.
Suffix hits/order are checked by scanning its full content **outside** query timing.
No incomplete zero-hit query is treated as an equivalent faster answer.

**Writer/search load.** Two dedicated writers and two dedicated searchers each
have 128 predetermined arrivals, one per millisecond: 4000 nominal arrivals/sec
in four aligned streams, not a capacity search or a free-running throughput loop.
All five workers (including the sampler) signal readiness before the shared start.
A worker that falls behind retains its original deadlines; reports include delay
from scheduled arrival to call start and end-to-end delay through call return.
The fixed per-worker schedules are bounded implicit queues, not a general host
thread-pool/FIFO model. Writers use 25% append/75% correction and 80/20
hot/cold payloads. They share one session or have independent sessions. Each of six
policies runs both speculative and serialized preparation; the explicit pinned
native control accounts for coordinator overhead. There are no silent mutation
retries. Every accepted, conflicted or admission-rejected attempt remains in the raw
trace. Accepted revision histories and final content are replay-checked; every
search is verified against its captured content.

Loaded mutation latency times Apply. Loaded query latency includes OpenRead and
Search, not validation or lease disposal. Throughput is total successful public
requests divided by whole foreground elapsed time; it **does include** harness
validation, record keeping and lease disposal. Reports separately expose applied
writes/sec, searches/sec, rejections/conflicts, and throughput through final index
completion. A strategy that rejects more writes is not automatically a winner.
These are short fixed-rate/fixed-concurrency diagnostics, not service p99/SLA
evidence. Accepted histories can differ because outcomes differ. Query cardinality
is reconstructed from accepted writes at the captured revision; the coverage CSV
separates empty/nonempty results and complete/pending-exact searches, rather than
treating every fast empty answer as an equivalent useful hit.

**Memory.** A separate phase takes three independent owner samples/policy/profile
per process. Payloads are created after the full-GC baseline, with call-local input
references gone before sampling. Samples measure actual incremental managed bytes
for 64 live entries, old-plus-current generations after correction, deletion of all
entries while keeping the memo alive, then owner disposal. Identity tombstones and
empty segment metadata remain after deletion, so the native control is important.
Full-GC retention estimates are distinct from conservative admission charges.

During load, a sampler observes `GC.GetTotalMemory(false)`, process private bytes,
pending work and active estimates approximately every 10 ms. Its maximum is a
**sampled process peak**, not an exact allocation/live-heap maximum. The process
also retains prior benchmark results and JIT/runtime infrastructure. Reports expose
the managed delta from a pre-load full-GC baseline as well as absolute observations.
Process allocation and GC pause counts include sampler/harness overhead.

## Evidence scope

Final evidence is under ignored `TestResults\ComposedPerformance\Final-v3`.
The first attempt under `Final` stopped in the oracle gate because zero-wait
background publication legitimately caused admission rejection; it contains no
completed report and is excluded. The 16-call preflight is also excluded.
`Final-v2` contains the first complete, closed-loop experiment; it was superseded
because repeated-text loads lasted under 6 ms and usually had only one heap
observation. The paced final run repeats all phases under one new source identity.

At 128 calls, the four final reports contain 135,168 timed sequential mutations,
135,168 complete exact queries, 98,304 loaded requests, 288 retained-heap samples,
and 336 independent oracle-trace checks. Percentiles use nearest rank over raw
calls, with no timer-bracket subtraction. Results describe this Windows machine,
SDK/runtimes and bounded fixtures only; no automatic strategy promotion follows.

## Final measured results

Measured November 13, 2026 on Windows x64, 20 reported logical processors,
workstation/Interactive GC, SDK 9.0.320, .NET 8.0.34 and .NET 9.0.22.
Each sequential candidate below pools 256 raw calls from two separate processes.
An arrow means **that candidate's adjacent native control -> candidate**;
controls are not interchangeable. The native controls themselves vary materially
across cases/processes. These are bounded-fixture comparisons, not fine-grained
rankings of all candidates or statistically established service percentiles.
The timer bracket p95 was 0.1 microseconds in each forward report; no subtraction.

### .NET 9 foreground, completion and allocation

Latency is microseconds; allocation is median bytes/call. Completion starts at
Apply entry, not after its return. Process bytes include the completion wait.
Mixed means deterministic 80/20 reuse, not an observed production hit rate.

| Payload / operation / policy | Apply p50 | p95 | p99 | Complete p50 | Caller B | Process B |
|---|---:|---:|---:|---:|---:|---:|
| Repeated mixed append / MemoNative1M | 53.0 -> 21.8 | 86.0 -> 73.3 | 118.0 -> 98.7 | 53.8 -> 22.4 | 24920 -> 8092 | 25072 -> 8244 |
| Repeated mixed append / ComposedNative1M | 32.3 -> 16.2 | 49.1 -> 50.0 | 76.7 -> 69.9 | 32.9 -> 18.3 | 24912 -> 8220 | 25064 -> 8660 |
| Repeated mixed append / ComposedRange1M | 32.2 -> 17.3 | 41.2 -> 55.9 | 48.0 -> 80.6 | 32.9 -> 19.6 | 24912 -> 8220 | 25064 -> 8660 |
| Repeated cold append / LuceneRange | 112.0 -> 82.5 | 233.5 -> 196.7 | 338.1 -> 221.8 | 113.6 -> 87.0 | 25196 -> 8924 | 25348 -> 9076 |
| Repeated cold append / LuceneChar | 119.8 -> 121.8 | 186.6 -> 282.3 | 234.1 -> 372.5 | 122.0 -> 123.8 | 25196 -> 9004 | 25348 -> 9156 |
| Unique mixed append / ComposedNative1M | 651.4 -> 73.8 | 6119.5 -> 160.8 | 13225.6 -> 184.2 | 652.3 -> 1066.9 | 702428 -> 24964 | 702580 -> 707348 |
| Unique mixed correction / ComposedNative1M | 103.6 -> 105.4 | 206.0 -> 127.5 | 265.4 -> 209.5 | 103.9 -> 105.6 | 69996 -> 70168 | 70148 -> 70536 |
| Unique mixed correction / ComposedNative4M | 108.6 -> 24.3 | 227.4 -> 111.8 | 1192.3 -> 141.8 | 108.8 -> 24.4 | 69980 -> 4560 | 70132 -> 4928 |
| Unique mixed correction / ComposedRange1M | 160.0 -> 142.6 | 245.9 -> 300.4 | 354.1 -> 1068.4 | 160.2 -> 143.0 | 69968 -> 87120 | 70120 -> 87488 |
| Unique mixed correction / Deferred | 122.6 -> 439.1 | 192.2 -> 972.6 | 279.7 -> 2577.6 | 122.8 -> 1244.6 | 69968 -> 444040 | 70120 -> 975644 |
| Unique cold correction / ComposedNative4M | 110.2 -> 116.4 | 159.1 -> 136.7 | 285.7 -> 221.5 | 110.3 -> 116.5 | 69936 -> 70224 | 70088 -> 70592 |

This demonstrates a real memo benefit, but not a reason to enable every component.
The unique mixed append foreground median improves 8.8x while full completion
becomes 64% slower. Fixed deferral of corrections loses badly. RangeBuffer saves
repeated-word allocation, but its composed repeated-word tails and unique-word
allocation/tails can regress. CharTerm's allocation saving did not translate
into faster repeated cold appends in this fixture.

### .NET 8 cross-checks, not just the favorable runtime

Same units and candidate-specific native arrows:

| Payload / operation / policy | Apply p50 | p95 | p99 | Complete p50 |
|---|---:|---:|---:|---:|
| Repeated mixed append / MemoNative1M | 45.5 -> 17.8 | 86.3 -> 51.8 | 111.5 -> 58.2 | 46.3 -> 18.5 |
| Repeated cold append / LuceneRange | 111.7 -> 100.0 | 193.5 -> 199.4 | 247.0 -> 267.0 | 113.2 -> 103.0 |
| Unique mixed append / ComposedNative1M | 728.1 -> 53.8 | 7546.7 -> 123.2 | 17573.8 -> 194.8 | 730.0 -> 952.3 |
| Unique mixed correction / ComposedNative1M | 105.0 -> 114.0 | 134.7 -> 139.3 | 142.2 -> 222.4 | 105.1 -> 114.5 |
| Unique mixed correction / ComposedNative4M | 108.8 -> 27.0 | 135.7 -> 125.5 | 177.9 -> 142.3 | 109.0 -> 27.3 |
| Unique mixed correction / ComposedRange1M | 110.0 -> 148.5 | 133.1 -> 175.1 | 142.9 -> 238.4 | 110.2 -> 148.8 |
| Unique mixed correction / Deferred | 119.5 -> 502.3 | 157.4 -> 1265.9 | 221.8 -> 2122.8 | 120.2 -> 1203.1 |
| Unique cold correction / ComposedNative4M | 113.0 -> 119.7 | 133.9 -> 136.3 | 249.7 -> 163.6 | 113.1 -> 120.0 |

The default 1 MiB memo has a 15,556-byte per-entry allowance. The unique fixture's
estimated memo entry is 40,176 bytes: its 5130-character key fits the length
limit, but its value cannot be admitted. It retains zero entries even for hot
traffic. A 4 MiB reservation raises the allowance to 63,952 bytes and permits
reuse. More budget is still not automatically better for foreground latency:
on .NET 9 unique hot appends, ComposedNative1M changed Apply/completion p50 from
738.5/739.3 to 72.2/1067.4 us; ComposedNative4M changed its own control's
895.2/896.9 to 728.6/730.2 us. The 4 MiB hit supplies complete terms, so full
postings preparation returns to the foreground instead of being deferred.

### Paced simultaneous writers and exact searches

Each row pools **512 attempted writes and 512 exact searches**, not 512 accepted
writes. This is the unique profile, speculative preparation, four aligned
1-ms arrival streams. Latencies below are microseconds. Query service is
OpenRead+Search; scheduled p95 also includes lateness relative to its original
arrival. Applied/sec uses whole foreground time, including harness work.

| Runtime / topology / policy | Applied | Conflict | Reject | Applied/sec | Query p50/p95/p99 | Scheduled query p95 | Pending queries |
|---|---:|---:|---:|---:|---|---:|---:|
| .NET 9 hot / PinnedNative | 276 | 216 | 20 | 1084 | 7.7 / 18.4 / 39.8 | 2244.3 | 0 |
| .NET 9 hot / ComposedNative1M | 223 | 130 | 159 | 876 | 7.5 / 157.9 / 202.0 | 1757.2 | 87 |
| .NET 9 hot / ComposedNative4M | 263 | 162 | 87 | 1035 | 7.4 / 119.6 / 238.5 | 1485.2 | 28 |
| .NET 9 distributed / PinnedNative | 512 | 0 | 0 | 1863 | 8.9 / 20.2 / 36.3 | 11611.9 | 0 |
| .NET 9 distributed / ComposedNative1M | 361 | 0 | 151 | 1394 | 10.6 / 228.6 / 363.8 | 12888.6 | 148 |
| .NET 9 distributed / ComposedNative4M | 489 | 0 | 23 | 1916 | 9.6 / 155.6 / 246.3 | 6426.2 | 31 |
| .NET 8 hot / PinnedNative | 292 | 204 | 16 | 1129 | 13.5 / 30.4 / 72.8 | 3835.3 | 0 |
| .NET 8 hot / ComposedNative1M | 211 | 111 | 190 | 829 | 12.9 / 259.8 / 394.5 | 2271.3 | 108 |
| .NET 8 hot / ComposedNative4M | 263 | 133 | 116 | 1033 | 12.0 / 258.6 / 1022.8 | 3185.2 | 78 |
| .NET 8 distributed / PinnedNative | 512 | 0 | 0 | 1997 | 7.2 / 22.9 / 52.3 | 7500.8 | 0 |
| .NET 8 distributed / ComposedNative1M | 375 | 0 | 137 | 1425 | 13.0 / 319.5 / 7665.2 | 7339.8 | 171 |
| .NET 8 distributed / ComposedNative4M | 479 | 0 | 33 | 1884 | 10.1 / 240.6 / 327.6 | 4765.6 | 57 |

Under these limits the composed policies reject more writes. Their exact search
service tails worsen even though scheduled latency can improve in some cases.
The .NET 9 hot default-memo queries split into 425 complete and 87 pending-exact
searches: complete/nonempty p95 was 15.5 us (325 calls), pending/nonempty p95
207.3 us (71 calls). This is not merely a comparison against fast empty answers.
All outputs were checked against captured full content; the coverage CSV exposes
both result cardinality and pending coverage for every loaded group.

Serialization is not a free win either. With zero admission wait, .NET 9 hot
ComposedNative4M accepts 255/512 writes and rejects 257; PinnedNative accepts 254,
conflicts once and rejects 257. These are admission choices, not efficient
completion of all offered work. Do not rank policies by successful-request
throughput while hiding rejected or conflicting writes.

### Actual managed retention

Median incremental KiB after full GC; six independent samples per row, .NET 9.
Old+current keeps one old read across 64 corrections; deleted keeps the owner
alive after deleting all 64 entries. Disposed still keeps the disposed owner
object reachable. These are actual managed-heap deltas, not reserved estimates.

| Payload / policy | Active 64 | Old+current | Deleted | Disposed | Memo entries |
|---|---:|---:|---:|---:|---:|
| Repeated / Native | 415.72 | 805.22 | 7.05 | 2.27 | 0 |
| Repeated / MemoNative1M | 427.27 | 816.77 | 383.61 | 2.90 | 64 |
| Repeated / ComposedNative1M | 429.06 | 818.56 | 385.40 | 4.34 | 64 |
| Unique / Native | 5095.42 | 7321.45 | 6.98 | 2.19 | 0 |
| Unique / AppendRouter | 5097.59 | 7323.02 | 9.14 | 4.11 | 0 |
| Unique / Deferred | 5097.59 | 10089.12 | 9.14 | 4.12 | 0 |
| Unique / ComposedNative1M | 5102.09 | 7328.47 | 13.65 | 4.30 | 0 |
| Unique / ComposedNative4M | 5108.84 | 7334.49 | 2204.40 | 4.34 | 64 |

The 4 MiB reservation is not a 4 MiB immediate allocation. Live roots share
retained memo payloads; deleting entries reveals about 2.15 MiB retained by the
unique memo versus about 7 KiB for native metadata. Disposal releases that
ownership. Fixed deferred correction also increases the old+current footprint.

The paced load windows last about 127-158 ms and have only 4-5 observations in
the least-sampled member of each pair. The requested 10-ms sampling interval is
not a timing guarantee on this host. Sampled managed deltas/private maxima remain
coarse process observations, **not trustworthy exact peak-heap bounds**. Neither
these short windows nor the predetermined rate establishes sustained capacity.

### Adoption decision

Keep the single semantic owner and its composable seams, but **do not promote
the whole composition or an adaptive selector as a proven faster default**.
Native synchronous collection plus a bounded memo is a promising simple choice
for repeated reusable text. Larger memo allowances can help reusable distinct
text, with a retention cost; cold traffic pays overhead. RangeBuffer is an
allocation-saving candidate for repeated words, not a universal collector.
Append deferral is useful when foreground latency matters more than immediate
index completion, but its pending-search/admission costs must meet the host's
objectives. Fixed deferral of corrections is not supported by these results.

The next performance work should target memo eligibility/reuse and the cost of
postings preparation/publication, with explicit foreground, completion, search,
acceptance and memory objectives. A memo hit currently bypasses tokenization,
not full foreground postings work. A deterministic factory choice is available
now; automatic switching still needs sustained representative traffic, rate
sweeps, bounded observations, switching costs and hysteresis. No production
default or semantic contract was changed by this experiment.

## Producer-owned write experiment

These results predate scoped reads and partitioned working sets. Their exact
source/DLL identity is preserved under
`TestResults\PartitionedWorkingSets\Baseline\source` and `bin`.
The original measured analyzers are preserved under its `analysis` directory.
Use `Analyze-ProducerWrites.py --source-root <archive-source> --binary-root
<archive-bin>` with the original report directory and a fresh `--analysis-output`
to verify those historical results after building newer sources.

The new mode is measured independently against the current synchronous native
Text mode, not against an old assembly or a renamed standalone tokenizer.

```powershell
.\benchmarks\LLMContextLib.StrategyBenchmarks\Run.ps1 `
    -ProducerWrites -NoRestore -Calls 128 `
    -OutputDirectory TestResults\ProducerOwnedIndexing\AnotherRun
```

Omit `-NoRestore` when dependencies need the runner's locked restore.
The same four non-overlapping runtime/direction processes run, with reversed
adjacent NativeText/ProducerKeys ordering. Two profiles, three reuse patterns,
two operations and two policies produce 12,288 timed writes across four reports.
Every write succeeds at its exact expected revision; every subsequent search is
checked against a scan of captured full content outside the timers. Both policies
publish complete indexes. Neither uses memoization, deferral or an execution
coordinator. Existing lexical meaning is deliberately reproduced for comparison;
the producer-owned API itself accepts arbitrary opaque keys.

The independent fixture producer knows its fixed body keys and changing suffix,
so it need not scan its body text to rediscover those keys. It constructs a fresh
`ContextIndexKeys` every time, including hot reuse: no hidden producer memo.
The sorting/deduplication/estimate and command allocation are measured as
**preparation**. The unchanged input strings are prebuilt for both policies.
`Apply` includes owner-side validation, membership differences, postings/segment
updates, revision admission and publication. **Pipeline** is a contiguous
wall-clock bracket around preparation and Apply, including timing/counter
overhead; it is not merely the sum of two percentiles and includes no queue wait.
The caller's original data-generation/I/O time and output validation are excluded.

**Cost-center attribution:** producer preparation belongs to the producer, including
its CPU, allocation, key-generation policy and scheduling. Storage `Apply` is the
separate write-service cost center, including destination-dependent state/index
updates and atomic publication. Pipeline remains an end-to-end accounting metric,
**not storage write latency**. Running both stages contiguously in this diagnostic
does not move preparation back into the owner or require producers to schedule
the stages that way in production. Read the latency and allocation tables with
that ownership distinction; published keys remain charged to owner resources.

Final raw reports, runtime details, `producer-summary.json` and
`producer-writes.csv` are under ignored `TestResults\ProducerOwnedIndexing\Measured`.
The final reverified derived files are under its `verified-analysis` subdirectory;
use `--analysis-output <new-directory>` when an existing CSV is open elsewhere.
`Analyze-ProducerWrites.py` verifies current measured sources, runtime DLLs,
forward/reverse pair order, matrix and timing accounting before aggregating.
Use it with `--output` to regenerate the summaries. Percentiles use nearest rank
over 256 raw calls per policy/group, not a capacity/SLA estimate.

Measured on the same Windows x64, SDK 9.0.320, .NET 8.0.34/9.0.22,
20 reported logical processors, workstation/Interactive GC setup.
Arrows below mean matched **NativeText -> ProducerKeys**, latency microseconds.

| Runtime / payload / operation | Producer preparation p50 | Storage Apply p50 | Storage Apply p95 | Storage Apply p99 | End-to-end pipeline p50 | Pipeline p95 | Pipeline p99 |
|---|---:|---:|---:|---:|---:|---:|---:|
| .NET 9 repeated mixed correction | 0.1 -> 1.2 | 37.7 -> 8.2 | 59.1 -> 27.3 | 75.8 -> 37.6 | 37.9 -> 9.4 | 59.3 -> 33.6 | 75.9 -> 45.6 |
| .NET 9 unique mixed correction | 0.1 -> 69.7 | 105.1 -> 13.6 | 134.8 -> 18.8 | 199.0 -> 26.3 | 105.3 -> 83.0 | 135.3 -> 112.4 | 199.2 -> 119.6 |
| .NET 9 unique mixed append | 0.5 -> 80.0 | 679.2 -> 556.2 | 6401.6 -> 4846.5 | 13780.1 -> 11582.2 | 679.8 -> 642.2 | 6402.4 -> 4928.8 | 13780.8 -> 11694.1 |
| .NET 9 unique cold correction | 0.1 -> 114.9 | 116.2 -> 15.5 | 142.9 -> 22.1 | 248.2 -> 43.9 | 116.5 -> 141.5 | 143.3 -> 167.5 | 248.7 -> 190.0 |
| .NET 8 repeated mixed correction | 0.2 -> 1.7 | 42.0 -> 11.4 | 199.7 -> 23.3 | 415.7 -> 50.5 | 42.4 -> 13.4 | 200.5 -> 29.6 | 416.4 -> 73.6 |
| .NET 8 unique mixed correction | 0.1 -> 79.1 | 101.4 -> 11.4 | 127.4 -> 20.2 | 981.1 -> 29.5 | 101.6 -> 90.2 | 127.9 -> 142.3 | 981.9 -> 221.1 |
| .NET 8 unique mixed append | 0.5 -> 87.9 | 643.6 -> 518.2 | 5067.4 -> 4595.9 | 10559.5 -> 11672.0 | 644.1 -> 608.8 | 5067.9 -> 4702.1 | 10560.2 -> 11825.3 |

Selected .NET 9 median allocation, bytes/call:

| Payload / operation | Producer preparation B | Storage Apply B | End-to-end pipeline B |
|---|---:|---:|---:|
| Repeated mixed correction | 216 -> 768 | 20544 -> 3488 | 20760 -> 4256 |
| Unique mixed correction | 216 -> 29440 | 69976 -> 4320 | 70192 -> 33760 |
| Unique mixed append | 296 -> 29520 | 702364 -> 636708 | 702660 -> 666228 |

This validates a much thinner Apply path for corrections and a useful separation
of responsibilities. It does **not** make Apply an O(1) pointer swap or establish
a universal end-to-end win. Unique append posting updates still dominate, cold
producer preparation can worsen the combined median, and .NET 8 unique mixed
append p99 regresses. The fixture-aware producer is not a forecast of every
application's preparation cost. There is no 1,000-writer capacity claim.

## Partition-local working-set experiment

`--partition-writes` compares **ProducerEager -> Partitioned**, both using the
same complete producer-prepared opaque contributions. It does not compare text
tokenization with prepared keys. Packet construction/data generation are outside
the storage timing: their cost remains the producer's responsibility.

Each fresh owner starts with 32 entries in four 8-entry partitions. Each entry has
256 keys: either 255 common keys plus `shared`, or 255 per-entry distinct keys
plus `shared`. Each round deletes alternating entries (leaving every base
partition partly live), completes synchronization, appends 16 entries, then
completes synchronization again. Every accepted revision and timed query is
checked against an independent membership/order model. Reads use `WithCurrent`.
The pinned variant additionally holds revision zero throughout and verifies it
before release; every final read/preparation reservation must be recovered.

The reported `Apply` brackets include validation, construction reservations,
working-set/posting maintenance and publication. Synchronous per-thread allocation
excludes synchronization workers. Separate synchronization brackets include the
completion wait; their allocation is a **process-wide** managed-allocation delta,
not per-thread allocation or live heap. `QueryScope` includes lazy lease capture,
exact search and automatic disposal. Round lifecycle time sums all 32 Apply
brackets and both synchronization brackets, excluding queries, setup, oracle and
producer preparation; it is not an end-to-end service percentile.

Adjacent fresh-owner pairs reverse policy order in the second process per
runtime. One untimed round per policy/profile/pinned variant warms the paths;
profile order stays fixed. Use within-profile matched comparisons, not cross-profile
timing differences. Sixteen pairs per process yield 512 samples per operation/
policy/group across forward/reverse processes, not independent machine trials.

Build the project, then run four processes from the repository root, using a fresh
output directory:

```powershell
dotnet build benchmarks\LLMContextLib.StrategyBenchmarks\LLMContextLib.StrategyBenchmarks.csproj -c Release
$output = 'TestResults\PartitionedWorkingSets\AnotherRun'
foreach ($run in @(@('net8.0','forward'), @('net9.0','forward'),
                   @('net9.0','reverse'), @('net8.0','reverse'))) {
    $framework, $direction = $run
    $arguments = @("benchmarks\LLMContextLib.StrategyBenchmarks\bin\Release\$framework\LLMContextLib.StrategyBenchmarks.dll",
        '--partition-writes', '--calls', '16', '--output', "$output\$framework-$direction.json")
    if ($direction -eq 'reverse') { $arguments += '--reverse' }
    & dotnet @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Diagnostic failed' }
}
python -B benchmarks\LLMContextLib.StrategyBenchmarks\Analyze-PartitionWrites.py `
    --output $output --analysis-output "$output\analysis"
```

Final raw reports/runtime details are under ignored
`TestResults\PartitionedWorkingSets\Final`; verified derived data is under
`Final\analysis`. All four reports have matching measured source hashes,
matching runtime-specific binaries, **16,384 timed writes and exact queries**,
and 512 verified measured lifecycle rounds. `Measured` is superseded by the final
busy-gate status correction; its exact sources/DLLs remain in `FirstMeasuredSources`.
These are bounded sequential diagnostics, not loaded capacity or hard-heap proof.

Measured on Windows x64, SDK 9.0.320, .NET 8.0.34/9.0.22, 20 reported logical
processors, workstation/Interactive GC. Below, arrows mean **ProducerEager ->
Partitioned**, without an explicitly pinned old read. Latencies are microseconds
except the final per-round column, which is milliseconds.

| Runtime / profile | Delete Apply p50 | Delete Apply p95 | Delete Apply median B | QueryScope p95 after deletion | 32 writes + both synchronizations, median ms |
|---|---:|---:|---:|---:|---:|
| .NET 8 common keys | 531.2 -> 19.1 | 1252.6 -> 76.6 | 234604 -> 5220 | 128.6 -> 98.3 | 18.51 -> 13.43 |
| .NET 8 distinct keys | 364.0 -> 5.5 | 644.7 -> 20.4 | 225800 -> 5220 | 43.2 -> 46.5 | 14.78 -> 5.98 |
| .NET 9 common keys | 426.2 -> 23.4 | 1699.0 -> 107.3 | 234668 -> 5220 | 137.9 -> 118.2 | 17.61 -> 10.98 |
| .NET 9 distinct keys | 498.0 -> 7.2 | 1425.1 -> 31.8 | 225884 -> 5220 | 57.5 -> 49.2 | 18.52 -> 8.35 |

This reduces foreground deletion work substantially in these fixtures, including
allocation, and the measured whole write/maintenance round also improves.
However, .NET 9 unpinned common-key synchronization costs 4.65 ms after deletion
and 5.66 ms after growth; distinct-key synchronization costs 3.14/3.61 ms.
This work has moved, not disappeared. .NET 8 distinct-key query p95 regresses.

The measured configuration uses a 4 MiB partition cap and therefore **8 MiB of
reserved recovery headroom**, already included in active estimates. Initial
estimated active bytes are 1,116,424 -> 12,296,452 (common) and 2,144,904 ->
12,489,232 (distinct). These are conservative accounting charges, not live-heap
measurements; the additional base-contribution directories and entry-local
estimates are not free. After partial deletion, partitioned active charges only
fall fully when synchronization releases base debt. Pinned old reads preserve
their original full-root charge across synchronization until explicitly released.

Adoption remains opt-in: the deletion allocation and complete write/maintenance
round improve in these fixtures, while search and memory depend on the workload.
The preceding sequential experiment did not measure sustained arrivals, fairness,
GC/heap behavior, large partition counts, or actual 1,000-thread traffic. The
following stress experiment addresses those separate questions. The earlier
1,000 independently prepared packet tests remain correctness tests, not capacity
measurements.

## Partition stress experiment

`--partition-stress` compares the same **producer-owned** preparation policies:
`ProducerEager -> Partitioned`. Complete packets for both contribution variants
are prepared before timing. A writer uses `WithCurrent` to resolve its destination
and expected revision, disposes that read, then attempts `Apply` once. Conflicts,
admission failures, synchronization blocks and dropped arrivals are recorded,
not silently retried. Accepted same-state revisions are counted separately from
actual contribution transitions.

Each process runs 26 cases, with adjacent fresh-owner policy pairs. Four sequential
processes reverse policy and runtime order; pilots are excluded.

| Suite | Workload |
|---|---|
| Paced load | Eight consumers, bounded producer queue of 128, 1/8 sessions, 2,000/10,000 scheduled requests/s, eight-second windows; 32 entries/session, 256 keys/entry. |
| Heap lifecycle | 256 entries, 16 entries/partition, 512 common/distinct keys/entry; delete 240 entries while retaining part of every partition, synchronize, append 240 entries, synchronize; with/without an old read pinned. |
| Scaling | 4/64/1,024 partitions of eight entries, eight keys/entry; up to 256 corrections, synchronization, then 128 common-key and point-key searches each, after warmup. |
| Dedicated threads | 1,000 actual `Thread` instances, all alive before release; one hot session or 1,000 independent sessions, four entries/session, eight keys/entry, two-second windows and requested 10 ms writer sleeps. |

Load/thread cases concurrently run exact captured-content search checks and, for
partitioned owners, round-robin synchronization. Requested maintenance spacing is
100 ms for up to eight sessions and 10 ms for the 1,000-session case, plus the
maintenance duration. The latter does not synchronize every session every 10 ms.
Live query service brackets exclude the independent content scan, but that scan
still consumes workload CPU and temporarily retains its captured root.

`Apply` latency excludes producer lookup; due-to-terminal latency includes lookup,
queue/scheduling delay and the terminal attempt, including rejected attempts.
Dropped arrivals have no latency sample.
Throughput including drain excludes final quiescent synchronization and final
oracles, whose durations are reported separately. Per-second accepted completions
expose in-window progress; per-worker counts and Jain's index describe observed
fairness, not a scheduler fairness guarantee. A hot session still has one strict
revision stream. A thousand live threads are not a thousand executing cores.

Telemetry records process-wide managed allocation, GC collection/pause deltas,
CPU, sampled managed memory, working set and private bytes. A private Windows
high-resolution waitable timer avoids changing global timer resolution. Actual
sample counts and maximum gaps are recorded; process memory is refreshed every
20 samples. Sampled peaks can miss brief peaks and are not hard memory bounds.
GC pause/CPU durations use `TimeSpan` ticks, unlike `Stopwatch` workload timings.
A 768 MiB sampled private-byte stop guard bounds each process. Owner admission
uses a separate 512 MiB estimated budget and a 16 MiB recovery reserve; neither
accounting charge is a measured live-heap value.

Heap lifecycle full collections occur outside the timed telemetry phase.
Producer source graphs remain alive across the before/after old-read release
collections, making retained-root release observable without attributing producer
packets to an index leak. Startup, fixture construction and final collected heap
are not included in paced throughput. Thread telemetry includes thread startup;
creation duration is recorded separately.

Every accepted write must match the final session revision totals. Independent
membership/order checks must pass, every offered request must have an attempt or
drop outcome, and owner read/preparation/pending-maintenance counts must recover
to zero. Histogram percentiles are upper bucket bounds with approximately 2.2%
resolution, not individual sorted stopwatch samples.

Reproduce after building the strategy benchmark project in Release, using a fresh
output directory:

```powershell
$output = 'TestResults\PartitionedStress\AnotherRun'
foreach ($run in @(@('net8.0','forward'), @('net9.0','forward'),
                   @('net9.0','reverse'), @('net8.0','reverse'))) {
    $framework, $direction = $run
    $arguments = @("benchmarks\LLMContextLib.StrategyBenchmarks\bin\Release\$framework\LLMContextLib.StrategyBenchmarks.dll",
        '--partition-stress', '--stress-suite', 'all', '--seconds', '8',
        '--writer-threads', '1000', '--output', "$output\$framework-$direction.json")
    if ($direction -eq 'reverse') { $arguments += '--reverse' }
    & dotnet @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Stress diagnostic failed' }
}
python -B benchmarks\LLMContextLib.StrategyBenchmarks\Analyze-PartitionStress.py `
    --output $output --analysis-output "$output\analysis"
```

### Verified stress results

Raw reports, process logs and runtime/host details are in ignored
`TestResults\PartitionedStress\Final`; final verified CSV/JSON summaries are in
`Final\verified-analysis`. The four reports verify **104 cases, 2,727,475 offered
requests, 2,408,600 attempts, 1,503,029 accepted revisions, 39,148 recorded oracle
checks and 16,000 dedicated writer threads created**. All cases passed exact
results/revision accounting and recovered their owner read, preparation and
maintenance reservations. Each dedicated-thread case verified 1,000 live writers
before release. Sources matched across all processes; runtime-specific DLLs
matched across policy orders.
Exact measured sources and runtime binaries are preserved in
`Final\MeasuredIdentity\source` and `Final\MeasuredIdentity\bin`. The analyzer
accepts `--source-root` and `--binary-root` pointing there for verification after
the working checkout changes. The preceding sequential experiment's identity is
separately preserved in `TestResults\PartitionedStress\Baseline`.

The host/runtime configuration is the Windows x64, 20-logical-processor,
workstation/Interactive GC setup described above. These are paired bounded local
measurements, not independent machine replications or an unlimited-duration SLA.
Arrows below mean **ProducerEager -> Partitioned**. Rates combine both policy
orders and include their measured drain time. Drops are totals across both
eight-second windows: 32,000 offered at 2,000/s, or 160,000 at 10,000/s.

| Runtime / sessions / offered rate | Accepted revisions/s | Actual contribution changes/s | Dropped arrivals | Due-to-terminal p95, ms |
|---|---:|---:|---:|---:|
| .NET 8 / 1 / 2,000 | 1,011 -> 1,289 | 237 -> 890 | 13 -> 4 | 5.28 -> 1.60 |
| .NET 8 / 1 / 10,000 | 3,928 -> 5,280 | 19 -> 3,343 | 28,595 -> 56 | 24.04 -> 1.60 |
| .NET 8 / 8 / 2,000 | 1,107 -> 1,974 | 523 -> 1,924 | 6,353 -> 2 | 116.85 -> 1.71 |
| .NET 8 / 8 / 10,000 | 1,700 -> 9,555 | 589 -> 9,157 | 121,530 -> 260 | 98.26 -> 1.67 |
| .NET 9 / 1 / 2,000 | 983 -> 1,133 | 225 -> 686 | 4 -> 2 | 4.16 -> 1.71 |
| .NET 9 / 1 / 10,000 | 3,621 -> 4,038 | 22 -> 2,116 | 38,201 -> 7 | 29.21 -> 1.71 |
| .NET 9 / 8 / 2,000 | 1,291 -> 1,965 | 704 -> 1,915 | 2,623 -> 2 | 96.15 -> 1.71 |
| .NET 9 / 8 / 10,000 | 1,718 -> 9,522 | 587 -> 9,165 | 121,058 -> 165 | 96.15 -> 1.67 |

The high-rate hot-session eager results accept mostly same-state revisions:
they are **not** thousands of useful contribution changes per second. Fixed
arrival sequencing, strict expected revisions, conflicts and drops determine
which variants reach publication. The transition column avoids crediting those
cheap unchanged contributions as equivalent work. Partitioning materially
improves useful changes in every measured load pair, but does not remove the
single-session revision bottleneck.

All eight consumers progressed in every load case. Median accepted-count Jain
indices across the paired runs were 0.9903-0.9996 eager and 0.9012-0.9912
partitioned: higher throughput did not make per-consumer scheduling more equal.
Partitioned eight-session/10,000-rate cases completed 9,383-9,890 accepted
revisions in every measured second on .NET 8 and 9,310-9,896 on .NET 9; the raw
per-second arrays preserve both orders rather than hiding them in an average.
Their maximum drains were 59.3/108.2 ms and additional final quiescent
synchronization medians were 79.9/52.1 ms (.NET 8/.NET 9).

Live query service p95 increased under load: for those same eight-session/high-rate
cases, **121.8 -> 204.8 us** (.NET 8) and **119.2 -> 183.8 us** (.NET 9).
Across all load groups, partitioned query p95 was 164.9-283.4 us. Admission and
maintenance are exercised, not bypassed: paired .NET 9 eight-session/high-rate
partitioned attempts produced 154,237 applied, 4,500 revision conflicts, 1,096
`Synchronizing` and two `SynchronizationRequired` outcomes, plus 165 dropped
arrivals. No invalid-operation/missing-session outcome or synchronization failure
occurred. Producer staging/retry is not included in this experiment.

### Shrink/growth memory and GC

These are complete 480-mutation lifecycle telemetry results, including both
synchronizations. Allocation and total GC-pause columns are medians across the
two orders; managed peaks are the larger sampled observation. The table shows
the unpinned cases; pinned results are in the same CSV.

| Runtime / keys | Managed allocation, MiB | Sampled managed peak, MiB | Total GC pause, ms |
|---|---:|---:|---:|
| .NET 8 / common | 302.26 -> 48.73 | 73.00 -> 54.64 | 198.86 -> 33.55 |
| .NET 8 / distinct | 278.81 -> 26.02 | 98.42 -> 77.23 | 287.55 -> 23.60 |
| .NET 9 / common | 302.27 -> 48.73 | 76.16 -> 55.24 | 269.62 -> 43.24 |
| .NET 9 / distinct | 278.14 -> 26.02 | 98.95 -> 77.31 | 233.16 -> 21.64 |

The smaller foreground allocation is accompanied by **lower measured lifecycle
allocation, managed peaks and GC pauses**, not merely deferred allocation hidden
outside the measurement. Working-set/private-byte peaks also fell in these
unpinned lifecycle pairs; for example, .NET 9 distinct keys measured
154.18 -> 130.20 MiB working set and 120.55 -> 96.31 MiB private bytes.
This fixture did not exhibit the feared extra process-memory spike from the
partitioned working set.

Pinned original roots remained query-correct. Releasing the old read recovered
approximately 9.00 MiB common/22.05 MiB distinct of collected managed memory for
partitioned owners, compared with 10.96/23.94 MiB eager. With producer source
graphs still held constant, partitioned collected totals after release returned
to approximately 35.44/55.30 MiB, close to the unpinned 35.39/55.27 MiB totals.
Retained-read accounting returned to zero; synchronization did not pretend it
could invalidate an explicitly pinned old root.

Across all 104 cases the largest sampled managed, working-set and private-byte
observations were 98.95, 163.34 and 139.76 MiB, respectively, below the private
stop guard. Recorded average sample spacing ranged 1.82-4.58 ms in load and
2.61-8.35 ms with dedicated threads; the largest individual gap was 100.50 ms.
Those are observed sampling limitations, not a 1 ms peak-memory guarantee.
Large payloads, different partition caps and much longer retained histories
still need their own resource sizing; the measured improvement does not turn an
estimated admission budget into a hard process-heap cap.

### Partition-count scaling

All membership/order checks passed through 1,024 partitions (8,192 entries).
Queries below are after synchronization, with result limit 16. Common queries
have many matching entries; point queries have one matching contribution.
Apply medians exclude the separately reported synchronization.

| Runtime / partitions | Correction Apply p50, us | Common query p95, us | Point query p95, us | Partitioned synchronization median, ms |
|---|---:|---:|---:|---:|
| .NET 8 / 4 | 19.74 -> 5.50 | 26.73 -> 35.43 | 7.61 -> 16.24 | 0.45 |
| .NET 8 / 64 | 21.53 -> 5.27 | 392.23 -> 874.20 | 7.61 -> 84.26 | 3.02 |
| .NET 8 / 1,024 | 30.44 -> 9.05 | 8,875.25 -> 6,993.61 | 20.17 -> 1,438.72 | 19.45 |
| .NET 9 / 4 | 13.96 -> 6.00 | 14.58 -> 11.99 | 5.27 -> 5.38 | 0.41 |
| .NET 9 / 64 | 15.22 -> 3.81 | 322.76 -> 172.22 | 6.98 -> 25.05 | 1.99 |
| .NET 9 / 1,024 | 20.17 -> 6.54 | 13,987.22 -> 6,141.27 | 23.48 -> 1,348.20 | 12.19 |

The specific scaling cost is **partition fan-out for selective lookups**:
point-query p95 at 1,024 partitions is about 71x on .NET 8 and 57x on .NET 9
relative to the eager global index. Common-key results are mixed, not a universal
query regression.
The reduced correction cost remains visible, but a latency-sensitive selective
search workload should not extrapolate four-partition timings to 1,024 partitions.

### Actual 1,000-thread traffic

Each row combines two two-second windows with 1,000 live dedicated writer
threads per window. These use small eight-key contributions, not the 256-key
paced-load fixture above. Rates include drain, exclude startup and final
quiescent checks, and are not directly comparable to the preceding load table.

| Runtime / sessions | Accepted revisions/s | Actual contribution changes/s | Peak overlapping Apply calls | Due-to-terminal p95, ms |
|---|---:|---:|---:|---:|
| .NET 8 / 1 | 12,309 -> 15,766 | 2,088 -> 6,152 | 769 -> 960 | 17.37 -> 13.11 |
| .NET 8 / 1,000 | 23,505 -> 38,009 | 21,573 -> 36,047 | 57 -> 469 | 26.79 -> 19.36 |
| .NET 9 / 1 | 11,578 -> 13,856 | 2,248 -> 5,523 | 978 -> 947 | 23.52 -> 18.94 |
| .NET 9 / 1,000 | 19,061 -> 35,560 | 17,117 -> 33,603 | 816 -> 299 | 54.75 -> 27.97 |

Every writer attempted and accepted at least one revision. Actual contribution
progress is stricter: in a hot-session run, up to 17/.NET 8 and 30/.NET 9 eager
writers made no contribution transition, versus zero/one partitioned writer.
Hot-session transition-count Jain medians improved from 0.7985 -> 0.9130
(.NET 8) and 0.7932 -> 0.9000 (.NET 9). With 1,000 sessions, every writer made
transitions and accepted-count Jain medians were at least 0.9975 for both policies.
These observations establish progress during the bounded windows, not starvation
freedom for arbitrary scheduling.

Median thread-creation times ranged 184-303 ms across groups. The latest first
attempt in any group was within 27.9 ms of the start, and all owned threads were
joined. Maximum drains were 46-81 ms. Partitioned final quiescent synchronization
across 1,000 sessions added median 120.6 ms/.NET 8 and 66.7 ms/.NET 9.
The largest sampled private peak in this suite was 139.76 MiB.

**Verdict:** partition-local working sets substantially improve the measured
write-heavy cases, including useful sustained changes, actual 1,000-thread
progress, and whole-lifecycle allocation/GC behavior. The concrete limits are
strict hot-session revisions, observable scheduling inequality and selective
search fan-out at large partition counts. Those findings support the opt-in
write-heavy path without treating it as a universal search-index replacement.
