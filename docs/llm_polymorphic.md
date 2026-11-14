# Current LLM context contract

The existing contract and non-goals are carried forward, not redefined by the
extraction. The full inherited specification and its implementation/measurement
record are preserved byte-for-byte in `history\llm_polymorphic.md`.
This entry point records only the standalone naming/construction changes and
the architectural guarantees needed to read that historical document correctly.

## Standalone surface

All domain types now live in namespace `LLMContextLib`.

```csharp
using var contexts = LLMContextFactory.Create(options).Initialize(sessions);
```

The result is one `ILLMContextPolymorphicArray`, directly inheriting `IDisposable`
and declaring `TryFind(Guid, out LLMSessionContext)`. It no longer inherits the
generic `IPolymorphicArray`. Its remaining public operations are unchanged:
`CreateSession`, `RemoveSession`, `Apply`, `ApplyMemory`, `OpenRead`, `OpenView<T>`,
and `GetStatistics`. Opt-in deferred indexing additionally exposes
`WaitForIndexingAsync`; read leases expose `IndexStatus` and `SearchIndexed`.
Opt-in `WithProducerOwnedIndexing()` additionally accepts `ContextIndexKeys` on
entries/drafts/replacement commands/anchors and exposes exact `SearchKeys` on reads
and view definitions. The original factory remains in Text mode.

`ILLMContextReadLease`, `ILLMContextViewDefinition<T>`, `ILLMContextView<T>`, and
`IContextMutationResult` retain their existing semantics and names.
There is no public bridge/storage constructor, writable backing array, generic
engine, or overlay to initialize alongside the client.

The optional `sessionIdSelector` factory argument preserves the former identity
validation path: its result must equal each session's canonical `SessionId`.
Ordinary Guid equality is fixed; generic equality/overlay configuration is absent.
Options are validated at factory creation. Invalid/duplicate initial sessions
fail initialization and dispose the partially constructed owner.

## Ownership and publication

```text
Application -> ILLMContextPolymorphicArray
                    |
           internal owning bridge
                    |
          internal ILLMContextStorage
                    |
          SegmentedContextStorage
```

Immutable session roots publish ordered segments, entry locations, anchors,
per-entry lexical terms, and search indexes together. IDs remain stable across
edits; deleted identities cannot be reused. Expected-revision checks prevent stale
updates without automatic retry.
Memory-catalog changes have their own revision/publication boundary.

Read leases capture a session root and a memory root independently. They are
coherent for those captured revisions, not a cross-catalog transaction. Captured
reads and retained views remain valid after writes, removal, and owner disposal.
Readers do not take a session writer lock. Per-session writers, owner-wide
resource admission, and memory publication use distinct gates.

`WithCurrent(sessionId, callback)` is the recommended synchronous read pattern:
each invocation owns an independent unevaluated read, captures at first access,
reuses that lease through the callback, then releases/clears it even on failure.
An unused callback captures nothing. Do not retain, dispose, concurrently use or
run asynchronous work against this borrowed read. Explicit snapshots/views retain
their existing lifetime guarantees; escaped result data is caller-owned.

Limits govern conservative estimated active/retained/view resources. They do not
bound every escaped immutable graph, caller-owned result array, or actual process
heap byte. Estimator callbacks must be stable/non-reentrant; synchronous admission
does not accept cancellation tokens.

`WithPartitionedIndexing()` opts into producer-owned segment-local entry indexes
and bounded authoritative working sets. Anchor indexes remain eager/session-wide.
Overrides shadow entire base contributions; exact search filters before global
ordering/limiting and never combines base/override keys for one entry. The root
directory, payload, locations, entry terms and anchors still publish atomically.
Whole-partition deletion drops active index ownership; pinned reads still retain
their captured version.

`SynchronizeIndexAsync` returns a durable generation-tagged result. Its admission
barrier remains session-wide, matching current revisions: in-flight speculative
candidates crossing that barrier cannot publish, even if content revision is
unchanged. Pre-existing preparations drain before rebuilding. Reads continue
and per-partition maintenance preserves content
revision. One owner-wide rebuild runs at a time; outstanding requests are bounded.
Successful completion follows admission reopening; failure reopens admission
without losing authoritative overrides, including after partial maintenance.
Caller cancellation affects waiting only; owner disposal cancels/drains maintenance.

Partitioned `Apply` acquires conservative construction reservations before builder
work. Active charges include fixed recovery headroom (twice the partition cap),
infrastructure, all un-reclaimed base/override data and outstanding preparations.
Shrink cannot fund growth before admission. Limits reject whole transactions,
and oversized atomic contributions are not silently split. Producer-selected
reject/bounded-wait behavior is explicit; staging and revision-conflict recovery
remain producer responsibilities. Imports/catalog writes retain their original
prepare-before-final-admission behavior. This is not a hard CLR heap guarantee.

## Owner-private entry terms

Optional factory execution strategies now compose behind this same owner/storage
boundary. They select full-term collection, separately budgeted incoming-text
memoization, entry-index routing and preparation scheduling, not different public
owners or weaker semantics. The original factory path remains unchanged.
See `execution-strategies.md` for configuration, ownership and measurement limits.

In ProducerOwned mode, complete opaque index contributions are supplied by each
producer, independently, rather than generated by storage. Supplied keys are
immutable, distinct and ordinal-sorted by their construction API; their meaning,
case, punctuation, spaces and relation to content remain application policy.
Entries and anchors require an explicit contribution (possibly empty), including
imports and replacements. Missing keys reject atomically. Text mode rejects
supplied contributions rather than silently ignoring them.

Key generation/sorting occurs before submission, while applying shared postings
and segment updates remains owner work. Expected session revisions, identities,
admission, rollback and escaped-read lifetimes are unchanged. Key-only changes
update the same atomic root even when the payload reference is unchanged.
Query keys are supplied through `SearchKeys`/`ContextViews.SearchKeys`; these
intersect exact memberships at a single indexed address, not inferred payload
semantics. ProducerOwned mode does not run text tokenization, memoization or a
deferred worker, and text-query APIs fail explicitly. Preparation scheduling
remains selectable. The existing context payload types/validation are unchanged.

Producer preparation is an independent producer responsibility/cost center:
its policy, CPU/allocation and scheduling are outside the storage `Apply` call.
Storage still owns destination-dependent state preparation and atomic publication.
Measure producer preparation, storage Apply and their end-to-end pipeline
separately; preparation + Apply is not the storage write-latency metric.
This execution-cost separation does not remove published keys from owner resource
and snapshot-retention accounting.

Each generation owns an immutable directory from live entry ID to that entry's
distinct, ordinal-sorted lexical terms. Initialization and append compute the
terms once. Replacement tokenizes only the new payload and compares it with the
retained old array; deletion removes postings using the retained array. This does
not eliminate old-payload access by caller-supplied size estimators. Anchor
descriptions and search queries continue to use their existing tokenization path.

In Text mode the directory is private derived state, not part of the public
session/import format; ProducerOwned entries expose their supplied `IndexKeys`.
It publishes atomically with the matching search index. Equivalent lexical
edits share the existing term array and directory; other edits replace only the
changed entry's membership. Mixed transactions and repeated edits use their latest
private candidate, not an earlier committed array. Rejected/conflicting candidates
do not enter the active cache. Deletion removes the active cache membership but
still preserves the existing identity reservation.

There is no global dictionary, intern pool, or independently retained edit history.
An older directory survives only while an old immutable state remains reachable,
including captured reads and in-flight preparation. The existing read-admission
and disposal rules apply; multiple revisions can therefore retain multiple arrays
for one entry. Preparation is still transient work performed before final admission,
not a hard-bounded heap region.

The root estimate charges its extra eight-byte directory reference. Each live entry
adds `128 + 8 * termCount + sum(32 + 2 * term.Length)` bytes for the directory
membership, array, references, and strings. Empty-term entries still have membership
overhead. This conservative charge is independent of the entry payload estimator
and is not discounted for strings shared with search keys. Active/resident and
full captured-root admission both include it; segment payload byte limits do not.
Previously fitting workloads may need more budget or fewer live entries/read
generations. The optimization is a deliberate CPU/allocation-versus-retention
tradeoff, not a free cache.

The root now also charges sixteen bytes for its pending-index directory reference
and index-generation field. Deferred mode is explicitly opt-in: published roots
contain matching partial postings and coverage until owner-managed completion,
while existing `Search` stays exact through pending-entry fallback. Completion
advances index generation without changing content revision. Worker infrastructure,
queued/running work and remaining indexes receive separate conservative charges;
captured partial roots keep their original full charge. The detailed contract,
limits and executable comparison are in `deferred-indexing.md`.

### Measured retention tradeoff

A bounded local diagnostic compared the pre-change root commit `c59fbf6` with the
retained-term implementation, using SDK 9.0.320 on Windows x64, .NET 8.0.34 and
.NET 9.0.22, workstation GC, and default tiering settings. Two adjacent
baseline/optimized process pairs ran per runtime, reversing runtime order in the
second pair. These are diagnostic results, not BenchmarkDotNet confidence intervals,
production capacity measurements, or evidence of lower GC pauses.

Replacement samples cover the complete public `Apply` call on a 32-entry owner,
with prebuilt requests/content, 256 warmup transactions, and seven rounds of 128
transactions per process. The table gives median **bytes allocated per single-entry
replacement**, pooled over the fourteen rounds; the local probe also measures
eight-entry transactions separately.

| Payload | .NET 8 baseline -> retained terms | .NET 9 baseline -> retained terms |
|---|---:|---:|
| 14 characters, 2 distinct terms | 5,776 -> 5,704 B | 5,904 -> 5,720 B |
| 3,583 characters, 512 occurrences, 2 distinct terms | 42,616 -> 24,161 B | 42,713 -> 24,177 B |
| 5,119 characters, 512 distinct terms | 136,323 -> 71,201 B | 136,515 -> 71,361 B |

The mostly-unique fixture changes one of its 512 terms; unchanged postings still
share. Repeated-text single-replacement allocation fell about 43%, and
mostly-unique allocation about 48% on .NET 9. Timing varied substantially between
processes, and the short eight-entry case regressed on .NET 9; there is no universal
speedup claim.

Heap sampling is separate from timing. Each process takes three independent owner
samples using full managed collections, first with only the active root and then
with a captured generation zero while every entry is replaced. Caller input graphs
are constructed before the heap baseline and kept alive; entries deliberately share
the fixture's immutable input string. These deltas isolate incremental owner
retention, not total payload/process memory. The following .NET 9 deltas are
differences between variant medians; .NET 8 showed comparable retention.

| Payload / owner size | Additional active-root live heap | Additional live heap with old + new roots | Additional initial-root admission charge |
|---|---:|---:|---:|
| Short / 2,048 entries | about 384 KiB | about 768 KiB | about 468 KiB |
| Repeated / 2,048 entries | about 368 KiB | about 736 KiB | about 464 KiB |
| Mostly unique / 256 entries | about 6.00 MiB | about 12.03 MiB | about 7.28 MiB |

The mostly-unique case's active-plus-old-root **additional admission charge** is
about 14.56 MiB, distinct from its roughly 12.03 MiB additional live heap. The
charge follows the full-root accounting contract even when immutable objects share.
Thus the cache saves old-content preparation but can materially reduce admitted
entry/snapshot capacity. Import/append throughput and realistic long-running
capacity remain separate investigations tracked in `TODO.md`.

Local raw evidence and its runnable source are retained under
`TestResults\EntryTermsReview` (ignored, not packaged): `source\Program.cs`,
`Run.ps1`, `Analyze.ps1`, `dotnet-info.txt`, preserved baseline/optimized source
and binaries, eight runtime/variant/pass JSON reports, and `summary.json`.
Reports retain every sample, runtime/GC settings, and SHA-256 hashes of the
measured library, state implementation, and probe. The analyzer verifies those
hashes against the final build. Correctness validation passed 113 tests per runtime,
the existing whitespace checks, and all 21 oracle smoke cases per runtime.

## Scope and non-goals

Supported scope remains session lifecycle and atomic change sets; immutable
segmented histories; timeline/model/navigation/search/applicable-memory views;
stable contextual anchors; explicit user/repository/session/combined memory
scopes; and revisioned reads with retention admission.

This is not a model runtime, model KV cache, exactly-once tool-execution system,
or initial persistence/distributed storage implementation. Scoped memory conditions
describe applicability, not authorization grants.

## Reading the inherited design

In `history\llm_polymorphic.md`, sections 1-12 describe the domain contract;
13-15 describe implementation, complexity, and verification; 16-20 retain the
experiments, architectural decisions, and known limitations.

References there to `ScalablePolymorphicArray.Llm`, the generic base/factory,
old project paths, commands, and artifacts describe the original repository.
Apply the mapping in `extraction.md` for current code. Do not reinterpret old
benchmark numbers as measurements of this extracted repository.
