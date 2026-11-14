# Deferred full indexing

**Experimental, opt-in.** The default still indexes all entry content synchronously.
Deferred indexing bounds foreground tokenization per changed entry, returns with
explicit partial index coverage, and finishes the entry index on one owner-managed
background worker. This moves work; it does not eliminate full indexing or promise
a wall-clock deadline, better total throughput, or lower total allocation.

## Configure the single owner

```csharp
using var contexts = LLMContextFactory.Create(new LLMContextOptions
{
    DeferredIndexing = new DeferredIndexingOptions
    {
        ForegroundWords = 128,
        ForegroundCharacters = 8192,
        MaximumPendingEntries = 64,
        MaximumEstimatedWorkBytes = 8 * 1024 * 1024
    }
}).Initialize(decodedSessions);
```

`DeferredIndexing = null` preserves synchronous full indexing. Options are fixed
at construction. Both initialization and later session creation/mutation use the
selected policy. Anchors remain fully indexed synchronously; memory catalogs and
other view-selection policies are unchanged.

The worker belongs to this owner, not to an application worker, read lease, or
individual write. Share this one owner; stop/join application borrowers before
disposing it. Disposal cancels/joins the index worker and releases all queued and
running reservations. There is no `Task.Run` per write and no global content cache.

## Search contracts

| API | Pending or failed entry indexing |
|---|---|
| `read.Search(query, limit)` | Exact: intersect postings and scan pending entries as necessary |
| `read.SearchIndexed(query, limit)` | Published postings only; inspect the returned `IndexStatus` |
| `read.IndexStatus` | Coverage of this captured generation, never a live progress object |
| `contexts.WaitForIndexingAsync(id, revision, token)` | Wait for that exact content revision and its session jobs; acquire a NEW lease afterward |

Exact fallback inspects all pending entries that did not already match their
indexed terms. It is not a zero-hit-only fallback: another entry's indexed match
must not hide a matching suffix in a pending entry. Entry text and anchor metadata
keep distinct addresses; query words cannot be combined across them.

```csharp
using (var read = contexts.OpenRead(sessionId))
{
    var exactHits = read.Search("later failure", 32);
    var fast = read.SearchIndexed("later failure", 32);
    // fast.Hits may omit matches when !fast.IndexStatus.IsComplete.
    // Return that coverage flag to consumers rather than claiming "no matches".
}

await contexts.WaitForIndexingAsync(sessionId, acceptedRevision, cancellationToken);
using var indexedRead = contexts.OpenRead(sessionId);
// A concurrent content write can occur after the wait returns.
if (indexedRead.Session.Revision != acceptedRevision || !indexedRead.IndexStatus.IsComplete)
    throw new InvalidOperationException("The selected revision is no longer the completed snapshot.");
var indexedHits = indexedRead.SearchIndexed("later failure", 32).Hits;
```

Waiting does not refresh old leases. An old partial lease remains partial even
after a new lease sees a complete index; its exact `Search` continues to work
after owner disposal. A materialized view likewise retains its original results.
Result limits still bound output, not query work, fallback scanning, or sorting.

The wait throws explicitly on a content-revision change, session removal, worker
failure, or owner disposal. Cancellation cancels only the caller's wait, not
accepted indexing. There is no implicit content rebase or retry.
Outstanding wait tasks are caller-owned, not counted by the job-capacity limit;
the host must bound concurrent wait requests and cancel abandoned waits.

## Foreground work and background publication

The prefix scanner counts word OCCURRENCES before deduplication. Repeated words
consume the allowance. A separate UTF-16 character allowance also counts separators,
so a huge word or punctuation-only input cannot bypass the foreground scan bound.
An unfinished word at the character cutoff is discarded and background scanning
resumes at that word's start; partial words are never indexed as real tokens.

The scanner consumes the same character stream, casing, classification, distinct
ordering and tool-field separators as `ContextPolicies.Terms(ContextPolicies.Text(...))`.
It does not split a complete string into an array, sort all words and then Take,
or first format/copy an entire tool JSON payload. The default payload estimator
also calculates formatted length without creating that full string. Caller-supplied
estimators still run under their existing stable/non-reentrant contract.

Completion seeds the prefix terms and resumes the remainder. It checks the pending
entry's identity again before publishing: replacement/deletion/session removal
cannot resurrect stale text. Superseded jobs retain their slot/byte charges until
the worker actually discards them, rather than freeing capacity prematurely.
Rejected or invalid mutation candidates never enqueue work.

Each completion atomically publishes a matching immutable term/postings/coverage
root. `Session.Revision` and the session object remain unchanged; `IndexGeneration`
advances. Speculative content writers may merge only this derived progress into
their private candidate. An actual intervening content publication still conflicts
at the original expected revision; no automatic retry/rebase is introduced.

The bounds cover tokenization per entry, NOT every cost in a transaction:

- Multiple entries each receive their own prefix allowance; validation and custom
  estimators are not deadline-bounded.
- Replacement/deletion still removes old postings synchronously. A mostly-unique
  old entry can therefore cost substantial foreground work.
- Background tokenization runs outside the writer gate, but postings construction
  and publication currently hold it. Competing writes can wait or be rejected by
  their normal admission timeout. This critical section is not duration-bounded.
- Completion cancellation is cooperative. Sorting/postings publication are not
  interruptible at every instruction; shutdown is not a hard-deadline guarantee.

## Reservations, backpressure, and failure

All reservations below are estimates, not measured object graphs or hard heap caps.
They are charged independently of a custom payload-size estimator.

For formatted UTF-16 length `C`, define:

```text
Umax = ceil(C / 2)
Remaining-index reservation = 1024 + 200 * Umax + 4 * C
Per-job work reservation    = 512 + 8 * C + remaining-index reservation
Worker infrastructure      = 1024 + 128 * MaximumPendingEntries
```

At most `ceil(C/2)` nonempty distinct words fit with intervening separators. The
index reserve covers conservative term membership, new term buckets and postings,
plus pending/error metadata. The work reserve also covers queued content references
and estimated temporary tokenization work. Shared input/term strings are not
discounted. These formulas deliberately overestimate repeated-word input.

The active root charges its actual prefix plus the remaining-index reservation.
The owner separately charges every queued/running job and worker infrastructure.
`EstimatedResidentByteBudget` includes them; `MaximumEstimatedWorkBytes` separately
limits the queued/running work component. `MaximumPendingEntries` bounds total
queued PLUS running jobs across all sessions, including superseded jobs.

All jobs for one publication are checked together. Exhausting either backlog
limit rejects the complete publication as `AdmissionRejected`, without enqueuing
a prefix of its jobs. Queue-limit exhaustion rejects immediately rather than
waiting for a queue slot. Ordinary resident admission retains its configured
timeout. Factory initialization converts admission failure into its existing
exception/partial-owner cleanup behavior.

Full-index publication releases the pending reservation, adding the remaining
memberships within that already-admitted estimate. Work charges release only when
processing really ends. Thus completion does not require waiting for another
resident-budget admission. A payload that would fit with synchronous indexing can
be rejected in deferred mode because its conservative future/work reservations
are larger. Increase budgets only deliberately; this is a latency/capacity tradeoff.

Captured partial roots retain their full root estimate, including their pending
reservation, for their entire lease lifetime. Completion does not shrink an old
snapshot's charge. Multiple read generations can therefore consume substantial
retention capacity even after the active root becomes smaller.

Statistics add `PendingIndexWork`, `EstimatedIndexWorkBytes`, `CompletedIndexJobs`
and `DiscardedIndexJobs`. Work bytes are ALREADY included in active bytes: do not
add them twice. Completion does not increment `PublishedMutations`.

An entry-level failure leaves explicit pending/error metadata; `FailedEntries`
and `Error` identify it, exact search still scans its content, and waiting throws.
Its future-index reserve remains charged. Replacing the content with a new content
record can schedule a new attempt; deletion releases the active reservation.
There is no automatic retry loop. Unexpected worker-level failure rejects new jobs
and is surfaced by waiting.

## Reproduce the comparison

The diagnostic is part of the existing benchmark executable; no package is added.
Use the repository's pinned SDK and both runtimes:

```powershell
dotnet build LLMContextLib.sln -c Release
foreach ($framework in @('net8.0', 'net9.0')) {
    $probe = "benchmarks\LLMContextLib.Benchmarks\bin\Release\$framework\LLMContextLib.Benchmarks.dll"
    dotnet $probe --deferred-indexing `
        --output "TestResults\DeferredIndexing\Final\$framework-forward.json"
    dotnet $probe --deferred-indexing --reverse `
        --output "TestResults\DeferredIndexing\Final\$framework-reverse.json"
}
& benchmarks\LLMContextLib.Benchmarks\Analyze-DeferredIndexing.ps1
```

The comparison uses synchronous, 128-word and 512-word policies; repeated and
mostly-unique payloads; append and replacement of a previously FULLY indexed entry.
Natural worker scheduling is enabled in the mutation samples. Every accepted write
must finish, release work charges, and produce the expected suffix hit.

Foreground allocation is current-thread allocation around `Apply`. Process-wide
allocation through completion also includes worker, wait, statistics-instrumentation
and runtime work; it is not isolated worker allocation. Timing brackets include
instrumentation and report per-call percentiles, not percentiles of batch averages.
Owner setup, initial replacement indexing and request construction are outside the
measured write. Completion is timed from BEFORE Apply through the completion wait.
There is one outstanding measured write, not a loaded/concurrent-writer capacity test.

SEPARATE query samples deliberately block the worker before tokenization to measure
a genuinely partial captured root, then release it and open a fresh completed lease.
Those blocked samples do not measure natural completion latency. Their resource
figures are conservative admission estimates, NOT retained heap measurements.

The four reports retain raw timings, source/deployed-assembly hashes, runtime/SDK/
GC settings and timer calibration. The analyzer verifies fingerprints and group
completeness, pools raw query calls, and writes `summary.json`, `mutations.csv`
and `queries.csv` in the evidence directory. Evidence is ignored under TestResults.

## Measured result

Windows x64, SDK 9.0.320, workstation GC, default runtime tiering; .NET 8.0.34 and
.NET 9.0.22. Four final processes retained 2,688 measured public mutation calls
and 6,912 individually timed queries. Source and deployed assembly fingerprints
match all four reports. Each mutation row pools 112 calls per runtime, query rows
192 calls; these small diagnostic populations do not establish service p99/SLA.
Empty timer brackets had p95/p99 of 100 ns on both .NET 9 processes; no subtraction.

The repeated input has 22,539 characters and three full terms; mostly-unique input
has 20,491 characters and 2,049 terms. Replacement changes the last marker of an
already fully indexed entry, leaving most terms unchanged. All measured writes
were accepted and converged to a complete suffix-searchable index with zero work
reservations. The prefix variants cap characters at 8,192 in addition to word count.

### Public mutation latency

.NET 9, **microseconds per individual call**, lower is better. Completion starts
before Apply and ends after the indexing wait, not merely after the early return.

| Input / operation | Policy | Apply p50 | Apply p95 | Apply p99 | Full completion p50 |
|---|---|---:|---:|---:|---:|
| Repeated / append | Synchronous | 206.10 | 359.20 | 468.40 | 207.40 |
| Repeated / append | Deferred128 | 69.90 | 117.90 | 147.90 | 342.70 |
| Repeated / append | Deferred512 | 95.90 | 180.40 | 871.60 | 342.00 |
| Repeated / replace | Synchronous | 166.20 | 232.70 | 452.60 | 167.90 |
| Repeated / replace | Deferred128 | 51.40 | 74.70 | 99.70 | 263.90 |
| Repeated / replace | Deferred512 | 70.30 | 99.60 | 116.00 | 268.30 |
| Unique / append | Synchronous | 3,551.30 | 8,980.50 | 13,551.40 | 3,558.30 |
| Unique / append | Deferred128 | 287.70 | 718.70 | 789.60 | 4,087.80 |
| Unique / append | Deferred512 | 871.80 | 2,583.40 | 3,405.80 | 3,872.10 |
| Unique / replace | Synchronous | 570.70 | 1,813.80 | 2,111.30 | 572.70 |
| Unique / replace | Deferred128 | 1,666.00 | 4,186.60 | 7,057.50 | 3,738.50 |
| Unique / replace | Deferred512 | 1,358.70 | 3,074.00 | 3,902.70 | 3,253.60 |

The matching .NET 8 comparison:

| Input / operation | Apply p50: sync / Deferred128 | Apply p95: sync / Deferred128 | Full completion p50: sync / Deferred128 |
|---|---:|---:|---:|
| Repeated / append | 166.40 / 57.30 | 265.70 / 79.90 | 168.50 / 286.20 |
| Repeated / replace | 157.90 / 48.70 | 203.80 / 68.70 | 159.60 / 263.10 |
| Unique / append | 3,543.20 / 282.40 | 5,607.60 / 407.50 | 3,548.80 / 3,646.60 |
| Unique / replace | 560.30 / 1,990.40 | 1,508.60 / 3,175.50 | 562.80 / 4,050.40 |

**Important regression:** mostly-unique replacement is worse, not better. The
synchronous path retains/diffs the full old terms and rewrites only the changed
marker. Deferred replacement removes many old postings to publish a prefix, then
rebuilds them in the background. This churn dominates its bounded tokenization.
Append benefits do not justify promoting this policy for correction-heavy workloads.

### Allocation and pending query cost

.NET 9 median bytes; process-wide values include the diagnostic/runtime work
described above and must not be presented as isolated worker allocation.

| Input / operation | Apply caller bytes: sync / Deferred128 | Through-completion process bytes: sync / Deferred128 |
|---|---:|---:|
| Repeated / append | 135,056 / 8,728 | 135,352 / 139,016 |
| Repeated / replace | 134,160 / 7,544 | 134,456 / 137,640 |
| Unique / append | 2,052,704 / 96,524 | 2,053,000 / 2,013,228 |
| Unique / replace | 281,248 / 1,329,164 | 281,544 / 3,241,716 |

Separately controlled .NET 9 suffix queries:

| Input / query state | p50 us | p95 us | p99 us | B/call | Hits |
|---|---:|---:|---:|---:|---:|
| Repeated / synchronous exact | 1.90 | 2.70 | 2.90 | 1,680 | 1 |
| Repeated / Deferred128 pending exact | 167.40 | 195.80 | 491.30 | 133,568 | 1 |
| Repeated / Deferred128 pending indexed-only | 1.30 | 2.00 | 2.10 | 1,040 | 0 |
| Repeated / Deferred128 fresh indexed-only | 2.00 | 3.00 | 8.40 | 1,928 | 1 |
| Unique / synchronous exact | 0.40 | 1.10 | 1.30 | 1,680 | 1 |
| Unique / Deferred128 pending exact | 316.80 | 391.20 | 753.00 | 279,344 | 1 |
| Unique / Deferred128 pending indexed-only | 0.40 | 1.00 | 1.30 | 1,024 | 0 |
| Unique / Deferred128 fresh indexed-only | 0.40 | 1.10 | 1.30 | 1,912 | 1 |

The fast zero-hit rows are INCOMPLETE results, not faster equivalent searches.
Exact search preserves matches but shifts tokenization/allocation to the reader
while pending. Loaded writers/readers, shared ThreadPool competition and queue
saturation are not characterized by this one-outstanding-write experiment.

### Conservative reservation cost

Captured, deliberately pending owner estimates on .NET 9, one entry and one job:

| Input | Policy | Active bytes INCLUDING work | Work bytes already included | Captured-root retained charge |
|---|---|---:|---:|---:|
| Repeated | Synchronous | 46,518 | 0 | 46,470 |
| Repeated | Deferred128 | 4,926,674 | 2,526,004 | 2,391,406 |
| Unique | Synchronous | 525,314 | 0 | 525,266 |
| Unique | Deferred128 | 4,509,982 | 2,296,628 | 2,204,090 |

These are NOT live/peak managed heap measurements. Conservative word-count bounds
are particularly expensive for repeated text. Once complete with no captured
partial root, the active estimate is 55,734 B for repeated input and 534,530 B for
unique input, just 9,216 B above the synchronous owner (worker infrastructure).
An old partial lease retains its larger charge until disposal. No actual peak
heap, GC-pause, loaded-throughput or capacity claim follows from these estimates.

Final validation passed 137 tests per runtime (24 new deferred-indexing cases),
21 oracle smoke cases per runtime, a zero-warning solution build and whitespace
validation. It includes a real collection regression for an idle worker retaining
deleted completed content, not merely zeroing bookkeeping counters.
