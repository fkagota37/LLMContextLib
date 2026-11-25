# Configuration and resource lifecycle

Experimental limits are context-storage accounting policies, not production
capacity promises. Start with unchanged WriteOptimized; tune only against your
own workload and measured rejection/retention behavior.

## Defaults are not the preset

`LLMContextFactory.Create()` uses ordinary Text defaults.
`LLMContextFactory.Create(LLMContextOptions.WriteOptimized)` explicitly selects
producer-owned partitioned indexing. Both keep speculative preparation by default.

| Option                            | Ordinary default | WriteOptimized             |
| --------------------------------- | ---------------- | -------------------------- |
| Indexing                          | Text, eager      | ProducerOwned, partitioned |
| `MaximumEntriesPerSegment`        | 128              | 8                          |
| `MaximumEstimatedBytesPerSegment` | 256 KiB          | 32 KiB                     |
| `EstimatedResidentByteBudget`     | 64 MiB           | 512 MiB                    |
| `MaximumEstimatedRetainedBytes`   | 64 MiB           | 256 MiB                    |
| `MaximumRetainedReads`            | 128              | 2048                       |
| `MaximumViewResults`              | 4096             | 4096                       |
| `AdmissionTimeoutMs`              | 0                | 5                          |
| Deferred text indexing            | Disabled         | Disabled/incompatible      |

KiB and MiB are powers of 1024. The WriteOptimized partition bounds are 8 MiB
per partition, 64 working-set entries, 4 MiB working-set bytes, 32 pending
synchronizations, and 8 MiB preparation bytes. Its write behavior during
synchronization is `Reject`, with a 1000 ms synchronization wait timeout.
These limits include independently reserved construction/recovery headroom.
Exact definitions are in [options](src/options.ts) and
[partition options](src/storage/partitioned-index.ts).

## Copy before customizing

Factory creation validates and captures options. Object spread supplies the
supported options-copy idiom; do not mutate the frozen presets. For example:

```javascript
import {
  LLMContextFactory,
  LLMContextOptions,
} from "llmcontextlib-port-typescript";

const options = { ...LLMContextOptions.WriteOptimized, AdmissionTimeoutMs: 10 };
const owner = LLMContextFactory.Create(options).Initialize([]);
try {
  console.log(owner.GetStatistics().Sessions);
} finally {
  owner.dispose();
}
```

A nested override must include the nested configuration's required fields.
Byte limits/estimators accept checked positive signed Int64 values; count limits
are positive Int32 values. Timeout and mode validation is explicit. Invalid
configurations fail rather than silently widening limits or changing modes.

To use deferred **text** indexing, start from ordinary defaults:

```javascript
import {
  defaultDeferredIndexingOptions,
  LLMContextFactory,
} from "llmcontextlib-port-typescript";

const owner = LLMContextFactory.Create({
  DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundWords: 64 },
}).Initialize([]);
owner.dispose();
```

Producer-owned indexing cannot combine with deferred text collection or
collector/memo strategies. Use explicit `WithProducerOwnedIndexing()` or
`WithPartitionedIndexing()` when building those modes without the preset.
`WithExecutionStrategies` replaces a recipe from its strategy defaults; omitted
fields reset rather than inheriting the previous recipe. Serialized preparation
is an explicit experimental choice, never automatically selected or promoted.

## Callbacks and release

`EntrySizeEstimator`, `ProjectionSizeEstimator`, and `TimeProvider.now` must be
stable and non-reentrant. Owner-local projection estimation receives the actual
materialized item. Estimator exceptions/invalid estimates reject the operation
and release temporary captures/reservations. The worker-local alternative is
explicitly opt-in; see [workers](worker-integration.md).

Read `GetStatistics()` before disposal. Distinguish `EstimatedActiveBytes`,
`EstimatedRetainedBytes`, `EstimatedViewBytes`, preparation/index/synchronization
reserves, retained-read counts, and execution/memo attribution. Do not sum
overlapping categories as though they were independently measured heap bytes.
Escaped caller-owned graphs and process/V8 overhead are not hard-capped.

Release explicit reads and views promptly; drain worker callers before disposing
the owner. Disposal quiesces native/maintained maintenance before memo teardown.
An old capture remains usable until its own disposal. Failed initialization and
rejected writes must not leave a usable partial owner or leaked reservations.

Handle mutation terminal statuses, including revision conflicts and admission or
synchronization rejection. Do not rely on automatic retry/rebase or increase
budgets to conceal a leak. Token constraints are supplied separately to model
assembly as caller-owned context properties, not configured as a storage budget.
