# One owner, composed execution strategies

This is an experimental, opt-in execution layer over the existing segmented
realization. It is not a new storage owner or an automatic performance predictor.
Omitting all strategy methods preserves the original factory path and defaults.
`WithProducerOwnedIndexing()` is a separate opt-in mode: supplied opaque keys
bypass term collection, memoization and deferred routing entirely. It rejects
Lucene/BitFaster and deferred text settings rather than silently mixing policies.
Speculative/serialized preparation remains selectable. See
[Producer-owned indexing](usage-documentation.md#producer-owned-indexing) for
prepared entry/anchor contributions and `SearchKeys`.

## Configure through the factory

Reference `src\LLMContextLib\LLMContextLib.csproj` from the host. Add
`src\LLMContextLib.Lucene\LLMContextLib.Lucene.csproj` and/or
`src\LLMContextLib.BitFaster\LLMContextLib.BitFaster.csproj` only for the corresponding
extensions. These are local projects, not published packages. All extensions use
namespace `LLMContextLib`; no provider/storage instances escape initialization.

```csharp
using LLMContextLib;

var recipe = LLMContextFactory.Create(new LLMContextOptions
{
    DeferredIndexing = new DeferredIndexingOptions
    {
        ForegroundWords = 128,
        ForegroundCharacters = 8192,
        MaximumPendingEntries = 64,
        MaximumEstimatedWorkBytes = 8 * 1024 * 1024
    }
})
.WithExecutionStrategies(new ContextExecutionOptions
{
    Indexing = ContextIndexingStrategy.AppendOptimized,
    MinimumDeferredCharacters = 8192,
    Preparation = ContextPreparationStrategy.Speculative
})
.WithLuceneTermCollection(LuceneTermCollection.RangeBuffer)
.WithBitFasterTermMemoization(new BitFasterTermMemoOptions
{
    Capacity = 64,
    MaximumTextCharacters = 8192,
    MaximumEstimatedBytes = 1024 * 1024
});

using var contexts = recipe.Initialize([]); // Or validated application sessions.
Console.WriteLine(contexts.GetStatistics().Execution);
```

Each method returns a new recipe; the original recipe and existing owners are
unchanged. Every `Initialize` creates independent execution state, memo and worker.
Extension order does not change independent dimensions; the last selection of the
same dimension wins. To pin another comparison from the same recipe:

```csharp
var nativeSynchronous = recipe
    .WithNativeTermCollection()
    .WithoutTermMemoization()
    .WithExecutionStrategies(new ContextExecutionOptions
    {
        Indexing = ContextIndexingStrategy.Synchronous,
        Preparation = ContextPreparationStrategy.Speculative
    });
```

This still has the small execution coordinator. For the uninstrumented original
path, use `LLMContextFactory.Create(options)` without strategy methods.

## What executes

```text
One ILLMContextPolymorphicArray
  -> owner lifetime fence
  -> preparation scheduling
  -> eligible exact-text memo lookup
  -> full collection OR bounded native prefix + reserved completion
  -> retained-term diff / postings preparation
  -> existing revision check + resource admission + atomic root publication
```

| Dimension | Choices | Selection |
|---|---|---|
| Full-term collector | Native, Lucene RangeBuffer, Lucene CharTerm | Pinned at initialization |
| Incoming entry-term reuse | None, owner-private BitFaster ConcurrentLru | Eligible exact-text lookups; oversized input/value bypasses |
| Entry index maintenance | Configured, Synchronous, AppendOptimized | Per changed entry, after memo lookup |
| Writer preparation | Configured, Speculative, Serialized | Pinned; serialization remains experimental |
| Exact search | Matching postings plus pending-entry fallback | Fixed semantic behavior, never an implicit partial query |

`Configured` preserves the old indexing/preparation options for uncached work.
Without `DeferredIndexing`, indexing is synchronous. With it, bounded prefixes can
publish pending coverage. A memo hit always supplies complete terms.

`Synchronous` fully indexes entries and does not start/charge a deferred worker,
even if deferred limits were supplied. `AppendOptimized` requires those limits:
it considers deferral only for **new** entries at/above the formatted-character
threshold. Imports and new IDs in segment replacements also count as new entries.
Corrections, including corrections of pending entries, use complete terms and the
existing incremental posting diff. Small new entries also complete synchronously.

Before deferring, the router checks observed owner backlog, work-byte capacity,
and resident headroom. It chooses synchronous work when those checks fail.
These observations are not reservations: concurrent operations, multiple entries
in one batch, prefix/payload costs and final root admission can still reject the
whole write. There is no automatic replay or silent expected-revision retry.

Lucene collectors preserve the UTF-16 `char.IsLetterOrDigit`, per-char invariant
lowercase, ordinal distinct/sorted immutable-array contract. They do not install
StandardAnalyzer, stemming, language rules, or a Lucene search backend. Anchors use
the selected collector synchronously; anchor text and queries are not memoized.
Queries and pending-entry exact fallback remain native, so old reads need no
live execution provider after owner disposal.

Bounded prefixes always use the native segmented scanner, avoiding full large
tool-payload formatting before the bound. Native background completion resumes
the prefix; selected Lucene collectors currently recollect the whole content.
That duplicate prefix work and any full tool formatting are costs to measure,
not an assumed improvement. Only complete results enter the memo.

## Resource and lifetime accounting

Any composed owner reserves 512 estimated bytes for execution infrastructure.
BitFaster additionally reserves its **entire** `MaximumEstimatedBytes` from the
resident budget at construction, even while empty. Deferred infrastructure is
additional when enabled. The combined reservation must fit before initialization.
All these reservations are already included in `EstimatedActiveBytes`; do not
add them again when inspecting total residency.

For memo capacity `C` and reserved estimate `B`:

```text
slots = C + 1
infrastructure = 4096 + 512 * slots
per-entry allowance = floor((B - infrastructure) / slots)
entry payload estimate = 32 + 2 * key.Length
                       + 128 + 8 * terms.Length
                       + sum(32 + 2 * term.Length)
```

Capacity must be at least three, and each allowance at least 160 bytes. An input
above `MaximumTextCharacters` skips lookup and admission. A computed key/value
above the per-entry allowance is not retained. The extra slot covers one insertion
before eviction; insertions are serialized by a private memo gate, while token
collection remains outside it and hits do not acquire it. Concurrent misses can
compute the same value independently. Only the LRU provider is integrated; LFU
remains an isolated experiment.

These are conservative **estimates**, not measured object sizes, peak-heap caps
or transient-allocation limits. Fixed allowances deliberately sacrifice byte
utilization for simple bounded admission. Cold inputs still pay lookup/accounting
cost; repeated input is not guaranteed. Callers must still bound intake and
concurrent preparation.

Retained entry terms and captured roots remain independently charged in full,
including arrays shared with the memo. Eviction removes only memo ownership:
it never invalidates a published term array. Rejected/conflicting preparation can
warm this separately reserved memo, but cannot publish content, postings or jobs.
It is a disposable optimization, not a catalog of accepted entries.

Owner disposal drains public operations, cancels/joins deferred work, then clears
and drops the memo provider. Failed initialization follows the same cleanup.
Captured reads/views retain immutable state, not the collector/cache, and remain
usable afterward. No global cache or independently disposed client is introduced.

## Attribution and validation

`GetStatistics().Execution` is null on the original factory path. Composed owners
report selected providers, effective preparation mode, fixed reservation, live memo
memberships, collections, hits/misses/bypasses, synchronous/deferred entry attempts,
capacity fallbacks and preparation selections. Counters include rejected,
conflicting and background attempts; they are not successful-publication counts,
per-session history, request latency measurements, or a transactional snapshot.

The focused checks run with the normal solution toolchain:

```powershell
dotnet test tests\LLMContextLib.Tests\LLMContextLib.Tests.csproj -c Release --filter "FullyQualifiedName~ExecutionStrategyTests|FullyQualifiedName~GatePolicyAvoidsDiscardedPreparation"
```

The oracle matrix covers three full-term collectors, memo on/off and all three
index routers: **18 compositions across seven existing traces per runtime**.
Additional cases cover UTF-16 parity, concurrent collection/eviction, strict writer
races, pending corrections, backlog fallback, memo-hit completion, admission
rollback, combined reservations, initialization cleanup and actual key collection
with a disposed owner and a surviving read.

The optional projects pin the same direct package versions as the experiments:
Lucene.Net.Analysis.Common 4.8.0-beta00018 and BitFaster.Caching 2.6.1, with checked-in
dependency lock files. Core and default example/benchmark projects still have no
Lucene or BitFaster dependency. The test project references both optional adapters.

The integrated experiment in
`benchmarks\LLMContextLib.StrategyBenchmarks\README.md` compares twelve policies
with adjacent native controls, reversed process order, exact-output checks,
caller/process allocation, actual managed retention and paced writer/search load.
It measures these adapters and their memo coordination/accounting, not just
historical standalone tokenizers or caches. Its bounded fixtures and short loads
are diagnostics, not a capacity/SLA certification or exhaustive policy search.

There is **no universal winning composition**, no live collector/backend
migration, and no automatic adaptation or hysteresis controller. The memo's
per-entry byte allowance can prevent reuse despite spare slots. Cache hits supply
complete terms and therefore also bring full postings preparation into the
foreground; a larger memo need not minimize Apply latency. Deferral moves work,
can contend with writers at publication, and can increase exact-search fallback
cost. Configuration must follow the host's acceptance, completion, search and
memory objectives rather than foreground latency alone. Defaults remain unchanged.
