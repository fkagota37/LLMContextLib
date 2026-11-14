# Configuration tuning

Start with `LLMContextOptions.WriteOptimized` through the factory, as shown in the
root README's complete create/append/search example. Its `sessions` variable is
an `LLMSessionContext[]`, accepted by `Initialize(IEnumerable<LLMSessionContext>)`;
there is no separate session-preparation factory. Add complete `IndexKeys` with
`new ContextIndexKeys(...)` on entry drafts, imported entries and anchors.

The preset is the recommended producer-owned, partitioned startup, matching
the final paced-load fixture's settings. Keep it unchanged until an observed metric
identifies a reason to tune. This library remains experimental; the measurements
are bounded local evidence, not a service-level guarantee.

For API contracts, ownership, imports and application examples, use
[Technical usage](usage-documentation.md). This guide answers when and what to
tune, rather than adding more startup requirements.

## Decision flow: diagnose one independent dimension

This is **branching triage, not a downgrade ladder**. Index layout, producer
intake, preparation scheduling, maintenance and resource limits are independent
dimensions. A conflict problem does not automatically justify eager indexing;
a selective-query problem does not justify changing the meaning of keys.

```text
Start: producer-owned keys + partitioned WriteOptimized
|
+-- Delivery, useful progress, query, latency and resource objectives met?
|    `-- Keep the profile. Record the envelope; do not tune for its own sake.
|
+-- Selective queries miss their objective?
|    `-- A: compare dirty/clean state; persistent clean fan-out -> compare eager.
|
+-- Maintenance closures or capacity refusals prevent delivery?
|    `-- B: classify outcomes; tune maintenance/intake; compare eager if necessary.
|
+-- Conflicts and discarded preparation dominate?
|    `-- C: tune producer coordination and preparation scheduling independently.
|
+-- Memory, allocation or GC misses its objective?
|    `-- D: distinguish retention, reservations, staging, allocation and process cost.
|
`-- Application requires owner-generated text keys?
     `-- Separate text-mode branch, not the next producer-owned performance fallback.
```

Follow [A: search](#branch-a-selective-search-pressure),
[B: maintenance/admission](#branch-b-maintenance-and-admission-pressure),
[C: contention](#branch-c-contention-and-preparation-scheduling), or
[D: resources](#branch-d-memory-retention-allocation-and-gc).
Only an explicit text-indexing requirement leads to the
[advanced text-mode candidates](#advanced-tuning-candidates).

### Preserve the contract

Keep opaque key meaning, exact search, strict expected revisions, atomic
publication and stable captured roots. Do not normalize, prune or regenerate
producer keys to make a benchmark faster. Do not invalidate required old
snapshots, disable accounting or silently retry/rebase. Synchronization changes
maintenance state, not content revisions.

There is one authoritative owner. Separate comparison owners use equivalent
fixtures, not independently writable forks of live history. Settings apply
before initialization; record copies do not reconfigure a running owner.
Deployment changes need a host-controlled cutover preserving authoritative data,
canonical identities, supplied contributions and borrower lifetimes. No automatic
profile switching or live backend migration is implied.

## Exact startup values

`LLMContextOptions.WriteOptimized` is an immutable options record. Every owner
initialized from it gets independent mutable state. It does not change
`new LLMContextOptions()` or the parameterless factory's original text-indexing
behavior.

| Setting | Startup value | Meaning |
|---|---:|---|
| `IndexingMode` | `ProducerOwned` | Producers supply complete entry/anchor keys; no implicit text tokenization. |
| `MaximumEntriesPerSegment` | **8** | At most eight live entries per physical segment/index partition. |
| `MaximumEstimatedBytesPerSegment` | **32 KiB** | Sum of entry estimates allowed in a segment. |
| `EstimatedResidentByteBudget` | **512 MiB** | Estimated active, preparation and retained charges must fit the owner budget. |
| `MaximumEstimatedRetainedBytes` | **256 MiB** | Separate ceiling for captured roots and view output. |
| `MaximumRetainedReads` | **2,048** | Maximum simultaneously admitted read/view leases. |
| `AdmissionTimeout` | **5 ms** | Ordinary gate/budget admission wait allowance, not a full-operation deadline. |
| `PartitionedIndex.MaximumEstimatedPartitionBytes` | **8 MiB** | Estimated base plus working-set cap per partition. |
| `PartitionedIndex.MaximumEstimatedWorkingSetBytes` | **4 MiB** | Estimated override/tombstone cap per partition. |
| `PartitionedIndex.MaximumWorkingSetEntries` | **64** | Maximum authoritative overrides/tombstones per partition. |
| `PartitionedIndex.MaximumPendingSynchronizations` | **32** | Queued plus running maintenance requests per owner. |
| `PartitionedIndex.MaximumEstimatedPreparationBytes` | **8 MiB** | Per-attempt preconstruction reservation ceiling. |
| `PartitionedIndex.WriteBehavior` | **`Reject`** | Return `Synchronizing` while maintenance closes session write admission. |

Other construction policies retain their existing defaults: speculative session
preparation, no deferred text indexing or custom execution strategies, the normal
entry/projection estimators, `TimeProvider.System`, and `MaximumViewResults = 4096`.
`SynchronizationWaitTimeout` remains one second but is inactive with `Reject`.

The partition cap accounts for **16 MiB of owner-wide recovery headroom**
(`2 x 8 MiB`), plus bounded synchronization infrastructure. This is not 16 MiB
per partition. The 512 MiB budget is a ceiling, not a startup heap allocation.
All these byte limits are estimates, not hard process-memory caps.

### Application operating policy

Use `WithCurrent` for ordinary synchronous lookups and release explicit snapshots
promptly. Every entry/anchor must carry complete `IndexKeys`; producer-owned
queries use `SearchKeys`, not text-mode `Search(string)`.

Start the application's maintenance worker with **one round-robin synchronization
request approximately every 100 ms**, measured after the preceding completion.
This matches the paced-load driver: it is not a library timer, nor does it mean
every session completes synchronization every 100 ms. Also handle
`SynchronizationRequired`, which already requests maintenance.

The application owns any staging queue and retry policy. Bound outstanding
intents by count and bytes. The measured paced driver used eight consumers and a
128-intent queue with recorded drops; it did not automatically retry. Those are
driver settings, not hidden preset options. Only drain staged work after a
successful completion, and preserve strict expected revisions. A conflict
requires an explicit application decision, not a silent rebase.

## Establish objectives and collect the right measurements

Write an application operating-envelope sheet before selecting a candidate.
Application objectives are the thresholds; measured partition counts and rates
in this repository are not universal switching rules.

| Objective | Observation and source |
|---|---|
| Delivery | Host offered logical requests, allowed drops/refusals, staging depth/bytes/age and eventual completion. |
| Useful progress | Applied revisions and actual caller-defined state/contribution transitions per producer/session. |
| Write responsiveness | Separate successful, conflicted and rejected Apply p95/p99; original-arrival-to-terminal/completion latency. |
| Read responsiveness | Query p95/p99 by point, absent-key, multi-key and common-key class, with cardinality and result limit. |
| Maintenance | Host-timed synchronization duration, closure/backlog, receipt success, generation and compacted count. |
| Memory | Estimated admission headroom plus actual managed heap, process memory and required retained histories. |
| Runtime cost | Matching-interval allocation per useful change, GC pauses and CPU, including the declared maintenance costs. |
| Fairness | Attempts, accepted revisions, transitions and zero-progress intervals by producer/session. |

Record workload shape too: entries/partitions per session, keys and estimated
bytes per contribution, hot-session skew, mutation mix, retained-read lifetimes,
query selectivity and available maintenance windows.

### Count useful work and retries correctly

Keep offered requests, source-expired/queue drops, attempts by outcome, applied
revisions, same-state applications, actual transitions, retries and eventual
logical completion separate. The stress fixture's two known variants are not a
universal definition of useful work. Use a caller-owned equality rule; any
prior-state observation must match the accepted mutation's expected revision.

```text
delivery yield       = completed useful logical requests / offered logical requests
attempt acceptance   = applied revisions / attempts
transition fraction  = actual transitions / applied revisions
conflict fraction    = revision conflicts / attempts
staging age          = attempt start - original logical arrival
allocation intensity = measured allocation / actual transitions
```

Handle zero denominators. Match allocation scope to the progress interval and
declare whether producer work, queries, validation and maintenance are included.
A retry is not new demand: retain the original arrival for eventual-completion
latency as well as recording individual attempt latency. Drops have no service
time sample. Record sample counts/denominators with percentiles.

### Available counters versus host instrumentation

`GetStatistics()` exposes `EstimatedActiveBytes`, `EstimatedRetainedBytes`,
`RetainedReads`, `EstimatedViewBytes`, `EstimatedPreparationBytes`,
`PendingSynchronizations` and `EstimatedSynchronizationReserveBytes`.
Preparation/synchronization charges are already in active estimates; view output
is already in retained estimates. **Do not add components twice.**

Read `read.Session.Segments.Count` in a short `WithCurrent` scope for physical
segment count. Empty segments can lack an active entry-index partition, so exclude
them or inspect the index directory diagnostically when attributing fan-out.
There is no public per-partition dirty byte/count counter. Measure producer
contribution sizes and distinct edits or use diagnostic instrumentation; do not
invent a public counter. Record outcomes, query/maintenance timing, staging and
useful-change classification at host boundaries.

Actual memory, allocation and GC require runtime/process telemetry. Optional
execution statistics describe applicable preparation/collector/memo selections,
not per-session latency or all discarded allocation. Statistics are observational:
use interval deltas with owner identity/reset tracking, and bounded metric labels.

## Branch A: selective search pressure

**Trigger:** a query class misses its latency objective. Compare matched content,
queries, cardinality, result limits and partition counts with unsynchronized
overrides and after synchronization. Time query service separately from lease
capture, result materialization, host queueing and independent validation, while
also retaining an end-to-end bracket.

If synchronization restores performance, investigate dirty-state work and
maintenance under branch B. If selective lookups remain expensive on clean
partitions, more frequent synchronization alone will not fix the lookup path.

### First layout alternative: producer-owned eager indexing

Hold key meaning, segment geometry, timeouts, resource budgets and producer
policy constant. Remove only partitioned indexing:

```csharp
var partitionedOptions = LLMContextOptions.WriteOptimized;
var eagerOptions = partitionedOptions with { PartitionedIndex = null };
```

Initialize separate comparison owners from equivalent fixtures. Producer-owned
mode and `SearchKeys` remain unchanged. Prefer eager only when its query benefit
fits the application's write, allocation/GC, admission and retention objectives.
It is not a change to text indexing or a live history migration.

At 1,024 partitions, measured point-query p95 was **20.17 -> 1,438.72 us**
eager-to-partitioned on .NET 8 and **23.48 -> 1,348.20 us** on .NET 9.
Common-key results were mixed. Read/write ratio or exactly 64/1,024 partitions is
not a sufficient switching rule.

Segment sizing is a separate experiment: **8 -> 16 entries/segment** may reduce
fan-out, but also changes copying, construction and maintenance costs. It is not
an already demonstrated fix. Selective routing/pruning is not an existing knob.

## Branch B: maintenance and admission pressure

Classify outcomes instead of combining all unsuccessful attempts as "rejections."

| Outcome | Meaning / investigation |
|---|---|
| `RevisionConflict` | Stale expected content revision; use branch C. |
| `Synchronizing` | Session write admission is closed for maintenance. |
| `SynchronizationRequired` | Dirty working-set capacity or a synchronization fence requires fresh admission. |
| `AdmissionRejected` | Gate or estimated-resource admission failed; inspect error, headroom and per-attempt limits. |
| `InvalidOperation` | Validation/contract error, not normal capacity pressure. |
| `NotFound` | Destination/lifecycle issue, not index tuning. |

The following numerical steps are **controlled experiments**, not more tested
presets. Select one only after identifying the limiting mechanism.

| Observed pattern | First experiment | Countercheck |
|---|---|---|
| Working sets fill before planned maintenance | Spacing **100 -> 50 ms**; separately test **64 -> 128 override slots** or **4 -> 6 MiB working set** if that is the constraint. | Closure frequency/CPU versus accumulated debt; base plus overrides must still fit 8 MiB. |
| Many short, unnecessary closures | Coalesce requests or test spacing **100 -> 200 ms**. | Working-set refusals and staging age must not grow. |
| Long bursts after substantial accumulation | More frequent, smaller maintenance opportunities. | Total closure time, CPU and eventual delivery. |
| Pending requests/closure delay grow continuously | Inspect service duration, host fairness and redundant requests. | Raising the **32-request** backlog cap does not add rebuild capacity. |
| Staging age grows while service time is stable | Bound intake/concurrency and offered load. | Larger queues/timeouts can hide overload and retain more producer state. |
| One atomic operation cannot fit even after successful maintenance | Inspect partition, contribution, segment and preparation limits. | Repeated synchronization cannot make an intrinsically oversized operation fit. |

`MaximumWorkingSetEntries` counts override/tombstone memberships, not total
writes. Repeated replacement of one entry does not necessarily consume another
slot. `MaximumEstimatedPartitionBytes` caps base plus working set; raising it
**8 -> 16 MiB** also raises recovery headroom **16 -> 32 MiB**.

### Wait, reject or stage

Keep `Reject` when the host needs an explicit bounded staging decision. If the
caller instead accepts waiting, separately test `WriteBehavior = Wait` with
`SynchronizationWaitTimeout = 5 ms`, while leaving ordinary `AdmissionTimeout`
unchanged. Neither is an end-to-end deadline.

Waiting may lower visible refusals while increasing latency, outstanding callers
and retained state. Fast rejection may leave logical requests unfinished.
Compare eventual logical completion, not just individual attempts. Maintenance
success grants neither capacity nor permission to replay stale expected revisions.

If representative maintenance tuning still misses delivery, closure or resource
objectives, compare the **same producer-owned eager alternative from branch A**.
Do not use a layout change to hide invalid contributions or unbounded intake.

## Branch C: contention and preparation scheduling

**Trigger:** substantial preparation is discarded on conflicts/admission, with
high allocation/CPU per useful change or poor per-writer progress. Distinguish
gate waiting from execution, speculative waste from useful preparation, and one
hot session from distributed sessions. Global allocation alone cannot attribute
discarded work; use existing diagnostics or controlled profiling.

First evaluate explicit producer-side per-session coordination/concurrency.
Coalesce redundant intents without changing key meaning. A hot session still
has one strict revision stream; more partitions or threads do not change that.

Then compare preparation scheduling independently of index layout:

```csharp
var options = LLMContextOptions.WriteOptimized;
var speculative = LLMContextFactory.Create(options)
    .WithExecutionStrategies(new ContextExecutionOptions
    {
        Preparation = ContextPreparationStrategy.Speculative
    });
var serialized = LLMContextFactory.Create(options)
    .WithExecutionStrategies(new ContextExecutionOptions
    {
        Preparation = ContextPreparationStrategy.Serialized
    });
```

These are separate comparison recipes, not two live authoritative stores.
This controls storage candidate preparation, not the caller's key generation;
producer-owned key preparation remains outside `Apply`.
Serialized preparation is experimental. Keep it only if less discarded work
improves the objective without unacceptable gate waiting, staging or refusals.
Earlier experiments removed waste without universally improving writer latency.
Attempt-count fairness and transition-count fairness are different measurements.

## Branch D: memory, retention, allocation and GC

| Observation | Investigate | First controlled action |
|---|---|---|
| Retained estimates remain high | Old leases/views, distinct pinned generations and projected outputs. | Restore short `WithCurrent` scopes and release unneeded handles. Preserve history the application actually requires. |
| Active estimates high but collected heap modest | Recovery, preparation and infrastructure reservations. | Attribute charges; do not treat accounting as live object size. |
| Managed heap grows despite recovered owner counters | Caller-held roots, producer packets/staging and output ownership. | Bound the responsible lifetimes. Bookkeeping recovery does not prove collection. |
| Allocation/GC grows with mutations | Complete preparation/write/maintenance lifecycle. | Bound intake; compare allocation per useful transition, including completion costs. Do not force full collections as a production policy. |
| Working set/private bytes grow | Runtime/native/thread/resource contributions as well as managed data. | Measure the whole process with stated sampling intervals/gaps. |

Partitioning improved complete measured lifecycle allocation and GC despite
larger reservations. The .NET 9 unpinned 480-mutation lifecycle included both
synchronizations; arrows mean eager -> partitioned:

| Metric | Common keys | Distinct keys |
|---|---:|---:|
| Managed allocation, MiB | 302.27 -> 48.73 | 278.14 -> 26.02 |
| Total GC pause, ms | 269.62 -> 43.24 | 233.16 -> 21.64 |
| Sampled managed peak, MiB | 76.16 -> 55.24 | 98.95 -> 77.31 |

Do not abandon the layout on memory grounds without attributing the actual cost.

### Capacity changes after attribution

| Confirmed limit | Candidate and constraint |
|---|---|
| Legitimate concurrent reads exceed the count ceiling | Test **2,048 -> 4,096 reads** only with resource headroom; raising the cap does not reduce retention. |
| Legitimate retained bytes exceed their separate ceiling | Test **256 -> 384 MiB retained** only when resident/process headroom supports it. |
| Live active state, not leaked retention, fills resident estimates | Retire unnecessary state and bound concurrency first; raise **512 MiB resident** only to an explicit deployment envelope. |
| Necessary atomic batch exceeds preparation ceiling | Split only if semantics permit; otherwise test **8 -> 16 MiB preparation** with headroom. Reservations use the segment-byte bound per incoming entry; a shrink does not pre-fund growth. |
| Legitimate entry/segment payload exceeds the segment limit | Repack imports within the selected geometry, or test **32 -> 64 KiB segment bytes** and recheck preparation costs. A single oversized entry cannot be automatically split. |
| Rebuilt partition cannot fit | Preserve contributions; test **8 -> 4 entries/segment** or a larger partition cap with its doubled recovery reserve. Do not prune caller keys or loop maintenance forever. |

Partly live base partitions carry deletion debt until synchronization; fully
empty segments drop their partition. Old snapshots retain their roots until
release. A zero estimate does not promise immediate GC or a hard process cap.

## Change only the selected setting

For an independent segment-sizing experiment identified by branch A, keep the
complete preset and change only occupancy:

```csharp
var options = LLMContextOptions.WriteOptimized with
{
    MaximumEntriesPerSegment = 16
};
using var contexts = LLMContextFactory.Create(options).Initialize(sessions);
```

For a partition-specific adjustment, copy the nested record as well:

```csharp
var startup = LLMContextOptions.WriteOptimized;
var options = startup with
{
    PartitionedIndex = startup.PartitionedIndex! with
    {
        MaximumEstimatedWorkingSetBytes = 6 * 1024 * 1024
    }
};
using var contexts = LLMContextFactory.Create(options).Initialize(sessions);
```

Options are construction-time settings. Neither example reconfigures a live
owner or repartitions existing segments. Imports must already obey the selected
segment entry/byte limits. Plan a controlled reconstruction/handoff when changing
an existing deployment; do not create an independent owner for every worker.

## Synchronization and resource semantics

Each physical segment has an immutable base entry index and authoritative
replacement contributions/deletion tombstones. A replacement shadows its entire
old contribution. Exact queries suppress stale base candidates, inspect bounded
overrides, merge partitions and eager anchor hits, then order/limit. A smaller
result limit does not remove partition fan-out. Text/deferred collectors and term
memoization are incompatible with this preset.

Deletion avoids walking every old posting and uses cached contribution sizes for
accounting. Removing a segment's last entry drops its active partition. Append
can start a new segment when the tail index is full even if payload space remains.
Explicit snapshots retain their original immutable roots.

`await contexts.SynchronizeIndexAsync(sessionId)` yields a durable receipt with
generation, content revision, compacted count and success/error. It closes
session-wide write admission, fences/drains speculative candidates, and rebuilds
one partition at a time. Reads and other sessions continue. One rebuild runs per
owner; outstanding requests are bounded. Concurrent callers join an outstanding
operation. Cancellation cancels that caller's wait, not the underlying rebuild.
Failure preserves authoritative state, possibly with some partitions compacted,
and reopens admission; the application decides when to retry.

`Synchronizing` means admission is closed. `SynchronizationRequired` rejects the
whole mutation, publishes no prefix and requests maintenance for dirty capacity.
A clean partition or atomic contribution that cannot fit returns
`AdmissionRejected`, not an endless synchronization loop. Successful completion
does not grant staged writes capacity or a new expected revision. Keep staged
work on a failed completion according to producer policy.

Recovery headroom is protected from ordinary admission. Partitioned session
`Apply` reserves before building candidates, accounting for intermediate commands
without treating future deletion as free space. Planning reads prepared-key sizes
and the configured segment-byte upper bound without walking producer payloads or
running their estimators. Reservations recover on all outcomes or transfer at
publication. Imports, catalog writes, projections and producer preparation retain
their separate documented allocation/admission behavior.

## Evidence and how to interpret it

The final stress campaign covered both runtimes/policy orders: **104 cases,
2,408,600 attempts and 39,148 recorded oracle checks**, including actual
1,000-thread traffic. At 10,000 scheduled requests/s across eight sessions,
useful contribution changes improved from approximately **590 to 9,160/s**.
Lifecycle allocation, sampled heap peaks and GC pauses also improved.

The concrete search tradeoff appears at 1,024 partitions: point-query p95 was
approximately **20-23 us eager versus 1.35-1.44 ms partitioned**. At 64 partitions,
partitioned point-query p95 was approximately 25-84 us across the two runtimes.
Use 64 as a review threshold, not a library-enforced or universally safe maximum.
The shrink/growth fixture used 16 entries/segment; that is evidence for a tuning
candidate, not a direct 8-versus-16 occupancy optimization experiment.

The published rates are bounded eight-second paced windows and two-second
dedicated-thread windows, not indefinite capacity. Lower allocation is a measured
benefit; the real costs to watch are selective-query fan-out, hot-session
conflicts, closure time and scheduling inequality. Exact caps were not swept to
find a universal optimum.

Full methodology/results: `benchmarks\LLMContextLib.StrategyBenchmarks\README.md`,
under **Verified stress results**. Raw reports/verified analyses and the exact
measured source/DLL archive are under `TestResults\PartitionedStress\Final`.
Reverify historical measurements against `Final\MeasuredIdentity`, not binaries
rebuilt after adding this named preset.

## Controlled comparison and promotion

### Freeze the changed dimension

Record source/DLL identity, runtime/GC, machine, budgets, producer policy and
workload distribution. State the failing objective, suspected mechanism and
acceptable tradeoffs before measuring. Hold key semantics, command boundaries,
segment geometry, timeouts and other limits fixed unless that setting is the
experiment. Compare eager versus partitioned with the same segmentation first.

### Exercise representative operating states

Include steady arrivals, bursts/overload with bounded intake, hot/distributed
sessions, actual transitions and same-state writes, clean/dirty indexes,
concurrent maintenance, point/absent/multi-key/common queries, required snapshots
and realistic contribution sizes. Include recovery, final maintenance and lease
release.

Alternate candidate/control order and retain multiple independent repetitions,
including individual run results. Pooled calls are not independent trials.
Keep explicit retry policy comparable. Different refusals can produce different
accepted histories: report those histories and use equal-work lifecycle
comparisons alongside fixed-arrival comparisons.

### Include every relevant cost center

Separate producer preparation, intake/staging, lookup, Apply, reads, concurrent
maintenance and final quiescent synchronization. Also retain the complete
user-visible latency and matching resource interval. Producer preparation stays
the producer's cost center even when included in an end-to-end bracket.

Do not compare only Apply when a candidate accumulates maintenance debt.
Conversely, a diagnostic that waits for maintenance after a cycle does not mean
every application must synchronously wait after every mutation.

For example, .NET 9 eight-session/high-rate stress improved accepted throughput
**1,718 -> 9,522 revisions/s** and actual changes **587 -> 9,165/s**, but live
query p95 was **119.2 -> 183.8 us** and final quiescent maintenance added a
median **52.1 ms** outside that throughput bracket. Judge the full objective set.

### Promote, retain the baseline or report the limit

Promote only when representative repetitions meet or materially improve the
failing objective while useful delivery, query tails, memory/GC, maintenance,
fairness and correctness remain acceptable. Define rollback and host-controlled
cutover before deployment.

Reject an apparent win caused by more drops/refusals, unchanged-state
publications, incomplete answers, hidden completion work or warm-only traces.
If neither candidate meets objectives, report an operating-envelope or
implementation limitation rather than stacking unrelated knobs.

Keep operator-selected profiles stable. Do not oscillate on one tail sample.
Automatic adaptation would need separate observation-window, hysteresis,
residence-time, migration and rollback contracts; none is implemented here.

## Advanced tuning candidates

This is the separate **owner-side text-indexing branch**, not further steps in
the producer-owned startup. Enter it only when the application requires the owner
to derive lexical keys. Start comparisons with native synchronous Text mode and
preserve its lexical contract.

| Measured Text-mode problem/opportunity | Candidate | Required countercheck |
|---|---|---|
| Repeated identical text | Bounded term memoization. | Cold misses, input/value eligibility and retained/reserved memory. |
| Repeated-word cold text with tokenization allocation | Lucene RangeBuffer. | Unique/long-token timing and allocation regressions. |
| New large entries miss foreground latency objectives | AppendOptimized deferral. | Full completion, exact pending search, backlog and admission. |
| Correction-heavy traffic | Synchronous correction with term diff. | Do not apply fixed deferral merely because append improved. |
| Mostly unique text with little reuse | Native no-memo control. | Cache overhead without useful work avoided. |

### Deferred full indexing for Text-mode workloads

**Candidate:** an application needs library-generated lexical text search and
profiling shows foreground tokenization dominates large appends. This does not
solve hot-session revision conflicts or partition query fan-out.

`WriteOptimized` uses producer-supplied keys and rejects deferred text settings.
Do not set `DeferredIndexing` on that preset. The following is a separate
Text-mode construction, where `decodedSessions` is an application-decoded
`IEnumerable<LLMSessionContext>` as described in
[Loading existing sessions](usage-documentation.md#loading-existing-sessions).

To bound foreground entry tokenization and complete indexing on one owner-managed
background worker:

```csharp
var options = new LLMContextOptions
{
    DeferredIndexing = new DeferredIndexingOptions
    {
        ForegroundWords = 128,
        ForegroundCharacters = 8192,
        MaximumPendingEntries = 64,
        MaximumEstimatedWorkBytes = 8 * 1024 * 1024
    }
};
using var contexts = LLMContextFactory.Create(options).Initialize(decodedSessions);
```

Existing `read.Search` stays exact by scanning pending entries. For a faster,
potentially incomplete result, use `read.SearchIndexed` and expose its
`IndexStatus.IsComplete` flag. `WaitForIndexingAsync(sessionId, acceptedRevision,
cancellationToken)` waits for that exact content revision; acquire a **new lease**
afterward. Old snapshots never refresh.

Pending full indexes and queued/running work are explicitly reserved against
estimated budgets before publication; backlog exhaustion rejects the whole write.
Disposal cancels/joins the worker. Prefix limits are not whole-mutation deadlines:
old-posting removal and background posting publication can still be expensive.
Deferred reservations can reject payloads that fit with synchronous indexing.

Compare Apply tails, exact-search tails during pending coverage, full-completion
latency, allocation/GC and rejected-write counts before adopting this path.
[Deferred indexing details](deferred-indexing.md) covers search, failure,
accounting, shutdown and reproducible measurements.

### Optional text collectors and memoization

**Candidate:** an existing Text-mode application profiles full-term collection as
a material cost, or repeated text offers a measurable memo hit rate. Compare cold
misses as well as hits, reserved/retained memory and full indexing completion.

Lucene collection and owner-scoped BitFaster memoization are separate optional
adapters, not components of `WriteOptimized`. Producer-owned mode rejects those
text strategies. For the API wiring, see
[Composed execution strategies](usage-documentation.md#one-owner-composed-execution-strategies)
and [Execution strategy details](execution-strategies.md). No composition is
selected automatically or established as a universal performance winner.

For applicable profiles inspect `MemoHits`, `MemoMisses`, `MemoBypasses`,
`MemoAdmissionBypasses`, `MemoEntries` and reservation cost in execution
statistics. Distinguish hit rate among eligible lookups from coverage across all
preparations. A key can fit while its computed value cannot. A memo hit supplies
complete terms, potentially returning posting work to the foreground instead of
the deferred route. The maintained integrated memo is LRU; do not present
unintegrated policies as current configuration choices.

For deferred work, track `PendingIndexWork`, `EstimatedIndexWorkBytes`,
full-completion/pending-query latency, observed failures, capacity fallbacks and
retained partial roots. Work bytes are already charged in active estimates.
Faster foreground Apply can coexist with slower completion; indexed-only
incomplete answers are not faster exact search.

## Original constructor defaults

These are compatibility/reference values for `new LLMContextOptions()` and
`LLMContextFactory.Create()` without the recommended preset, not an alternative
recommended startup.

| Setting | Original default |
|---|---:|
| Indexing | Text; no partitioned working sets |
| `MaximumEntriesPerSegment` | 128 |
| `MaximumEstimatedBytesPerSegment` | 256 KiB |
| `EstimatedResidentByteBudget` | 64 MiB |
| `MaximumEstimatedRetainedBytes` | 64 MiB |
| `MaximumRetainedReads` | 128 |
| `MaximumViewResults` | 4,096 |
| `AdmissionTimeout` | Zero |
