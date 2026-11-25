# Architecture and supported contracts

This port is experimental. It carries the pinned library's context contracts,
not a generic collection engine, persistence backend, or agent framework.

## One owner, immutable publications

```text
Application / explicit worker peers
                |
      ILLMContextPolymorphicArray
                |
        private owning bridge
                |
    immutable session and memory roots
```

Create the client with `LLMContextFactory.Create(options).Initialize(sessions)`.
There is no public storage constructor or writable top-level session array.
The owner validates the entire imported graph; failed initialization cleans up
before any usable client escapes. Builders can be reused, but each initialization
owns fresh mutable execution state.

A session publication atomically includes entries, locations, ordered segments,
anchors, and matching index coverage. Stable canonical GUIDs identify objects;
tombstones prevent reuse of deleted identities. Session writes require the exact
expected revision. Multi-change transactions publish together or fail together.
Replacement-only coalescing does not silently extend to append/mixed transactions.

Memory has its own catalog revision and publication boundary. A read captures
the session root and memory root independently: coherent captured revisions,
not a cross-catalog transaction. Equal-ID independently constructed memory
scopes match; storage change detection still uses the required backing identity.

## Reads and views

`WithCurrent(sessionId, callback)` lazily captures once at first use and releases
on every exit. An unused callback captures nothing. The borrowed handle must not
escape or be used asynchronously. Use `OpenRead` for an explicit snapshot.
Explicit reads and materialized views survive later writes, session removal,
and owner disposal; their own `dispose()` ends access and releases charges.

`ReadRange(fromSequence, count)` and revision-bound `ReadPage(cursor, count)`
limit entry counts. A cursor is not transferable to a different session/revision.
Neither operation applies a token budget.

| View recipe    | Selection                                    |
| -------------- | -------------------------------------------- |
| `Timeline`     | Sequence range                               |
| `Conversation` | User/assistant text                          |
| `Tool`         | Matching tool call and result ID             |
| `Navigation`   | Anchor resolutions                           |
| `Search`       | Exact text search                            |
| `SearchKeys`   | Exact producer labels                        |
| `Memory`       | Explicit requested scopes, expiry and policy |
| `Model`        | Caller-constrained model-input selection     |
| `Project`      | Caller predicate and projection              |

Views retain their captured roots and account for materialized output.
Owner-local projection estimation receives the actual materialized item, not a
stand-in or clone. Release the view even if you also retain its returned values.
See [configuration](configuration.md) for limits and callback rules.

## Search and maintenance

Ordinary factory defaults use **Text** mode and canonical UTF-16 lexical terms.
Optional deferred indexing publishes explicit partial coverage. Exact `Search`
scans pending entries; `SearchIndexed` instead exposes indexed coverage.
`WaitForIndexingAsync` waits for the requested content revision's derived work.
Derived progress never refreshes an older capture or changes content revisions.

**ProducerOwned** mode requires explicit complete keys on entries and anchors,
including imports and replacements. Keys are opaque: deduplicated and ordinally
ordered, but never inferred, normalized as language, or compared with content.
Use `SearchKeys`; text-query APIs fail explicitly. WriteOptimized additionally
uses bounded partitioned working sets without caller-built partitions.
Whole-contribution overrides shadow base keys before query ordering/limits.

`SynchronizeIndexAsync` rebuilds partition indexes while reads continue.
Its session-wide fence prevents an earlier speculative candidate from publishing
across maintenance. Completion reopens write admission; failure retains
authoritative overrides and permits recovery. Caller cancellation stops waiting,
not shared partition maintenance. Content revision remains unchanged.

## Token budgets belong to the context request

`ContextViews.Model(sessionId, tokenBudget, estimateTokens, scopes?, limit?)`
and public `BuildModelContext(entries, memory, tokenBudget, estimateTokens,
maximumItems?)` honor a supplied selection constraint. Budgets and estimated
token costs are nonnegative Int32 values.

Selection considers fitting system entries, requested memory, a fitting summary,
and recent eligible transcript groups; tool call/result pairs remain whole.
The caller owns the budget, tokenizer/estimator, model limits, framing costs,
and changes to that context property. The library provides no `ITokenBudget`
manager, automatic allocator, model tokenizer, inference, or storage pruning.
Search term collection is not model-token estimation.

## Resources and runtime representation

Admission accounts for active roots, retained captures, view output, preparation,
maintenance, and optional memo reservations. These are conservative estimates,
not hard heap/RSS caps. Readers do not acquire a session writer gate; publication,
memory, and resource admission have distinct synchronization boundaries.
Synchronous admission remains synchronous and has no cancellation token.

Public signed Int64 values use safe integer `number` or `bigint` without lossy
coercion. Int32 count/token limits remain numbers. GUIDs are canonical dashed
strings returned lowercase. Offset ISO timestamps support seven fractional
digits and 100 ns comparison; numeric clocks accept epoch milliseconds.
Explicit record helpers preserve supported typed operations, not JavaScript
operator replacement or CLR hash identity.

See [public exports](src/index.ts), [parity](parity.md), and
[worker integration](worker-integration.md) for the runtime-specific boundaries.
