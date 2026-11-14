# Design concerns and opportunities

> **Experimental work in progress.** This is an open design backlog, not a release
> roadmap or a claim of production readiness. There is no stable, versioned release.

The README describes current behavior and limitations. Items below are not
implemented merely because they are listed. Agree on the contract and acceptance
criteria before changing defaults, broadening scope, or optimizing storage.
Mark an item complete only with implementation/documentation and supporting
correctness evidence; performance claims also require matched measurements.

## Resource safety and long-running ownership

- [ ] **RES-01: Bound preparation and queued work.** Imports and mutation candidates
  can allocate before final budget admission. Design explicit input/transaction
  limits and bounded concurrent preparation, distinguishing host intake from core
  storage admission. Verify rejection, rollback, and resource recovery under large
  batches and competing writers; do not describe estimates as hard heap caps.
  Opt-in partitioned producer-owned session Apply now reserves before construction,
  keeps recovery headroom and bounds synchronization backlog. Imports, catalog
  writes, producer intake and the original index path remain outside that guarantee.

- [ ] **RES-02: Bound projection and read-output exposure.** View count limits do
  not bound evaluator work or intermediate allocation, and direct read arrays can
  escape accounting. Define enforceable limits versus caller obligations, including
  custom projection estimators. Verify failure cleanup and document what arbitrary
  callbacks or retained application objects cannot be constrained by the library.

- [ ] **RES-03: Define retention and cleanup policy.** Expiry filters reads rather
  than evicting records; closed sessions and unused memory remain stored. Decide
  which cleanup facilities belong in the core versus the host, including provenance
  retention when source sessions disappear. Preserve existing snapshot lifetimes
  and independent session/catalog revision semantics.

- [ ] **RES-04: Address identity-history and empty-segment accumulation.** Deleted
  entry IDs, removed session IDs, and physical metadata retain estimated charges.
  Explore safe owner rotation or compaction boundaries without allowing old
  bookmarks to redirect to reused identities. Verify churn, budget exhaustion,
  retained snapshots, and any migration/identity-history contract.

- [ ] **RES-05: Revisit cancellation and admission semantics.** Synchronous calls
  have no cancellation token; admission timeout is not an end-to-end deadline.
  Deferred-index completion waiting now accepts cancellation, but this does not
  cancel accepted indexing or mutation admission. Assess broader asynchronous/
  cancellable mutation APIs. Specify fairness,
  shutdown, waiting-work bounds, and timeout semantics before introducing one;
  retain strict conflicts rather than rebasing while waiting.

## Session ingestion and persistence boundaries

- [ ] **ING-01: Design optional bounded loading adapters.** Existing entry points
  ingest decoded sessions, not files or HTTP responses. Decide whether versioned
  codecs and transport adapters should be separate host/example components.
  Specify payload discriminators, transport/decoded-size limits, cancellation,
  and input validation; do not implicitly turn the core into a persistence service.

- [ ] **ING-02: Decide whether durable checkpoint/restore is in scope.** Public
  session roots omit deleted-ID reservations and next-sequence history; a new memory
  catalog has its own revision. Imports also reject unresolved anchor endpoints
  that a live session can retain. Define identity, degraded-anchor, catalog, and
  compatibility semantics before promising round trips. Until then, call this
  ingestion, not full owner restoration.

## Worker integration and recovery

- [ ] **INT-01: Extend failure/recovery examples.** Demonstrate retaining completed
  external results after recording conflicts, unavailable provenance, admission
  rejection, and interrupted multi-step investigations. Make authorization,
  confirmation, request bounds, and draining shutdown explicit host policies.
  Never imply automatic retries, rollback of external side effects, or exactly-once
  tool execution.

## Measured performance opportunities

- [ ] **PERF-01: Attribute deletion preparation allocation first.** This is the
  next investigation, not an approved location-builder rewrite. Separate beginning,
  middle, and end deletion costs into location updates, index maintenance, and
  segment copying. Follow `docs\extraction.md`; preserve intermediate validation,
  checked accounting, rollback, and oracle equivalence.

- [ ] **PERF-02: Evaluate append coalescing.** A batch can rewrite the same tail
  repeatedly. Measure transaction-local coalescing while preserving draft order,
  identity assignment, estimator/validation behavior, segment limits, and atomic
  publication. Do not extend replacement-only optimizations to mixed transactions
  without proving equivalent behavior.

- [ ] **PERF-03: Improve bounded query execution where measured.** Investigate
  range traversal, limited search candidate selection, and model-context grouping.
  Current result limits do not imply bounded-tail or O(limit) work. Preserve
  deterministic ordering, revision-correct cursors, summary policy, and complete
  eligible tool pairs; measure allocation as well as elapsed time.

- [ ] **PERF-04: Keep preparation-policy promotion evidence-gated.** Speculative
  preparation remains the default; the factory's serialized pin remains experimental.
  Compare wasted preparation, admission outcomes, contention, and tail latency
  using matched sources and alternating runs. Do not promote it from allocation
  improvement alone or claim broad speed/GC improvements from mixed evidence.

- [ ] **PERF-05: Evaluate retained-term density and snapshot capacity.** Owner-private
  per-entry terms now avoid old-content retokenization and are explicitly charged
  to resident/captured-root budgets. Mostly-unique payloads retain substantially
  more strings than repeated-word payloads. Measure realistic lexical density,
  import/append overhead, concurrent preparation, and multiple read generations
  before claiming an end-to-end benefit or changing capacity guidance. Any further
  representation/sharing optimization must remain owner-bounded and preserve
  accounting, rollback, and the existing lexical policy; do not add global interning.

- [ ] **PERF-06: Validate duplicate-aware term collectors on realistic workloads.**
  The isolated `benchmarks\LLMContextLib.TokenizationBenchmarks` experiment shows
  large Lucene allocation savings on repeated words but regressions on distinct
  words and incremental long-word buffers. Retained output does not shrink.
  Optional lexically compatible factory adapters now exist, without default promotion.
  The integrated strategy benchmark now includes full mutations, exact searches,
  allocation and retention: savings still depend on lexical density, rather than
  establishing a universal Lucene win. Extend realistic density mixes, package/
  runtime overhead and input bounds before production promotion. Do not silently adopt
  StandardAnalyzer semantics or treat this as a full Lucene backend evaluation.

- [ ] **PERF-07: Evaluate owner-scoped memoization with explicit byte admission.**
  The isolated BitFaster experiment improves whole-text cache hits but adds miss
  overhead and retains complete text keys. LRU was preferable to foreground LFU
  in the measured traces; default asynchronous LFU was not evaluated. Measure
  realistic reuse, unchanged-payload fast paths, full operations, and cross-entry
  term sharing. The optional LRU adapter now has fixed owner reservations,
  per-entry allowances, serialized insertion, disposal and independently charged
  escaped arrays. Integrated full-operation/retention evidence now shows the
  default per-entry allowance bypassing 513-term values and a 4 MiB reservation
  enabling reuse at the cost of retaining deleted text. Extend host-scale peak
  and tail evidence; capacity alone is not a byte budget.

- [ ] **PERF-08: Evaluate deferred indexing under real writer/query pressure.**
  Opt-in bounded prefix tokenization, reserved full completion, exact fallback and
  indexed-only coverage are implemented; synchronous indexing remains the default.
  The integrated paced-load experiment records completion lag, exact fallback
  tails and admission outcomes. Extend duration/offered-load sweeps, real host
  traffic and shutdown pressure before promotion. Old-posting removal remains synchronous,
  and background postings publication still holds the session writer gate. Consider
  chunked/optimistic publication only with explicit snapshot, reservation and strict
  content-conflict invariants. See `docs\deferred-indexing.md`.

- [ ] **PERF-09: Define adaptation from integrated objectives.** The owner now
  composes pinned native/Lucene collectors, optional bounded BitFaster LRU,
  preparation scheduling and a deterministic append-aware index router. The
  twelve-policy matched study in
  `benchmarks\LLMContextLib.StrategyBenchmarks\README.md` records source/binary
  fingerprints, cold/hot reuse, full completion, retained heap, admission outcomes
  and p50/p95/p99 latency. It does not establish a universally superior default.
  Next evaluate sustained host traffic, rate sweeps, memo eligibility/reuse and
  foreground-versus-completion/search objectives, including the cost of full
  postings on memo hits and Lucene's full deferred recollection. Do not introduce automatic switching
  or backend migration without measured objectives, bounded observations, switching
  costs and hysteresis. See `docs\execution-strategies.md`.

- [ ] **PERF-10: Extend producer-owned indexing measurements.** Opt-in opaque keys
  now bypass NLP/key generation in writes, while shared postings updates still
  execute during Apply. The matched producer diagnostic separately measures
  preparation, Apply and the combined pipeline; unique cold preparation can erase
  hot-path gains. Evaluate representative producer algorithms, prepared-command
  retention, batching and sustained offered-load/admission pressure before claiming
  capacity or promoting a default. Keep session conflicts strict and never
  normalize/recompute producer-owned keys implicitly.

## Release readiness

- [ ] **REL-01: Define an intentional versioning and compatibility policy.** Choose
  release criteria, API-change policy, package metadata/versioning, and any future
  format migrations before publishing a versioned release. SDK-generated assembly
  or package defaults are not release commitments. Keep the experimental notice
  until those decisions and readiness work are actually complete.

- [ ] **REL-02: Establish reproducible release gates.** Define the required SDK/
  runtime matrix, build/format/XML-documentation checks, correctness/oracle runs,
  resource-pressure tests, and source-attributed evidence. Add automated gates
  appropriate to the eventual repository host. Tests and historical benchmarks
  alone do not establish production readiness or a capacity/SLA guarantee.

## Constraints that remain in force

Preserve one owning client, canonical identities, atomic immutable session roots,
strict expected revisions, independent session/memory captures, and issued
read/view survival. Persistence/distributed storage, model execution, agent
scheduling, and exactly-once external tools are not silently added to the scope by
this backlog. Do not start optimization with pooling published immutable graphs
or GC tuning; establish the actual allocation cause first.
