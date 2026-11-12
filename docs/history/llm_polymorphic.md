# LLM context polymorphic array

## 1. Purpose and status

This document defines the `LLMContextPolymorphicArray` scope and its
`LLMSessionContext` proof-of-concept model. The first in-memory realization and
independent benchmark suite are now implemented in the projects listed in
section 13. Sections 14-15 account for actual hot paths, limitations, and
verification; broader persistence/distributed capabilities remain out of scope.

The primary goal is one authoritative in-memory context exposed through
customized views. Concurrent point and segmented access, ownership, indexing,
and bounded memory management support that goal; raw read/write throughput is
not the definition of polymorphism.

`LLMSessionContext[]` denotes a logical collection of session instances. Each
element represents one session, not one message. Consumers receive an owning
interface, not the writable backing array.

The initial scope includes:

- Session creation, append, point replacement/deletion, and bounded segment
  reads/writes.
- Concurrent readers and writers with explicit publication and conflict rules.
- Timeline, model-context, navigation, search, and applicable-memory views.
- Contextual bookmarks independent of UI coordinates and physical positions.
- Explicit session, repository, user, and combined memory scopes.
- Versioned reads, retention budgets, and safe retirement of old data.

Persistence is an optional later capability. This is not a model runtime, a
replacement for a model's KV cache, or an exactly-once tool-execution system.

## 2. Client, bridge, and realization

The existing `IPolymorphicArray<T,TKey>` in
`src\ScalablePolymorphicArray\Contracts.cs` provides `TryFind` and disposal.
Preserve that contract. The proposed specialized client extends it rather than
adding LLM-specific operations to every existing collection.

```text
Application / LLM UX
    |
    | ILLMContextPolymorphicArray
    | also IPolymorphicArray<LLMSessionContext, Guid>
    v
LLMContextPolymorphicArray                 internal owning bridge
    | session operations, view definitions, scope validation
    | stable identity resolution, mutation validation
    v
ILLMContextStorage                       owner-private interface
    |
    v
Segmented in-memory realization          initial implementation target
    | immutable published roots and bounded segments
    | matching lookup/search indexes and lifetime management
    v
Optional persistence adapter             later, explicitly selected
```

The bridge translates domain operations into realization operations and
projects realization results into consumer views. It does not maintain a
second authoritative transcript or leak the concrete storage type.

There is one owning client instance. Factory extensions configure construction;
callers do not initialize and manage both the bridge and its underlying storage.
Disposing the client closes admission, drains active operations, and disposes
owner-private resources. Already issued read leases follow their explicit
lifetime contract.

Implemented public surface:

```csharp
public interface ILLMContextPolymorphicArray
    : IPolymorphicArray<LLMSessionContext, Guid>
{
    ILLMContextReadLease OpenRead(Guid sessionId);
    IContextMutationResult CreateSession(LLMSessionContext session);
    IContextMutationResult RemoveSession(Guid sessionId, long expectedRevision);
    IContextMutationResult Apply(ContextChangeSet changes);
    IContextMutationResult ApplyMemory(MemoryChangeSet changes);
    ILLMContextView<TView> OpenView<TView>(
        ILLMContextViewDefinition<TView> definition);
    LLMContextStatistics GetStatistics();
}
```

Domain change sets are immutable records; results, read leases, views and the
client are interface-returned. Their semantics are defined below. Concrete
bridge and storage realization types remain internal.

## 3. Sample session type

The C# model below uses immutable collection types to express ownership and
structural sharing. The library definitions live in namespace
`ScalablePolymorphicArray.Llm`; use those definitions rather than redeclaring
them when calling the factory. These types alone do not provide the publication
protocol or performance guarantees.

```csharp
using System;
using System.Collections.Immutable;

public sealed record LLMSessionContext(
    Guid SessionId,
    Guid UserId,
    Guid? RepositoryId,
    long Revision,
    SessionStatus Status,
    ImmutableSortedDictionary<long, ContextSegment> Segments,
    ImmutableDictionary<Guid, ConversationAnchor> Anchors);

public sealed record ContextSegment(
    long SegmentId,
    long Revision,
    ImmutableArray<ContextEntry> Entries);

public sealed record ContextEntry(
    Guid EntryId,
    long Sequence,
    ContextRole Role,
    DateTimeOffset CreatedAt,
    ContextContent Content);

public abstract record ContextContent;

public sealed record TextContent(string Text) : ContextContent;

public sealed record ToolCallContent(
    string CallId,
    string ToolName,
    string ArgumentsJson) : ContextContent;

public sealed record ToolResultContent(
    string CallId,
    string ResultJson,
    bool IsError) : ContextContent;

public sealed record SummaryContent(
    string Text,
    long ThroughSequence) : ContextContent;

public sealed record ConversationAnchor(
    Guid AnchorId,
    Guid StartEntryId,
    Guid EndEntryId,
    string Title,
    string Summary,
    ImmutableArray<string> Topics,
    AnchorKind Kind,
    long SourceRevision,
    long? PinnedRevision);

public enum ContextRole { System, User, Assistant, Tool, Internal }
public enum SessionStatus { Active, Suspended, Closed, Expired }
public enum AnchorKind { Manual, Topic, Decision, Question, Artifact }
```

### Identity and ownership invariants

| Identity | Meaning |
| --- | --- |
| `SessionId` | Stable session identity, independent of collection position |
| `EntryId` | Stable point-operation and navigation address within a session |
| `Sequence` | Owner-assigned conversation ordering; deletion may leave gaps |
| `SegmentId` | Owner-assigned storage-group identity, not a view or message ordinal |
| Session `Revision` | Monotonic published session version and write-conflict token |
| Segment `Revision` | Last session revision that changed that segment |
| `AnchorId` | Bookmark identity; its target uses entry IDs, not filtered offsets |

Replacing an entry preserves its identity and sequence. Appending allocates
new identities and sequences under the owner's mutation protocol. A segment's
contents remain sequence-ordered; insertion into old sequence positions and
renumbering historical entries are outside the initial scope.

Every object reachable from a published session must be immutable. A `record`
keyword does not make arbitrary referenced graphs deeply immutable. The PoC
admits only the listed content cases, immutable strings, and validated
immutable collections; the factory/mutation boundary must reject unsupported
content subclasses rather than assume any `ContextContent` is safe.

Default/uninitialized immutable collections, duplicate IDs, invalid revisions,
misordered sequences, and anchors outside the session must be rejected.
Imported collections are normalized into owner-approved structures without
retaining writable construction aliases. Callers must keep inputs stable
during admission.

Lookup indexes are owner-private and published with their matching session
root. The sample does not expose a mutable `EntryId -> location` dictionary.
Future large attachments should use immutable artifact references rather than
introduce arbitrary mutable buffers into this graph.

### A sample session instance

```csharp
var sessionId = Guid.NewGuid();
var userId = Guid.NewGuid();
var repositoryId = Guid.NewGuid();
var questionId = Guid.NewGuid();
var answerId = Guid.NewGuid();
var anchorId = Guid.NewGuid();
var createdAt = new DateTimeOffset(2026, 11, 10, 17, 0, 0, TimeSpan.Zero);

var segment = new ContextSegment(
    SegmentId: 0,
    Revision: 1,
    Entries: ImmutableArray.Create(
        new ContextEntry(
            questionId, 0, ContextRole.User, createdAt,
            new TextContent("How should this repository manage session memory?")),
        new ContextEntry(
            answerId, 1, ContextRole.Assistant, createdAt.AddSeconds(1),
            new TextContent(
                "Keep repository guidance separate from session working context."))));

var anchor = new ConversationAnchor(
    AnchorId: anchorId,
    StartEntryId: questionId,
    EndEntryId: answerId,
    Title: "Repository versus session memory",
    Summary: "Discussion of explicit memory applicability.",
    Topics: ImmutableArray.Create("memory", "repository", "session"),
    Kind: AnchorKind.Topic,
    SourceRevision: 1,
    PinnedRevision: null);

var sample = new LLMSessionContext(
    SessionId: sessionId,
    UserId: userId,
    RepositoryId: repositoryId,
    Revision: 1,
    Status: SessionStatus.Active,
    Segments: ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, segment),
    Anchors: ImmutableDictionary<Guid, ConversationAnchor>.Empty.Add(anchorId, anchor));

LLMSessionContext[] initialSessions = [sample];
```

This is a topic bookmark, not an automatically accepted repository memory or
decision. An initializer's collection is construction input only; the owning
client must not expose or retain its writable array as live structural storage.

## 4. Factory-based initialization

Implemented factory usage (with the preceding sample instance):

```csharp
using ILLMContextPolymorphicArray contexts =
    PolymorphicArrayFactory.For<LLMSessionContext, Guid>(s => s.SessionId)
        .WithLLMContext(new LLMContextOptions
        {
            MaximumEntriesPerSegment = 128,
            MaximumEstimatedBytesPerSegment = 256 * 1024,
            EstimatedResidentByteBudget = 64 * 1024 * 1024
        })
        .Initialize(initialSessions);

IPolymorphicArray<LLMSessionContext, Guid> lookup = contexts;
bool found = lookup.TryFind(sessionId, out LLMSessionContext current);
```

`WithLLMContext` is a terminal selection returning an LLM-specific
builder whose `Initialize` returns the specialized interface. It is not a flag
silently changing the meaning of the existing positional/keyed factories.

The numbers above are illustrative, not tuned defaults. Final options also
need explicit entry-size estimation, retained-view limits, and admission
timeout/backpressure settings. Estimated byte budgets are not exact CLR working
set limits. Oversized entries are rejected in the PoC, not silently allowed to
defeat segment bounds.

`TryFind` returns one immutable published session root. It does not promise a
deep materialized copy, flatten its segments, or include applicable memory from
another catalog. Retaining such a root can retain its graph; the owner cannot
force reclamation while application code still references it.

## 5. Storage and concurrent access

The physical session table must support growth and point replacement without
cloning a flat array containing every session. The initial realization should
use a segmented or structurally shared directory. A literal exposed CLR array
cannot itself supply these lifecycle guarantees.

Within each session:

1. A published root identifies the immutable segment directory, anchor map, and
   matching lookup/search index generation.
2. A reader captures that root once, then resolves point/segment/view operations
   against that revision.
3. Writers prepare bounded replacements against an expected session revision.
4. A short per-session publication gate validates that revision and commits the
   new root plus index changes. Conflicts return an explicit result; no
   accidental last-writer-wins replacement of a stale whole session.
5. Unchanged segments are shared. Retired segments remain valid while referenced
   by old roots/read leases.

Different sessions have independent mutation admission/publication. Preparation
for different segments can overlap, but commits to one session are ordered.
The design does not promise lock-free writers or cross-session transactions.

| Capability | Required implementation behavior |
| --- | --- |
| Session point read | Stable session-ID lookup, without scanning all sessions |
| Entry point read | Session-private entry-ID lookup into a captured segment |
| Entry point write | Replace only the affected bounded segment plus directory/index paths |
| Segment read | Lease a bounded segment/range without flattening the full conversation |
| Segment write | Atomically publish replacement segments and matching metadata/indexes |
| Append | Extend the tail within bounds or allocate a new segment |
| Point deletion | Remove the entry in a new revision without invalidating old readers |
| Multi-entry change | Validate all changes first; publish one session revision or none |
| Session creation/removal | Change the session directory without rebuilding unrelated session payloads |

`ContextChangeSet` addresses canonical session/entry/segment IDs and carries
an expected session revision. It groups operations with one per-session commit
boundary. Its result distinguishes applied, revision conflict, invalid
operation, and admission/resource failure. The existing overlay's
`MutationVersion` winner ordering is not equivalent to this expected-revision
contract.

Closed sessions are read-only until explicitly reopened; expired sessions deny
new ordinary views and enter retirement. In-flight stable reads retain their
captured revision. Session removal is explicit, not a side effect of filtering
it out of a view.

## 6. Customized views

A view is a selection/projection over authoritative context, not a separately
maintained transcript. Its definition specifies source session IDs, predicates,
output shape, ordering, consistency mode, and limits. Model views additionally
need an explicit token estimator and context-assembly policy.

| View | Output and policy |
| --- | --- |
| Timeline | Ordered conversation entries with paging/cursors |
| Model context | Selected instructions, applicable memory, summaries, and recent/relevant exchanges |
| Conversation | User-facing messages without internal execution detail |
| Tool execution | The selected call and explicitly selected supporting context |
| Navigation | Topic/decision/question/artifact anchors and their source ranges |
| Search | Matching snippets, stable source addresses, and revision metadata |
| Applicable memory | Confirmed, unexpired memories matching the requested scope conditions |

Stable views retain a read lease for a captured revision. Live views may advance
between evaluations, but each evaluation is internally consistent. Page cursors
must carry the source revision; stale cursors cannot silently mix generations.
The initial scope is session-local search/navigation; cross-session search can
later aggregate explicitly identified sources without implying a global snapshot.

Filtered/projected positions are never mutation addresses. A selected result
retains its canonical source identity, or it is explicitly non-writable.
Transformations can allocate output; "view" does not mean every projection is
zero-copy or constant-time.

The generic layer supplies coherent selection and lifetime primitives.
Domain policies preserve necessary tool-call/result relationships and choose
which context fits a token budget. The PoC does not claim that storage layout
alone improves model relevance or inference cost.

## 7. Contextual bookmarks, navigation, and search

A bookmark answers "where did this happen?" A snapshot answers "what did the
state contain at that revision?" They must not be conflated.

- Unpinned anchors resolve stable entry IDs against the selected current read
  revision. `SourceRevision` records where the label/summary originated; it does
  not assert that a later-edited passage still supports that summary.
- `PinnedRevision` requests an exact historical target only when retained
  history is available. The initial in-memory PoC may report history unavailable;
  storing an old revision number alone does not preserve that revision.
- Entry deletion or unavailable history produces an explicit missing/partial
  target result. Never redirect a bookmark to the entry now occupying an old
  physical position.
- A bookmark does not automatically pin all session payloads in RAM. Exact
  historical retention is an explicit budgeted request.

The initial search index covers entry text and anchor titles/topics, with
deterministic keyword search. Store canonical entry IDs in postings, not UI
offsets. Index changes publish with the matching session root; asynchronous
semantic indexing, if added later, must expose its indexed revision.

Manual anchors and deterministic indexing require no model call. Generated
topic labels/summaries may be admitted as proposals, but must not silently
become confirmed decisions or memories.

## 8. Scoped memory

Conversation content is evidence; an extracted memory is a separately managed
claim with applicability, provenance, and lifecycle.

Repository memories must be reusable across sessions without copying an
authoritative version into each session. The same owning client therefore
manages a separate memory catalog and joins applicable records into requested
views.

Illustrative additional domain records:

```csharp
public sealed record MemoryScope(
    Guid? UserId,
    Guid? RepositoryId,
    Guid? SessionId);

public sealed record MemorySource(Guid SessionId, Guid AnchorId);

public sealed record ContextMemory(
    Guid MemoryId,
    MemoryScope Scope,
    string Content,
    long Revision,
    MemoryStatus Status,
    DateTimeOffset? ExpiresAt,
    ImmutableArray<MemorySource> Sources);

public enum MemoryStatus { Proposed, Confirmed, Superseded, Retracted }
```

| Scope condition | Example applicability |
| --- | --- |
| User ID only | A confirmed preference across that user's contexts |
| Repository ID only | Confirmed repository-wide guidance |
| Session ID only | A working constraint for one session, including after reopening |
| User ID plus repository ID | That user's workflow within that repository |

Populated scope fields are conjunctive conditions, not alternatives. An empty
scope is rejected in the PoC; session/repository/user combinations must be
validated against the source context. Repository identity is a stable domain
identifier, not just a local folder spelling.

Applicability is not authorization: a scope match does not grant another
consumer permission to read the record. The embedding application's access
policy remains a separate input to view construction.

The memory view explicitly requests eligible scopes. There is no implicit
rule that all user memory applies everywhere, or that session/repository/user
scope establishes authority precedence. Conflicts remain visible unless a
domain policy resolves them.

Promotion from proposed session evidence to confirmed repository/user memory
is explicit and preserves source anchors. Scope, retention, ownership, and
confirmation are separate dimensions. Expiry/retraction affects new views;
already retained snapshots remain historical observations.

`ApplyMemory` validates an expected memory-catalog revision and publishes the
record plus scope indexes together. A context view combining a session and
memory captures and reports both revisions. This revision pair is not a
cross-catalog atomic snapshot; a caller needing a newly changed memory waits
for or requests the required catalog revision.

## 9. Memory lifecycle and retention

The owner accounts separately for active segments, lookup/search indexes,
retained old generations, and materialized view output. Unchanged data can be
shared, but retained readers still consume memory.

- Reference-only views avoid copying unchanged content where possible.
- Domain objects use normal managed lifetimes. Pooling is reserved for
  owner-private scratch/index buffers with explicit leases; no returned
  immutable graph may reference a buffer already returned to a pool.
- Retained views/history have explicit count/estimated-byte budgets. Admission
  failure or bounded waiting is preferable to unbounded accumulation.
- Suspension releases transient view work, not authoritative context.
- Without persistence, evicting the last authoritative copy is deletion, not
  transparent paging. Reloadable cold history requires a later backing adapter.
- Summarizing a range creates a derived entry with provenance. It does not
  silently erase original history, rewrite bookmarks, or confirm a memory.
- Reclamation occurs after references/leases are released, not merely when an
  entry disappears from the latest visible view.

A public immutable root can be retained outside owner-issued leases. Therefore
budget accounting cannot promise a hard process-memory cap or forced
reclamation of all application references.

## 10. Fit with the existing implementations

| Existing capability | Reuse / limitation |
| --- | --- |
| `IPolymorphicArray<T,TKey>` | Preserve as the common lookup/disposal facade |
| Factory builder/extensions | Reuse interface-returning, single-owner construction pattern |
| Positional COW | Supplies structural snapshot precedent, but currently clones the whole array per mutation |
| Keyed delta overlay | Supplies growth, versioned mutations, and bounded admission precedent; its live traversal/compacted snapshot are not the proposed full session view |
| Segmented SQLite | Storage/cache precedent, not a ready in-memory context-view implementation; cached reference values do not enforce this model's ownership policy |
| Direct SQLite | Committed persistence precedent, but fixed membership and materializing reads do not meet the new in-memory append/segment/view contract |

A bridge over the current whole-array COW engine must not be advertised as
segment-local mutation. Likewise, an arbitrary last-writer-wins overlay upsert
must not be advertised as an atomic expected-revision session change set.
Existing clients retain their existing semantics.

## 11. Bounded PoC delivery and verification

| Stage | Deliverable |
| --- | --- |
| 1. Domain and ownership | Session/entry/segment identities, immutable admitted content, factory-selected single client |
| 2. Segmented operations | Append, point/segment mutation, revision conflicts, coherent reads, retention limits |
| 3. Polymorphic views | Timeline, model projection, contextual anchors/navigation, keyword search, scoped-memory join |
| 4. Evidence | Deterministic concurrent replay, lifetime tests, and allocation/copy-work measurements |

Required acceptance scenarios:

1. Two sessions contain unrelated histories; mutating one does not clone the
   other's payloads or change its views.
2. A point update changes one bounded segment and matching index/directory paths,
   not a flattened full-session representation.
3. A multi-segment change publishes all requested changes together or none.
   Concurrent stale changes return conflicts rather than lose accepted updates.
4. Stable readers see their original revision while live evaluations advance
   only at defined boundaries. Data/index generations never disagree.
5. Append crosses a segment boundary without changing existing entry IDs or
   exceeding configured segment limits.
6. Navigation finds an earlier topic without loading/rendering the full
   transcript. Anchors survive position changes and report deleted targets.
7. Timeline, conversation, and model views differ while referencing the same
   canonical entries. Budgeted model selection preserves required call/results.
8. A repository memory applies to two sessions in that repository; a session
   memory does not leak into the other. Combined scopes use intersection.
   Proposed/retracted/expired records are excluded from default model views.
9. Memory promotion is explicit, retains provenance, and reports conflicts or
   unavailable source history rather than inventing evidence.
10. Retained-view pressure triggers the configured admission policy; disposal,
    failure, and admission timeout do not recycle resources still used by readers.
    Cancellation-token APIs are outside this initial synchronous PoC.

Measure view construction/navigation/search latency, point/segment publication
latency, allocation and copied/rewritten bytes, retained-generation growth, and
process memory under a fixed replay trace. Compare equivalent view, ownership,
and consistency semantics; throughput alone is insufficient.

Out of the initial PoC: live provider/model integration, semantic embeddings,
automatic memory promotion, persisted branches/time travel, cross-session or
cross-catalog transactions, distributed writers, and durable recovery.
Persistence and external tool idempotency require their own contracts.

## 12. Independent LLM context benchmarking plan

### 12.1 Definition boundary

This is a greenfield, workflow-first benchmark definition, not an adaptation of
the repository's earlier array/storage comparisons. Define the LLM operations,
outputs, consistency requirements, and scenarios first; implement benchmark
participants against those requirements afterward.

Do not retrofit COW, DeltaOverlay, segmented SQLite, DirectSqlite, native
checkpoint adapters, existing progress workers, or their experiment fixtures
into this task. Earlier results are not evidence for LLM context performance.
Existing benchmark tooling may host new fixtures, but the workload definition,
reference implementations, adapters, and replay engine are new work.

The questions are:

1. Can consumers obtain different correct views of the same context efficiently?
2. Can users navigate/search old conversation points without processing the
   complete transcript on every request?
3. What work does a point, range, or append operation impose on unrelated data?
4. How do concurrent access, retained views, and scoped memory affect latency,
   throughput, and resident memory over the session lifecycle?

### 12.2 What "the conventional way" means in this experiment

There is no claim that one implementation represents all existing LLM products.
Use two explicitly specified, purpose-built reference managers. They model
ordinary application-owned conversation management, not existing library
strategies renamed as LLM benchmarks.

| Participant | Fresh implementation definition |
| --- | --- |
| `ConventionalScan` | Session-ID dictionary, a mutable ordered list of immutable entries per session, stable-ID lookup maps, bookmark records, and a memory catalog. Per-session reader/writer locking protects coherent operations. Text/topic search and scope selection scan their applicable records. |
| `ConventionalIndexed` | The same conventional manager design with maintained keyword/topic postings and memory-scope indexes. Index maintenance is included in mutations and index memory is accounted for. |
| `LLMPolymorphic` | The proposed single client and segmented realization, implementing the same observable session/view operations. |

`ConventionalIndexed` is the primary performance reference. `ConventionalScan`
shows the effect of indexing, not proof that all conventional applications
must scan. Report both; a win over scanning alone is not sufficient evidence.

Both conventional managers must be credible implementations:

- Use the same admitted immutable entry/content values. Do not give one
  participant mutable aliasing shortcuts or force another to deep-clone safe
  immutable strings/records.
- Point and bounded-range requests read only their requested data; do not make
  every conventional read copy the entire history.
- A stable full-history view may copy entry references under the session read
  lock, then project outside it. Account for the copy and retained snapshot.
- Validate and prepare batch changes before publishing under the write lock;
  failed operations expose no partial state.
- Maintain stable entry addresses, coherent revision metadata, and the same
  bookmark, view, memory-scope, and retention semantics.
- Do not add serialization, disk commits, model calls, UI rendering, or network
  traffic to only one participant.

Implement a separate slow semantic oracle for correctness. It is not a timed
competitor and must not delegate correctness decisions to any participant.

### 12.3 Common operation and output contract

The benchmark port describes domain behavior, not physical storage. Conventional
managers need not manufacture the polymorphic implementation's segment layout.

| Operation | Observable contract |
| --- | --- |
| Create / append | Admit a session or ordered new entries; publish stable IDs and a new session revision |
| Read point / range | Return the requested canonical entries from one identified revision |
| Replace / delete point | Apply to a stable entry ID with expected-revision validation |
| Apply range change | Apply a bounded set of changes atomically within one session |
| Build view | Return the requested ordered, projected, limited output and its source revision |
| Add / resolve anchor | Address a canonical passage; report current, edited, missing, or unavailable historical targets explicitly |
| Search | Return matching entries/anchors with snippets, canonical addresses, and source revision |
| Query / change memory | Enforce the requested scope conditions, status, expiry, provenance, and catalog-revision rules |
| Retain / release read | Preserve a captured revision and release owner-issued retention when requested |
| Suspend / close / expire | Apply the defined lifecycle policy without silently dropping authoritative context |

Shared new policy functions define text normalization, search matching/ranking,
view filtering/order, token estimation, and memory applicability. This prevents
one participant from doing less useful work or choosing better model context
merely because it uses a different policy.

Every requested output must be consumed inside timing. Deferred enumerators
cannot count as completed views before traversal. Compare full output values
against the oracle outside timing; consume an identical output digest inside
timing to prevent unused-result shortcuts.

Model-context traces use a fixed deterministic token estimator identified in
the run manifest. It is a synthetic workload policy, not a claim about a
provider's actual tokenizer, answer quality, or inference cost.

### 12.4 Scenario suite

All histories, anchors, tool relationships, memory records, expiry transitions,
and expected query matches are generated before timing with a recorded seed.
No live model or embedding service is required.

| Scenario | Replay and primary signal |
| --- | --- |
| A. Active conversation | Append a user message, assistant tool call, matching result, and response; build the next model-context view. Measure append plus useful context assembly, not just insertion. |
| B. Long-history navigation | Resolve anchors near the beginning, middle, and end; fetch surrounding ranges and page the timeline. Measure request work as total history grows. |
| C. Search and topic browsing | Mix hit, miss, rare-term, common-term, and title/topic queries with fixed result limits. Interleave appends/replacements so index maintenance and freshness are exercised. |
| D. Point and range correction | Replace/delete old entries, resolve affected anchors, and apply a 16-entry atomic change. Verify stable identities, explicit missing targets, and work isolated from unrelated payloads. |
| E. Concurrent views and writes | Readers request point/range, conversation, navigation, and model views while writers append or correct entries. Test one hot session separately from independent sessions. |
| F. Scoped-memory reuse | Query multiple sessions in the same and different repositories. Confirm/promote, supersede, retract, and expire records; test combined scopes and provenance. |
| G. Retention and lifecycle | Hold old read leases while updating, release them, cycle sessions through suspend/close/expiry, and apply retention pressure. Measure retained generations, admission behavior, and post-release stabilization. |

Scenario G does not simulate transparent disk eviction: the initial PoC has no
backing store. Scenario B does not pretend a saved revision number preserves
history that was never retained.

### 12.5 Initial data profiles and bounded execution

These are proposed starting fixtures, not a factorial parameter matrix or
calibrated production distribution:

| Profile | Sessions | Initial entries/session | Approximate UTF-8 content bytes/entry | Purpose |
| --- | --- | --- | --- | --- |
| Interactive | 1 | 256 | 512 | Small-session overhead and active conversation |
| Long history | 1 | 16,384 | 1,024 | Navigation, search, and point/range scaling |
| Multiple sessions | 32 | 2,048 | 512 | Session independence and repository-scoped memory |
| Large entries | 1 | 1,024 | 16,384 | Payload retention and copied/rewritten-byte behavior |

Byte figures describe generated content, not CLR object size or working set.
Include a deterministic mix of text, tool calls/results, summaries, and
internal entries; record the exact distribution, anchor density, and memory
counts in the manifest. Vary tool-result size independently in later expansion.

Start with all participants on Interactive scenarios A, B, D, and F, with one
writer and one reader. Validate correctness before running the long-history
profile. Then add C, E, and G and the other profiles as separately identified
experiments; do not silently run every Cartesian combination.

For concurrency, begin with `(readers, writers)` of `(1, 1)`, `(8, 1)`, and
`(8, 4)`. Separate same-session contention from writers assigned independent
sessions. Separate view retention from ordinary short-lived reads.

Histories and expected outputs are not allowed to grow accidentally across
measurement iterations. Each finite replay starts from an equivalent prepared
state outside timing; a soak instead declares its growth, release, and cleanup
schedule. Setup/seeding is measured separately if reported.

### 12.6 Replay scheduling and fairness

- Replay identical operation inputs, payloads, query limits, scope requests, and
  view policies for every participant. The benchmark port does not require the
  same internal allocation or storage representation.
- Single-writer traces preserve per-session order and have deterministic
  accepted outcomes. Use these for direct comparisons of equivalent work.
- Contention traces deliberately race expected revisions. Capture actual
  accepted/conflicting operations and validate a legal committed history; do
  not assume the scheduler produces identical winners across participants.
- Use barrier-controlled conflict rounds when an experiment needs a fixed
  accepted-operation count. Report attempts, commits, conflicts, retries, and
  rejected admissions separately rather than reward an engine for doing less.
- Apply identical timeout and retained-view policies. Report saturation and
  backpressure rather than dropping failed or timed-out requests from results.
- Use an injected clock for expiry and a deterministic search tie-breaker.
  Search snippets and bookmark resolution must match the captured revision.
- Scope and index generation/maintenance are real workload costs. Do not
  precompute indexes outside timing for one participant's measured updates.

Use a controlled closed-loop replay first. For a saturation experiment, add a
separate scheduled-arrival driver and report target versus achieved arrival
rate, queue wait, service time, end-to-end latency, and outstanding work.
Closed-loop latency alone must not be presented as an overload result.

### 12.7 Measurements and reporting units

| Dimension | Required output |
| --- | --- |
| Correctness | Output equivalence, legal revisions, atomic changes, stable anchors, valid call/result grouping, and correct scoped memory |
| Latency | Per-operation category p50/p95/p99, sample count, queue wait where applicable, and completed replay time |
| Throughput | Completed useful requests/sec plus actual mutations, conflicts, retries, and admissions |
| Allocation / copying | Allocated bytes, GC counts, entries/segments inspected, and participant-instrumented copied/rewritten bytes |
| Memory | Managed heap, process private/working-set observations, index estimates, retained-generation estimates, and high-water marks |
| Lifecycle | Retained leases/roots, admission delays/failures, and memory observations after release/retirement |
| Scaling | History length, active-session count, payload size, concurrency, and retention varied independently |

Internal copied-byte and retained-byte counters are estimates with documented
accounting rules, not substitutes for independent process/heap observations.
Measure instrumentation overhead separately; use matching instrumentation modes
across participants.

BenchmarkDotNet can measure new isolated operation/bounded-replay fixtures.
A new concurrent replay/soak harness records operation-level timings and samples
memory. A BenchmarkDotNet batch mean is not a request latency percentile.

Report finite replay results per replay and explicitly list operation counts.
Only normalize by fixed declared work; do not reuse an operations-per-invoke
constant when the scenario changes its request mix. Performance ratios compare
the same profile, operation semantics, and completion conditions.

Run correctness and a short smoke replay first. The initial warmed proposal is
one process launch, three warmups, and ten measured finite replays, separately
for .NET 8 and .NET 9 and sequentially on the same host. Record sample counts;
do not infer reliable tail latency from only ten batch means. Concurrent runs
collect individual request samples and declare their duration/request limit.
A separate bounded soak samples memory through growth and release phases.

Do not time forced GC as normal application behavior. If a separate diagnostic
forces collection after release, label it and distinguish that observation from
normal reclamation timing. No absolute latency target or universal speedup is
claimed before measurement.

### 12.8 Evidence and exit criteria

Every run saves a manifest with source revision/hash, participant, runtime/SDK,
host/GC settings, seed, data profile, operation trace/version, policy versions,
concurrency/arrival mode, budgets, timeouts, instrumentation mode, and measurement
boundaries. Retain raw operation samples, correctness summaries, memory samples,
and summarized results, including exclusions and failed runs.

The benchmark definition is ready for implementation when each scenario has
fixed inputs, expected semantics, a declared timing boundary, and a bounded
execution plan. A performance result is publishable only after its correctness
gates pass.

The evidence must show where each participant wins or loses. In particular:

- A navigation/search win must include equivalent result quality and index
  maintenance cost, not just compare an index against a forced full scan.
- A mutation win must preserve the same atomicity and read semantics.
- A memory win must account for retained views and indexes, not merely lower
  transient allocation or silently discarded context.
- Small-session regressions must remain visible alongside long-history gains.

This section defines the benchmark contract. Section 13 identifies the
implemented subset and section 15 records validation, not warmed performance
claims. It does not approve reusing old experiments.

## 13. Implemented PoC and runnable entry points

| Project | Responsibility |
| --- | --- |
| `src\ScalablePolymorphicArray.Llm` | Domain model, single owning bridge, independent segmented realization, views, navigation/search and scoped memory |
| `benchmarks\ScalablePolymorphicArray.Llm.Benchmarks` | Fresh conventional scan/indexed managers, separate semantic oracle, deterministic traces, BenchmarkDotNet fixture, concurrent driver, retention diagnostic and demo |
| `tests\ScalablePolymorphicArray.Llm.Tests` | Domain/ownership/concurrency/view tests and differential replay validation |

No previous strategy, progress worker, fixture or adapter is used as an LLM
benchmark participant. The benchmark project depends only on the LLM library,
its core interface dependency, and BenchmarkDotNet.

The new CLI has these bounded modes:

```powershell
# Build the solution using an SDK with installed targeting packs.
dotnet build ScalablePolymorphicArray.sln -c Release

# Actual factory-selected client: navigation, conversation, scoped memory, model view.
dotnet benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --demo

# All seven finite scenarios, all three participants, full oracle comparison.
dotnet benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --smoke --output TestResults\LlmContext\smoke-net9.json

# Explicit expansion: one long-history scenario rather than a Cartesian product.
dotnet benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --smoke --profile LongHistory --scenario Navigation --output TestResults\LlmContext\navigation-long-net9.json

# Actual concurrency: hot session AND independent sessions, three participants.
dotnet benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --concurrent --readers 8 --writers 4 --operations 64 --output TestResults\LlmContext\concurrent-net9.json

# Scheduled-arrival variation; queue lateness remains in end-to-end samples.
dotnet benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --concurrent --readers 8 --writers 4 --operations 64 --arrivalRate 1000 --output TestResults\LlmContext\arrival-net9.json

# Bounded growth, retained snapshots, then release; no forced GC.
dotnet benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --soak --rounds 32 --output TestResults\LlmContext\retention-net9.json

# New finite-replay BenchmarkDotNet fixture; each measured replay resets its state.
dotnet benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --filter '*LlmReplayBenchmarks*' --job Short --launchCount 1 --warmupCount 3 --iterationCount 10 --unrollFactor 1 --artifacts TestResults\LlmContext\BDN
```

`--smoke` is a single-pass correctness/instrumentation check, not a statistical
speed comparison. The finite `Concurrent` scenario is a serial control; actual
concurrency is exercised by `--concurrent`. Independent-session concurrent runs
use one session per writer. Scheduled arrivals use bounded dedicated workers,
not an unlimited request queue; lateness is recorded rather than discarded.

`--smoke --scenario ScopedMemory` uses two sessions even for Interactive, so
repository reuse versus session isolation is exercised. Reports record the
actual count. The other data profiles are available through `--profile`.

The comparative read port measures real owning-client read admission and
materialized domain policies. It does not include UI rendering or claim to
measure the separate generic `OpenView` wrapper's output-accounting overhead;
that wrapper has direct correctness/lifetime tests. All requested port outputs
are consumed inside timing, including formatting/checksum work.

Evidence JSON records source hashes, build SDK, runtime/host/GC settings,
arguments, fixed seed/profile, actual operation counts and raw samples.
BenchmarkDotNet additionally produces its own job metadata. No smoke result is
promoted to a warmed throughput/latency claim.

## 14. Performance-critical data structures and complexity ledger

### 14.1 Symbols and cost model

- `D`: number of sessions; `N`: entries in the selected session; `S`: segments.
- `B`: entries in an affected segment, bounded by configured count and estimated
  bytes; `A`: anchors; `M`: memory records; `V`: distinct indexed terms.
- `R`: returned entries/results; `K`: changed entries or change commands;
  `Q`: distinct query terms; `P`: largest relevant postings list;
  `Pmin`: smallest relevant postings list; `U`: distinct terms in edited text.
- `C`: characters actually inspected/formatted/tokenized; `Cdelta`: old/new
  characters of changed or removed entries; `Cout`: consumed output text.
- `Lw`: maximum word length. `F(C,U) = O(C + U log U * Lw)` is current word
  extraction, deduplication and ordering under ordinary string-hash behavior;
  ordinal word comparisons are not constant-time. Pathological hash collisions
  can add O(U-squared * Lw) work during deduplication.
- `H(n)`: an immutable hash-bucket dictionary/set operation. .NET's implementation
  uses a balanced tree keyed by hashes with collision buckets, not a HAMT.
  Normal cost is `O(log(n+1))` plus key hashing/comparison; pathological equal
  hash buckets can contribute `O(n)` work.
- `L(n) = O(log(n+1))`: persistent indexed-list access/update or balanced ordered
  directory access, excluding payload copying.

Do not simplify these to unconditional O(1). The source model for the hash
collections is the .NET runtime `ImmutableDictionary_2.cs` /
`ImmutableHashSet_1.cs` implementation. Immutable-list indexing and AVL path
copying likewise matter; implementation-level reasoning must be revisited if
these structures or runtime versions change.

### 14.2 Why these structures were selected

| Structure | Selection reason | Cost / tradeoff |
| --- | --- | --- |
| `ConcurrentDictionary<Guid, Slot>` | Growing session directory and independent session publication without cloning an outer session array | Expected O(1) lookup; collisions/resizing and shared directory synchronization still exist |
| Immutable sorted segment directory | Stable segment IDs, ordered traversal, structural sharing | O(log S) lookup/path update; not constant-time array addressing |
| `ImmutableArray<ContextEntry>` inside a segment | Contiguous bounded reads, immutable published membership | Entry indexing O(1); append/set/remove copies O(B) references, not immutable payload strings |
| Immutable entry-ID/location map | Stable point addressing across deletions and views | H(N) lookup/update; per-entry index nodes add memory |
| Persistent indexed order list | Appends/deletions without copying an N-entry flat directory | O(log N) indexing/path updates; binary search therefore costs O(log-squared N) |
| Immutable term/postings maps | A captured root includes matching search state; writers cannot mutate readers' indexes | Hash-bucket and postings costs; changed text must be tokenized and paths allocated |
| Immutable seen-ID set | Deleted IDs cannot be reused to redirect old anchors | H(lifetime entry count); tombstones grow with lifetime admissions, not just live N |
| Separate immutable memory catalog/scope index | Repository/user memory is not duplicated as session authority | Additional revision and lifetime accounting; no cross-catalog transaction |
| Reference-identity retention map | Deduplicate repeated leases on exactly the same roots | Expected O(1) accounting; distinct roots are conservatively charged without deduplicating their shared subgraphs |

### 14.3 Reader execution cycle

1. The bridge takes shared lifecycle admission. `TryFind` resolves a slot and
   reads its published reference; it does not scan or flatten the session.
2. `OpenRead` captures a session root, a memory root and evaluation time. Under
   the accounting gate it checks limits and retains both roots.
3. Read operations resolve only against those roots. Search/data indexes cannot
   come from different session publications. The memory revision is separately
   identified; it is not asserted to be atomic with the session revision.
4. The requested output is projected/materialized and consumed.
5. Disposal releases accounting exactly once and wakes bounded admissions.
   Disposed read handles clear their root references. Existing issued leases
   survive owner disposal because all retained payloads are managed immutable
   objects, not recycled native/pool buffers.

| Read path | Calculation |
| --- | --- |
| Session lookup | Expected O(1), plus lifecycle admission; returned root retains its reachable graph |
| Entry lookup | `H(N) + L(S) + O(1)`; no whole-session allocation |
| Sequence lower bound | O(log N) comparisons times O(log N) persistent-list indexing = O(log-squared N) |
| Bounded range | `O(log-squared N + R * (L(N) + H(N) + L(S)))` work and O(R) output references |
| Anchor resolution | `H(A) + 2 * (H(N) + L(S))`, plus fixed status checks |
| Keyword search | Query extraction `F(Cquery,Q)`, Q term lookups, Q-list ordering, then at most `Pmin * Q` membership tests; resolve surviving candidates and sort K hits in O(K log K) before limiting |
| Search snippet formatting | Additional characters formatted for candidates; the 160-character output cap does not prevent full tool-content formatting today |
| Applicable memory | Scope index lookups plus candidate-set union/filter, record lookups and O(R log R) deterministic ordering; empty scopes select nothing |
| Model view | Expected O(S + N + C + M log M), plus estimator cost, with O(N + M + C) temporaries; it currently examines the full session |
| Conversation/tool view | Worst O(S + N + Cout); filtering may inspect N entries to find a small R |
| Generic projected view | Predicate/projection cost plus enumeration, O(R) reference output and size-estimator work; caller code is not assumed constant-time |

For search, H(V), H(P), string lengths, collision behavior and resolved-candidate
lookups must be included when expanding the symbolic membership terms. A common
term may yield `Pmin ~= N`, so an inverted index does not guarantee bounded
search latency. Navigation uses direct anchors rather than text scanning.

### 14.4 Writer execution cycle

1. Capture the current session root and compare the expected revision.
2. Prepare a private transaction: validate commands, construct changed segments,
   and path-copy matching location/order/search indexes. Readers see none of
   these intermediate objects.
3. Enter that session's commit gate. Reject a removed slot or changed captured
   root; a conflicting writer must not overwrite newly accepted context.
4. Under the short accounting gate, check estimated resident/retention budgets
   and publish the new complete root. Update counters, then release both gates.
5. Old roots remain usable until readers and other references release them.

For one segment rewrite, the implementation compares B immutable references.
It validates/estimates/indexes only changed payloads. Let Kc be changed/new/deleted
entries and J be retained entries whose offsets shifted:

```text
Wsegment =
    O(B) reference-array / identity-comparison work
  + O((Kc + J) * H(N)) location work (an upper bound)
  + O(Knew * H(T)) newly admitted identity metadata
  + O(F(Cdelta,U))
  + O(U * (H(V) + H(P))) postings/path updates
  + O(L(S) + H(S)) segment-directory/size metadata
```

Here U is total distinct-term visits across changed entries, not the union of
all segment words. T counts lifetime entry IDs, and Knew is newly admitted
entries. Repeated hashing/formatting is part of Cdelta. A same-offset point
replacement does not update the unchanged location map. A new/fully replaced
segment can still change B entries and reach the full bound.

| Mutation | Current bound / behavior |
| --- | --- |
| Point replace | O(B) reference copy/comparison plus changed-payload extraction/posting updates and segment-directory paths; unchanged payloads are not re-estimated or re-tokenized |
| Append one entry | Tail lookup O(log S), O(B) tail-reference copy or new bounded segment, `Wsegment`, O(log N) order append and seen-ID insertion |
| Append K entries | Up to K bounded tail rewrites: **O(K * Wsegment)**, not automatically one rewrite |
| Delete one entry | `Wsegment` plus lower-bound O(log-squared N) and order-list removal O(log N); the seen-ID tombstone remains |
| Replace one complete segment | `Wsegment` and O(B) identity/order validation; supplied immutable membership is not flattened across the session |
| K-entry replacement-only batch | One private reference buffer/final segment per touched segment; ordered per-command validation, estimation and index maintenance; see the bound below |
| Mixed K-command atomic change | Sum of sequential preparation costs plus one publication; append/delete/anchor/status combinations are not coalesced |
| Anchor upsert/remove | Anchor text extraction, affected postings updates and H(A) map update; no segment rewrite |
| Memory batch | Changed records/source-anchor validation, immutable record/scope-index paths, one memory-catalog publication |
| Initial seed | Visits every entry/anchor, builds indexes/order directories and validates bounds; excluded from steady-state replay timing |

For K replacements touching D segments, coalescing costs
`O(K * H(N) + sum(Bd) + D * log S + I + E)` under normal dictionary hashing.
Here Bd is each touched segment's length, I is the unchanged per-command
tokenization/postings work, and E is caller estimator work. Scratch/reference
storage is `O(sum(Bd) + D + K)` excluding persistent-index allocation. Dictionary
collision chains can degrade grouping. For one segment, reference-array work
falls from O(K * B) to O(B + K), not total mutation work to O(B + K).

Every replacement, even one overwritten later, still undergoes ordered content
validation and new/old size estimation. Each intermediate segment-byte limit
is checked. Index changes remain private and sequential; only segment-array
materialization and directory/size-map updates are coalesced. Mutable buffers
transfer their arrays once and cannot mutate any published/retained root.
Single replacements and mixed transactions retain their original paths.

If W writers repeatedly prepare the same revision, speculative preparation can
approach W times the winning preparation cost. Short publication does not make
the discarded CPU/allocation free. The concurrent driver reports accepted
commits, conflicts and admission failures separately.

Size estimators and selectors are caller callbacks; their actual complexity and
allocations add to these bounds. They must be stable and non-reentrant. Some
bridge wrappers currently allocate capturing delegates per operation; this is
a visible fixed-cost optimization opportunity, not omitted from measurements.

### 14.5 Retention, output, and accounting

Live-state space is O(D + S + N + A + M + I + C + T), where I is total
index/posting metadata, C is retained payload characters and T is lifetime
identity tombstones. With G retained arbitrary revisions, an intentionally loose
upper bound is G times a full state. Structural sharing often makes actual
incremental retention closer to changed segment-reference arrays, changed index
paths and new payloads, but measuring that sharing is necessary before claiming
a tighter byte bound.

The session directory also retains admitted session IDs after removal so old
provenance cannot be redirected by reusing an identity in the same owner.
Empty physical segments and identity tombstones are not compacted in this PoC;
their lifetime growth remains part of S/T and the estimated active budget.

O(1) root retention is not O(1) retained bytes. The reachable payload/index
graph may be large. Same-root leases share one identity charge, while different
revisions are conservatively charged as complete roots even when they share
most data. Active and captured roots may consequently be double-counted.

Generic `OpenView` bounds result count with `MaximumViewResults`, estimates
output through `ProjectionSizeEstimator`, and holds a separate output charge
until disposal. The default estimator is conservative for known result types
but cannot discover arbitrary custom object graphs; supply a suitable estimator.
Materialization occurs before final admission, so transient allocations still
exist even for a rejected output.

`ReadRange` returns a caller-owned immutable result array. Those escaped arrays
and raw `TryFind` roots are not forcibly reclaimed or tracked indefinitely by
the owner. Managed GC, runtime metadata, dictionary capacity and transient
preparation mean estimated budgets are not hard process-memory guarantees.

`EstimatedSegmentBytesRewritten` is estimated logical segment payload footprint,
not measured serialized bytes or actual string-copy bandwidth. Segment array
operations copy entry references, not the immutable strings they reference.
Independent allocation/heap/process measurements remain necessary.

### 14.6 Conventional references, oracle, and replay costs

| Path | Conventional reference cost |
| --- | --- |
| Point read / replace | Expected O(1) ID lookup/list addressing plus changed-text indexing; reads/writes take the session lock |
| Sequence range | O(log N + R) with flat-list binary search and bounded output copying |
| Append | Amortized O(1) per list append, with occasional O(N) capacity growth, plus indexing |
| Delete batch | One O(N) list compaction/location rebuild, plus affected text index maintenance |
| Stable retained snapshot | O(N + A) reference copying; payload strings are shared, then the read lock is released |
| Scan search | Tokenizes applicable entry/anchor text and sorts actual matches; cost grows with inspected characters |
| Indexed search | Mutable hash/set membership is expected O(1) per probe, with collision caveats; candidate sorting and text/index maintenance still apply |
| Memory scan / index | Full applicable-catalog scan versus scoped candidate enumeration, then identical filtering/order |
| Model/conversation projection | Same semantic policy/output work as the polymorphic adapter; long projections hold a conventional session read lock |

The separate oracle intentionally uses full transaction copies and simple
ordered/regex searches. Its tool-pair search can take O(N-squared) work. None
of that oracle time is a competitor's benchmark time.

A replay adds O(number of actions + Cout) result-consumption work and stores
bounded materialized observations. Per-request sampling adds Stopwatch calls
and record allocations. Concurrent runs also add identical history logging and
process-memory sampling; allocation totals include that instrumentation.
Accepted revisions are sorted/validated after timing. Closed-loop results do
not imply behavior under an unbounded arrival queue.

Concurrent latency aggregation is outside the measured interval: O(R log R)
time and O(R) temporary storage for R requests. Service and end-to-end p50/p95/p99
use empirical nearest rank with explicit sample counts; category and mutation
status are grouped separately so conflicts cannot masquerade as fast accepted
writes. Queue-wait p95 and raw samples are retained. Completed-attempt throughput
includes conflicts; useful-request throughput includes reads and accepted writes
only. Small bounded samples are diagnostics, not statistically reliable tail SLAs.

### 14.7 Explicit optimization points

Measure before selecting among these changes:

1. Extend replacement-only segment coalescing to other transaction shapes only
   if measured value justifies their more complex membership/order semantics.
   Replacement-only batches are implemented; append and mixed changes are not.
2. Diff terms within changed entries rather than removing/readding their entire
   postings contribution. Unchanged entries already skip payload/index work.
3. Replace indexed-list binary search with a persistent sequence-aware order
   tree supporting direct O(log N) lower bound.
4. Maintain bounded-tail/tool-group metadata for model views rather than walk
   all N entries; preserve exact summary, budget and pairing semantics.
5. Use bounded top-K search instead of sorting every candidate when limits are
   small; retain deterministic ordering and complete match correctness.
6. Avoid temporary formatted tool strings for estimation/indexing/snippets.
7. Eliminate per-operation bridge closures where they matter at small N.
8. Account shared subgraphs more precisely if conservative root charges cause
   unnecessary admission failures; do not trade away lifetime correctness.
9. Add a scoped-memory query-result cache only with explicit catalog revision
   and expiry invalidation; never treat stale memory as an invisible shortcut.

Except for replacement-only coalescing, these are not claimed completed
optimizations. Performance impact must be established by matching measurements.

Current operations are synchronous and use bounded admission timeouts; they do
not yet expose cancellation tokens. Exact pinned historical retrieval is not
implemented: missing retained history is reported explicitly. The original
finite comparative fixtures give resident-byte budgets generous, nonbinding limits;
they compare bounded read counts and retention work, not equivalent physical
byte-budget exhaustion across different accounting models. Production-owner
admission/output-budget failures have focused correctness tests.

## 15. Initial PoC verification (before replacement coalescing)

The implementation has focused ownership, mutation, view, memory-scope and
concurrency tests plus differential checks against a separate semantic oracle.
The initial Release solution build succeeded without compiler warnings or errors.
All **608 tests passed**: 262 existing plus 42 new LLM tests on each of .NET 8
and .NET 9, with no failures or skipped tests. The concurrent tests also check
latency grouping, nearest-rank percentiles and useful-request throughput.

| Validation | Observed result | Artifact under `TestResults\LlmContext` |
| --- | --- | --- |
| Seven finite scenarios, three participants | 21 oracle-matched cases per runtime | `smoke-net8.0.json`, `smoke-net9.0.json` |
| Factory/client demonstration | Navigation, conversation, scoped memory and model view succeeded | Console output from `--demo` |
| Actual closed-loop concurrency | Six participant/topology cases passed; 8 readers, 4 writers, 64 operations per worker; no admission rejections | `concurrent-net9.json` |
| Retain/grow/release diagnostic | Three participants passed; 32 growth rounds and 8 release observations each | `retention-net9.json` |
| Long-history navigation | All three participants matched the oracle with 16,384 entries | `navigation-long-net9.json` |
| Bounded scheduled arrivals | Six cases passed; 2 readers, 2 writers, 8 operations per worker, target 1,000 arrivals/sec | `arrival-net9.json` |
| BenchmarkDotNet Dry | All 12 finite-replay cases executed using the in-process toolchain | `BDN-Dry-Final`, `bdn-dry-final.log` |

All six JSON artifacts were regenerated for that initial source snapshot, and
all 33 source/configuration SHA256 hashes in each manifest were verified
against the working files. These generated artifacts are ignored by Git.
Scoped formatting and whitespace checks cover the new implementation.

On this host, SDK 10.0.404's default restore requests a .NET 9 targeting-pack
version unavailable from the configured feed. Validation therefore uses the
installed SDK 9.0.320 directly, without changing repository target frameworks
or package sources:

```powershell
dotnet 'C:\Program Files\dotnet\sdk\9.0.320\MSBuild.dll' ScalablePolymorphicArray.sln -restore -p:Configuration=Release -m:1 -verbosity:minimal
dotnet test ScalablePolymorphicArray.sln -c Release --no-build --no-restore --logger 'console;verbosity=minimal'
```

The evidence records build SDK 9.0.320. The BDN runner reports the installed
default SDK 10.0.404 and executes the already-built .NET 9.0.22 assembly with
`--job Dry --inProcess --unrollFactor 1`, avoiding generated-project restore.
Its short-iteration warnings are expected for this harness check.

**No warmed performance conclusion is claimed.** Dry means are per replay,
not per request, and the bounded concurrency samples do not establish reliable
tail SLAs. The longer warmed proposal in section 12 remains a separate
experiment; the earlier user-stopped storage benchmark was not resumed.

## 16. Replacement-only coalescing and matched warmed correction measurement

The replacement-only fast path buffers one private entry array per touched
segment, validates each edit in caller order, and freezes each segment once.
Repeated-ID edits observe the preceding private value. Invalid/oversized
intermediate edits and estimator failures still reject the complete transaction.
Single replacements and mixed transactions retain the original path. Index
maintenance remains per command; this is not a term-diff/index-builder change.

The Release solution build passed, and all 50 LLM tests passed on each of
.NET 8 and .NET 9 (100 executions). New coverage includes multi-segment and
repeated-ID batches, old-reader/index isolation, intermediate validation/size
failures, estimator ordering and skipping unrelated payload estimates.
The solution formatter returned zero but reported .NET 9 workspace-reference
warnings; independent changed-file whitespace verification and `git diff --check`
were clean. Compilation/tests used SDK 9.0.320 with the installed target packs.

The unchanged warmed baseline is retained under
`TestResults\LlmContext\Warmed-Correction-20261111-002116-6421ad3d`.
The post-change run is under
`TestResults\LlmContext\Warmed-Correction-Coalesced-20261111-004528-8d43ae11`.
Only the two library files, two test files and this document differ from the
baseline source snapshot. Benchmark definitions, fixtures, oracle, replay,
participant setup, dependencies and measurement policy are unchanged.

Both measurements use Release/net9.0 on .NET 9.0.22, BDN 0.15.8, one launch,
five workload warmups, twenty measured iterations, InvocationCount=1 and
UnrollFactor=1. Each iteration initializes a fresh participant; one operation
is one complete Interactive/Correction replay. MemoryDiagnoser and full-value
oracle checks remain enabled. All twenty observations are retained
(`OutlierMode=DontRemove`). The artifact-only launcher preserves the user's
active power plan, which was verified unchanged.

Normal out-of-process generation again failed restore with NU1102 for the
default SDK's requested 9.0.23 reference/host packs. That failure and generated
files are retained. The successful run therefore uses InProcessEmitToolchain,
matching the earlier fallback, not isolated child processes.

| Participant | Before managed bytes/replay | After managed bytes/replay | Allocation change | After / Indexed allocation |
| --- | ---: | ---: | ---: | ---: |
| ConventionalIndexed | 92,944 | 92,944 | 0% | 1.000 |
| ConventionalScan | 18,192 | 18,192 | 0% | 0.196 |
| LLMPolymorphic | 515,688 | 326,864 | -36.62% | 3.517 |

Coalescing removes 188,824 measured managed bytes/replay (184.40 KiB).
The allocation gap narrows from 5.548x to 3.517x Indexed, but does not disappear.
The code path now constructs one final segment for the sixteen-entry batch,
rather than sixteen intermediate segment arrays. Persistent postings, changed
text processing and per-command state allocation remain.

Post-change time statistics are microseconds per complete replay:

| Participant | Mean | Median | Standard deviation | BDN 99.9% CI of mean |
| --- | ---: | ---: | ---: | --- |
| ConventionalIndexed | 442.580 | 413.450 | 111.355 | [345.884, 539.276] |
| ConventionalScan | 160.830 | 157.800 | 20.137 | [143.344, 178.316] |
| LLMPolymorphic | 1,436.060 | 1,360.600 | 274.892 | [1,197.356, 1,674.764] |

The polymorphic mean fell 32.31%, but the unchanged Indexed mean also fell
34.12%, while unchanged Scan rose 52.03%. Its ratio of means to Indexed is
3.245 after versus 3.158 before. This is not a demonstrated timing speedup
attributable to coalescing. BDN's separate distribution-based Ratio values
are 1.04 / 0.38 / 3.38, not ratios of the displayed means.

Warnings: all three minimum iteration times are below BDN's 100 ms recommendation
(348.7 us Indexed, 134.7 us Scan, 1.161 ms Polymorphic); Indexed is potentially
multimodal (mValue=3). Detected outliers were retained: Indexed 675.90/822.10 us,
Scan 226.30 us and Polymorphic approximately 2.28 ms. No invocation count was
increased to hide short-iteration warnings. Raw samples, full JSON, CSV/HTML,
commands, source hashes and `comparison.json` are in the new artifact directory.
The failed normal run also reports unavailable baseline ratios, not measurements.

## 17. Pre-promotion pressure experiments

The conventional indexed adapter is **not promoted and no default is changed**.
The new `--pressure` driver compares the existing Scan, Indexed and Segmented
participants in 72 bounded cases. Each case runs in a fresh .NET process.
Finite deletion/index-payoff cases use five warmups and twenty measured replays,
with fresh participant initialization before every replay. Initialization is
sampled separately. Full-value oracle checks are outside operation timing.

| Pressure point | Bounded workload and observations |
| --- | --- |
| Reader/writer contention | 2,048 / 16,384 entries; two full-history range readers and one writer, 32 barrier-coordinated rounds; raw request latency, conventional lock/admission waits, accepted writes and completed reads |
| Snapshot copying | 512 / 4,096 / 16,384 entries; eight retained revisions while replacing and appending; capture/mutation allocation, copied reference counts, managed/heap/private memory, release and explicit forced-GC phases |
| Deletion scaling | 512 / 4,096 / 16,384 entries; beginning/middle/end deletion; replay allocation/time and observed conventional compaction/location-rebuild counts |
| Index maintenance/payoff | 1,024 entries; 128 / 8,192 / 32,768 changed characters; twenty actions with 0 / 50 / 90% searches (20 / 10 / 2 writes), alternating broad/selective queries |
| Admission/resource pressure | Two held reads and 100 ms timeout; release requested after 10 ms; separate retained-byte limit across distinct roots, then eight 32,768-character appends against a calibrated resident estimate while holding an old root, followed by release/retry |

Snapshot capture/mutation paths warm on a separate owner; admission is an
explicit lifecycle diagnostic, not a warmed finite replay. GC counts cover the
entire case, including setup/oracle work and diagnostic forced collections.
Current-thread managed allocations are measured around synchronous operations;
they are not resident bytes. Memory observations include fixture/oracle/harness
objects. Original fixture payloads remain live, so release observations concern
incremental retention, not complete conversation eviction.

Conventional counters are opt-in/thread-local. The disabled branches remain in
ordinary adapter calls, so this source snapshot must not be substituted for the
unchanged correction baseline. Timers/counters add overhead to short operations.
Unavailable Segmented internal wait/compaction measurements are `null`, not zero.
Conventional participants lack resident/retained byte admission and finite write
lock timeouts: these are **guarantee gaps**, not equivalent-performance results.
Segmented accounting is conservative and may double-charge shared roots; it is
not a hard process-heap limit.

All raw samples and empirical nearest-rank p50/p95/p99 retain their sample counts.
Small samples do not establish production tail latency or confidence bounds.
Contention wall time includes barriers and validation; it is not saturation
throughput. Fixed participant order and separate child-process JIT/GC behavior
remain limitations. Forced GC is explicitly labeled and excluded from request
timings; private/working-set pages need not shrink when managed objects die.

### 17.1 Executed run and evidence

All **72 cases passed**, retaining **2,916 request/setup observations**, under
`TestResults\LlmContext\Pressure-20261111-011500-c6aab1a4`.
The run used Release/net9.0, .NET 9.0.22, SDK 9.0.320, and direct-DLL child
processes, not BenchmarkDotNet or its generated-project fallback. Exact command:

```powershell
dotnet D:\source\esp\benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --pressure --output D:\source\esp\TestResults\LlmContext\Pressure-20261111-011500-c6aab1a4\Cases
```

HEAD was `5a567828a17117db460d866a34cc6b0b0a4bc62a` with the existing dirty
LLM implementation and new pressure files. All 35 measured source/configuration
hashes matched across all 72 children, the suite manifest, and the working files.
The pre-existing Git index and active power plan were unchanged. Metadata and
exact dirty status are in `run-before.json` / `run-after.json`; per-case logs,
raw samples and manifests are in `Cases`; aggregation is in `analysis.json` and
`request-summary.csv`. No prior evidence was overwritten.

The Release solution build passed. All **65 LLM tests passed on each of .NET 8
and .NET 9**, including 15 focused pressure cases per runtime. The solution
formatter returned zero but repeated its .NET 9 workspace-reference warnings;
compilation and tests used the installed SDK 9 reference packs successfully.
No production storage algorithm or default was changed for this pressure run.
This direct driver does not emit BenchmarkDotNet warnings. In the retained raw
data, 548 of 2,916 timed observations are below 0.1 ms; timer/instrumentation
overhead, tiered JIT, pauses and the small sample counts limit timing conclusions.

### 17.2 Reader/writer contention: latency isolation is not faster reading

Each row contains 64 completed full-history reads and 32 accepted writes;
there were no conflicts or admission rejections. Times are milliseconds.

| Entries | Participant | Read mean | Read p95 | Write mean | Write p95 | Mean observed write-lock wait |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 2,048 | Scan | 0.076 | 0.149 | 0.103 | 0.210 | 0.078 |
| 2,048 | Indexed | 0.052 | 0.109 | 0.039 | 0.160 | 0.017 |
| 2,048 | Segmented | 0.612 | 0.718 | 0.068 | 0.091 | unavailable |
| 16,384 | Scan | 0.718 | 1.402 | 0.675 | 1.443 | 0.625 |
| 16,384 | Indexed | 0.983 | 1.550 | 0.814 | 1.531 | 0.776 |
| 16,384 | Segmented | 8.330 | 9.296 | 0.138 | 0.493 | unavailable |

At 16,384 entries, observed conventional write-lock waiting accounts for about
95% of Indexed write latency and 93% of Scan write latency. These full-range
readers hold the conventional read lock while materializing their results.
Segmented captures an immutable root instead, so that reader lifetime does not
hold the writer's publication gate. Its observed writer mean is about 5.9x
lower than Indexed here, but this is a bounded single-run observation, not a
confidence-tested speedup or a claim that internal waits are zero.

The tradeoff is substantial: Segmented's full-history read mean is about 8.5x
Indexed. The conventional range uses a flat list, O(log N + R), while the
current Segmented range individually addresses entries through persistent
order/location/segment structures, approximately O(log-squared N + R log N)
under normal hashing. Root capture does not remove that traversal cost.
Wall time for the 96 coordinated operations was 46.86 / 60.93 / 317.11 ms
for Scan / Indexed / Segmented at 16,384 entries. Thus Segmented isolates
writer latency better here but has worse observed aggregate completion time.
The barrier and validation are included in wall time; these are not peak
throughput/scaling or production-tail measurements.

### 17.3 Retained snapshots: copying cost versus immutable rewrite cost

Allocation columns sum eight timed captures or eight timed mutations. Managed
deltas compare explicit forced-GC phases and include shared harness/oracle
objects; they are observations, not exact object-graph retained sizes.

| Entries | Participant | Capture bytes | Mutation bytes | Held managed delta | Managed drop after release + GC |
| ---: | --- | ---: | ---: | ---: | ---: |
| 512 | Scan | 34,808 | 15,520 | 66,296 | 39,728 |
| 512 | Indexed | 34,784 | 77,176 | 65,488 | 31,344 |
| 512 | Segmented | 3,432 | 234,336 | 98,864 | 65,016 |
| 4,096 | Scan | 267,768 | 72,864 | 328,216 | 268,496 |
| 4,096 | Indexed | 267,744 | 134,520 | 331,600 | 268,496 |
| 4,096 | Segmented | 3,432 | 251,624 | 116,216 | 82,368 |
| 16,384 | Scan | 1,066,488 | 269,472 | 1,229,432 | 1,067,216 |
| 16,384 | Indexed | 1,066,464 | 331,128 | 1,228,624 | 1,067,216 |
| 16,384 | Segmented | 3,432 | 265,144 | 129,432 | 95,504 |

The conventional copy counter rises from 4,188 to 133,148 entry/anchor
references across the eight captures. This confirms O(G*N) copied slots for
G retained snapshots when N denotes the largest captured history (plus anchors);
payload strings are shared, not copied. More precisely, for N0 starting entries,
A unchanged anchors and one append per round, the copy count is
`G * (N0 + A) + G * (G - 1) / 2`, costing
`O(G * (N0 + A) + G-squared)` time and reference storage. Segmented capture
allocation stays at 3,432 bytes because it retains roots, while writes allocate
changed arrays and persistent paths. At 512 entries its total capture+mutation
allocation is **higher** than Indexed (237,768 versus 111,960 bytes); at 16,384
it is lower (268,576 versus 1,397,592 bytes). Small-history overhead matters.

Lower capture allocation does not establish lower capture latency: at 16,384,
mean capture time was 79.75 / 56.91 / 85.85 microseconds for Scan / Indexed /
Segmented. The Segmented admission/lease overhead remains. Normal release plus
100 ms did not show a managed-memory drop in these cases; forced GC did.
This supports eventual reclamation of incremental structures, not prompt
physical-page return. Segmented retained estimates returned to zero after
release. Its 216,369,176-byte held estimate at 16,384 conservatively charges
different complete roots despite extensive structural sharing; it is not the
129,432-byte measured incremental managed delta.

### 17.4 Deletion: the conventional end position does not escape O(N)

Mean microseconds per one-delete replay, with twenty fresh measured participants:

| Entries | Position | Scan | Indexed | Segmented |
| ---: | --- | ---: | ---: | ---: |
| 512 | Beginning | 48.28 | 60.06 | 308.19 |
| 512 | Middle | 34.56 | 96.55 | 436.86 |
| 512 | End | 40.53 | 79.01 | 97.11 |
| 4,096 | Beginning | 267.06 | 242.23 | 156.21 |
| 4,096 | Middle | 170.75 | 302.89 | 572.38 |
| 4,096 | End | 369.07 | 325.43 | 93.68 |
| 16,384 | Beginning | 668.99 | 1,007.29 | 282.09 |
| 16,384 | Middle | 847.34 | 826.92 | 395.22 |
| 16,384 | End | 794.27 | 771.70 | 112.62 |

Every conventional deletion inspected N entries and rebuilt N-1 locations,
including end deletion: 512/511, 4,096/4,095 and 16,384/16,383. That direct
mechanism evidence establishes the whole-history maintenance, independent of
timing noise. Segmented rewrites the affected bounded segment and persistent
paths, without rebuilding all session locations; end deletion avoids shifted
locations inside that segment. At 16,384, its observed end-delete mean is
6.85x lower than Indexed, but it allocates 24,688 versus 4,320 bytes. Beginning
and middle Segmented deletion allocate about 162 KB because surviving entries
within that segment need offset/index-path work.

These are not monotonic timing curves: the Segmented 4,096-middle mean is
572.38 us but median 177.70 us, versus 395.22 / 196.20 us at 16,384. Short
iterations, pauses and process/JIT variation affect means. The reliable
complexity evidence is the conventional loop count, not a fitted timing slope;
no statistically significant crossover size is claimed.

### 17.5 Index maintenance versus payoff

Mean milliseconds per twenty-action replay; setup excluded:

| Changed characters | Searches | Scan | Indexed | Segmented |
| ---: | ---: | ---: | ---: | ---: |
| 128 | 0% | 0.025 | 0.173 | 1.024 |
| 128 | 50% | 38.893 | 8.126 | 15.883 |
| 128 | 90% | 56.286 | 9.423 | 9.665 |
| 8,192 | 0% | 0.025 | 2.261 | 3.777 |
| 8,192 | 50% | 33.928 | 11.656 | 13.638 |
| 8,192 | 90% | 55.653 | 10.985 | 12.489 |
| 32,768 | 0% | 0.020 | 11.905 | 10.459 |
| 32,768 | 50% | 33.474 | 12.970 | 15.631 |
| 32,768 | 90% | 58.018 | 11.007 | 12.679 |

Scan wins the observed write-only profiles: with immutable TextContent already
constructed outside timing, it does not tokenize/index changed text. Allocation
remains 14,496 bytes per twenty-write replay. Indexed allocation rises from
84,296 to about 6.45 MB as changed text grows from 128 to 32,768 characters;
Segmented rises from about 455 KB to 6.81 MB. Both indexed designs tokenize
new and old text and maintain postings. Repeated filler words keep vocabulary
small but do not remove O(changed characters) scanning/temporary-word allocation.
Segmented also pays bounded segment copying, persistent paths and admission.
The 32,768-character write-only Indexed/Segmented means reverse their usual
order, but overlapping/noisy samples do not establish Segmented superiority.

Indexed has the lowest observed mean in all six search-bearing profiles.
Scan repeatedly tokenizes the full applicable history; its allocations are
46.66-79.11 MB per search-bearing replay, versus Indexed's 9.24-12.36 MB.
However, a broad query still materializes and sorts all candidates before
taking the bounded result count in both indexed implementations. Thus an
inverted index does not make these broad searches constant-time or allocation
free. Segmented's persistent candidate addressing adds overhead; the 128-char,
90%-search means (9.423 versus 9.665 ms) are too close to treat as a reliable
ordering from this run alone.

Measured initial construction at 1,024 entries ranged across these cases from
0.36-0.62 ms / 166,560 bytes for Scan, 9.39-15.82 ms / about 4.86 MB for Indexed,
and 20.59-27.18 ms / 11.61-11.99 MB for Segmented. Those costs were measured
separately, not hidden inside replay or treated as amortized away. This workload
does not identify the break-even search percentage between 0 and 50%, nor
generalize to different query selectivity, vocabulary or history sizes.

### 17.6 Admission: compare guarantees before speed

All three enforced the common two-read count limit. The third read rejected
after 105.82-112.58 ms against a configured 100 ms timeout. Releasing a held
reader after a requested 10 ms delay allowed the waiter to complete in
16.90-22.13 ms; scheduler/timer overhead prevents interpreting that as 10 ms
service time.

A separate retained-byte limit of 1,283,097 bytes rejected Segmented's read
of a new root while an older root remained held (110.21 ms). Conventional
reads completed because that policy is absent. With a nominal resident
estimate budget of 1,809,100 bytes, Segmented accepted one 32,768-character
append and rejected seven (mean rejected request 106.50 ms). After releasing
the old reader, one more append succeeded. Both conventional participants
accepted all eight appends despite receiving the same option values.

These successful conventional writes are **not a performance victory**: they
do not enforce the policy and complete more logical growth. Conversely,
Segmented rejection is not free: speculative preparation and caller-created
payloads can allocate before admission rejects. Raw managed/private/working-set
growth is recorded, but differing accepted work and GC schedules prohibit an
equivalent-memory-efficiency ranking. No finite write-gate timeout experiment,
hard heap-cap guarantee, cancellation or fairness guarantee was established.

**Decision supported by this run:** Indexed remains a strong search-bearing
mutable baseline, but it is not universally faster and is not contract-equivalent
to the owning Segmented implementation. Long-reader writer waiting, O(G*N)
snapshot copies, unconditional O(N) deletion maintenance, changed-text indexing
cost and absent byte admission are concrete promotion costs. No default or
first-class production implementation is promoted on this evidence alone.

### 17.7 Architecture decision following pressure evaluation

Retain the Segmented realization; do not promote the conventional Indexed
adapter to a production implementation or default. Indexed remains a benchmark
reference. The higher full-history read latency is an accepted architectural
tradeoff for immutable reader isolation, bounded segment rewrites, structurally
shared snapshots and explicit resource admission.

The pressure experiments are more informative for this decision than the
earlier limited finite-replay rankings: they expose costs that those rankings
did not exercise. The objective is scalable behavior across these competing
pressures, not winning every isolated operation. This is a design choice
supported by the observed mechanisms, not a demonstrated latency bound,
arbitrary-scale throughput guarantee or hard process-memory cap. Existing
measurement limitations and small-history overhead findings remain applicable.

## 18. Independently scheduled sustained mixed-load ramp

The next harness implements the bounded starting point from the sustained-load
requirements: randomized repetitions of hot/distributed traffic, first without
and then with slow retained readers. `--ramp` starts one fresh child per case;
`--ramp-case` is the isolated entry point. Production storage/defaults are
unchanged. This is not a long-running exhaustion test.

### 18.1 Workload, scheduling and stop contract

Default matrix: three participants, one hot versus four distributed sessions,
normal versus slow readers, two repetitions shuffled with seed 1729 (24 cases).
The total initial population is fixed at 2,048 entries: one 2,048-entry session
or four 512-entry sessions. Total offered traffic is unchanged. **Distributed
full-history reads therefore return fewer entries per request.** Any benefit
combines smaller per-session work with isolation; it cannot be attributed
solely to lock sharding or called linear scaling.

One dedicated producer follows absolute monotonic deadlines at 100 / 500 /
1,500 requests/sec. Stage duration defaults to 1,500 ms and is configurable
with `--stageMs`; the executed comparison below uses 2,000 ms. Four dedicated
workers consume a FIFO bounded at 64 requests. A late producer catches up
without waiting for a worker, recording scheduling lag and queue rejection.
Millisecond sleeps avoid a busy-wait loop but can produce bursts. Queue delay
starts at actual offering; end-to-end latency starts at the scheduled deadline,
so scheduler lateness is visible rather than hidden in execution time.

The deterministic twenty-request mix is 40% bounded range, 5% full history,
15% search, 5% scoped-memory reads, 15% corrections, 10% appends, 5% deletes
and 5% confirmed-memory updates. Some corrections intentionally use a stale
revision. Deletions address distinct initial entries that are neither the
correction target nor memory-provenance endpoints. Mutations race without
retries; conflicts remain separate terminal outcomes. Memory revision lookup
is included in memory-write execution time.

Slow readers capture at offsets 0 / 50 / 100 ms of each 500 ms cycle and
release at offsets 200 / 275 / 350 ms. Their actual revision and first entry
must remain unchanged through the hold. Captured session/revision pairs,
rejections and releases are retained as evidence. Actual wake times can vary;
the final drain always disposes remaining leases.

Resource policy: four maximum retained reads, 10 ms storage admission timeout,
32 MiB estimated resident budget and 16 MiB estimated retained budget.
Conventional byte guarantees remain absent. Per-child safety limits are 20,000 planned
requests, 256 MiB sampled managed memory, 512 MiB sampled private bytes,
three-second normal drain and a 120-second child deadline. The memory sampler
runs every 50 ms: it is a stop signal, not a hard heap cap. On drain timeout,
queued requests are cancelled, in-flight synchronous calls receive a bounded
additional drain, and the child deadline remains the final backstop.

### 18.2 Counters, correctness and lifecycle scope

Each offered request has exactly one terminal record. Queue admission is not
storage admission. `Completed` counts admitted, non-cancelled attempts;
`Succeeded` counts successful reads/applied mutations. Conflicts, storage
rejections, queue rejections and queued cancellation are reported separately.
Stage boundaries record queue depth, in-flight count and cumulative terminal
count. Late completion remains attributed to the request's offered stage;
boundary counters preserve evidence that it did not finish during that stage.

Raw records separate offered/scheduled time, queue delay and execution.
Empirical p95 requires at least 100 samples and p99 at least 1,000 per
stage/category/outcome; otherwise they are null. Neither is a confidence bound.
Allocation rate and GC pause-duration deltas include the worker/queue/sampler/
retention/evidence machinery. GC counts, last-GC heap size, current managed and
private bytes, held distinct session revisions and Segmented resource counters
are recorded. Released and 250 ms settled observations perform **no forced GC**.

Generation stamps and retained-reader stability are checked during load.
After timing, the independent semantic oracle streams accepted commands in
revision order. Every range/search observation is compared in full against
its session root; every memory observation against its independently captured
catalog revision. Final full sessions and scoped memory must equal accepted
history, detecting missing publications and partial/extra effects of rejected
writes. Session/catalog captures are not falsely treated as jointly atomic.

Synchronous production APIs have no cancellation token. Harness cancellation
stops production and cancels queued work, **not an admission call already in
progress**. Storage admission cancellation remains an explicit capability gap.
Comparative children use orderly drain before disposal because conventional
adapters do not promise concurrent owner disposal. A separate production-owner
test races disposal with an active admission waiter, checks its terminal
failure/drain and verifies that the previously issued lease remains readable.
This does not manufacture equivalent shutdown guarantees for the references.

### 18.3 Critical data structures and complexity

`BlockingCollection` over its FIFO gives O(1) expected enqueue/dequeue and
O(queue capacity) queued storage; offering is nonblocking. Thread-safe append
queues hold O(Q) command/terminal records for capped request count Q. Storing
materialized observations additionally costs O(total returned references and
characters), not O(queue capacity). Full-history reads can contribute
O(Qfull * Nmax) references; repeated memory results can contribute O(Qmemory *
Mmax). Shared immutable strings are not copied merely by logging references.
Those costs are included in measured process allocation and memory stops.
These are structural/amortized bounds, not synchronization or scheduler-wait
bounds. The suite parent also retains parsed child reports for final JSON
aggregation, costing O(total case evidence); the per-child stop limits and
reported child-memory peaks do not impose a parent-process memory cap.
Larger campaigns should stream a report index rather than extrapolate this
small fixed matrix's parent footprint.

The retainer holds at most three leases; checking its list and distinct
generation count is O(1) in this configuration, plus each participant's lease/
first-entry operations. Underlying range/search/write complexities remain
those in section 14. A bounded arrival queue does not bound synchronous call
latency, root footprint or lifetime identity metadata.

Post-measurement grouping/sorting costs O(Q log Q), plus full-value oracle
replay. Streaming one oracle avoids retaining O(Q * N) complete historical
roots. Its deliberately simple transaction-copy implementation has a
conservative O(W * Nmax * log Nmax) bound for W accepted session writes,
plus per-query scan/sort and returned-value comparisons. None of that oracle
work is counted as a participant's execution or allocation-rate measurement.

The measured owner starts from untouched fixtures. Three searches warm a
separate owner; other operation paths can still encounter first-use/tiered
JIT effects, particularly in the first low-rate stage. A few seconds of
growth/release cycles can expose failures and overload but cannot establish
long-term heap stability, a universal maximum sustainable rate or an SLA.

### 18.4 Repeated comparison: observed results

The initial implementation/pressure work was committed as
`33841fc2b96cf8291b562b0f4f3f20cd58ca92da` before this harness was added.
The new comparison used Release/net9.0, .NET 9.0.22 and SDK 9.0.320:

```powershell
dotnet benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --ramp --stageMs 2000 --output TestResults\LlmContext\SustainedRamp-20261111-015747-24640d1b\Cases
```

All 24 isolated cases completed their planned duration and passed correctness,
retaining **100,800 requests**. All 36 measured source/configuration hashes
matched across cases and current files; the Git index and power plan were
unchanged. Only this excluded documentation was updated during measurement.
Exact commands/status are in `run-before.json` / `run-after.json`; raw requests,
resources and lease events are in `Cases`; `analysis.json` and
`stage-summary.csv` contain verified aggregation.

At 1,500 requests/sec, each row below offered 3,000 requests per repetition.
Ranges show the two observed repetitions, not confidence intervals. Execution
means include successful, conflicted and storage-rejected admitted attempts;
they must not be interpreted as successful-operation latency rankings.

| Participant | Sessions | Slow readers | Queue rejected | Storage rejected | Conflicted | Mean queue ms | Mean execution ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Scan | Hot | No | 233-247 | 0 | 228-250 | 23.980-28.832 | 2.732-2.826 |
| Scan | Hot | Yes | 131-243 | 49-61 | 197-235 | 21.130-25.529 | 2.594-2.843 |
| Scan | Distributed | No | 0 | 0 | 31-36 | 1.014-1.205 | 0.465-0.585 |
| Scan | Distributed | Yes | 0 | 0-3 | 35-38 | 1.071-1.462 | 0.570-0.760 |
| Indexed | Hot | No | 0 | 0 | 219-240 | 0.413-0.444 | 0.173-0.180 |
| Indexed | Hot | Yes | 0 | 0 | 220-247 | 0.327-0.440 | 0.165-0.184 |
| Indexed | Distributed | No | 0 | 0 | 61-62 | 0.106-0.118 | 0.041-0.054 |
| Indexed | Distributed | Yes | 0 | 0 | 40-57 | 0.122-0.159 | 0.063-0.071 |
| Segmented | Hot | No | 0 | 0 | 296-315 | 0.134-0.135 | 0.118-0.120 |
| Segmented | Hot | Yes | 0 | 0 | 311-327 | 0.325-0.361 | 0.218-0.221 |
| Segmented | Distributed | No | 0 | 0 | 52-56 | 0.112-0.159 | 0.058-0.069 |
| Segmented | Distributed | Yes | 0 | 1-2 | 36-40 | 0.191-0.226 | 0.088-0.104 |

**Scan:** hot-session search repeatedly tokenizes the full growing history.
Observed whole-case allocation was 811-814 MB/sec without slow readers, versus
64-65 MB/sec Indexed and 69-70 MB/sec Segmented. Corresponding hot/no-slow
GC pause totals were 353-361 / 41-43 / 50-53 ms over approximately six seconds.
The high transient allocation and read-lock duration are consistent with Scan's
queueing/overflow, not a retained-object leak. Distributed Scan has less text
per search/full read and independent session locks; it avoids queue overflow
here and allocates about 221 MB/sec. These data do not isolate the contributions
of those two changes.

**Indexed:** indexing avoids repeated history tokenization and its mutable
point-write path avoids persistent rewrite work. No queue or storage rejections
occurred in its tested profiles. At the hot/no-slow high stage it completed
2,760-2,781 useful reads/applied writes, versus Segmented's 2,685-2,704: the
lower Segmented aggregate execution mean is not evidence of more useful work.

**Segmented:** bounded reads and immutable-root isolation keep observed queueing
low in this mix, but speculative preparation leaves more opportunities for
revision conflicts under a hot writer stream. That is consistent with the code,
not a causal attribution proven by two runs. Intentional stale requests and
natural conflicts are distinguishable in raw categories. Slow readers increase
its hot-stage mean queue/execution times, despite zero rejection there; cheap
capture does not eliminate accounting, retained-generation or rewrite costs.

**Slow readers and recovery:** all final held-lease counts were zero; all
Segmented final retained-read counts and estimated retained bytes were zero.
Occasional distributed read-admission failures occur under the common count
limit; conventional byte enforcement is still absent. Whole-child sampled
managed memory peaked at 26.99 MiB and private bytes at 50.03 MiB, below stop
limits. Normal post-release managed memory can still include growing active
history and retained benchmark observations. These few seconds do not establish
long-term stabilization or immediate heap/page reclamation.

**Clock and tails:** high-stage scheduling p95 was around 15 ms. Consequently
many end-to-end tails reflect producer wake granularity, not storage execution.
Exactly 24 stage/category/outcome groups reached the 1,000-sample p99 threshold;
other p99 fields are null. A nonempty boundary queue may reflect a wake burst,
not a growing backlog; Scan's actual queue rejections provide stronger overload
evidence. Indexed/Segmented having no queue rejection at 1,500 does not identify
their maximum sustainable rate. A separate bounded higher-rate probe follows.

### 18.5 Higher-rate bounded probe

The source-identical follow-up uses 1,500 / 5,000 / 10,000 requests/sec for
one second each, one randomized repetition (12 isolated cases). Queue capacity
is 256 rather than 64 so a roughly 15 ms producer wake burst at 10,000/sec
does not automatically overflow an otherwise idle queue. This is a different
queue policy and a shorter exploratory run, not another repetition of section
18.4 or proof of a sustainable ceiling.

```powershell
dotnet benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --ramp --rates 1500,5000,10000 --stageMs 1000 --queue 256 --repetitions 1 --output TestResults\LlmContext\SustainedRamp-High-20261111-020622-2e878ee1\Cases
```

All 12 cases passed, retaining **198,000 requests**. At the 10,000/sec stage,
each row offered 10,000 requests. Useful completions below include work that
finishes during the final drain, not necessarily before the one-second boundary.

| Participant | Sessions | Slow readers | Queue rejected at 5K | Queue rejected at 10K | Useful at 10K | Conflicted at 10K | Mean queue ms at 10K |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Scan | Hot | No | 4,214 | 9,194 | 741 | 65 | 303.716 |
| Scan | Hot | Yes | 3,882 | 8,424 | 1,455 | 97 | 155.289 |
| Scan | Distributed | No | 1,305 | 3,453 | 6,451 | 96 | 32.237 |
| Scan | Distributed | Yes | 1,820 | 3,627 | 6,271 | 87 | 33.978 |
| Indexed | Hot | No | 0 | 0 | 9,245 | 755 | 3.393 |
| Indexed | Hot | Yes | 0 | 619 | 8,681 | 700 | 12.708 |
| Indexed | Distributed | No | 0 | 0 | 9,751 | 249 | 1.296 |
| Indexed | Distributed | Yes | 0 | 0 | 9,827 | 173 | 1.522 |
| Segmented | Hot | No | 0 | 0 | 9,550 | 450 | 3.998 |
| Segmented | Hot | Yes | 0 | 177 | 9,028 | 795 | 7.177 |
| Segmented | Distributed | No | 0 | 0 | 9,890 | 110 | 1.024 |
| Segmented | Distributed | Yes | 0 | 0 | 9,890 | 110 | 1.705 |

At 10K, slow-reader Scan also had 24 hot / 15 distributed storage rejections;
the other rows had none at that stage. At 5K, slow-reader Indexed-hot had two
storage rejections and Segmented-hot/distributed three/two. Raw statuses do
not distinguish count versus byte exhaustion, so those causes are not invented.
Segmented-hot/slow sampled retained estimates reached 16,760,704 bytes, close
to the configured 16 MiB estimate limit, but this alone does not classify an
individual rejection's cause.

Scan's queues were full at both high-stage boundaries in all four profiles.
Its two-second lower-rate run and this probe both expose overload, but cannot
locate a precise maximum between the tested points. Indexed/Segmented tolerate
the offered attempt stream better here; slow-reader hot cases expose additional
queueing and rejection. Distributed cases combine smaller histories with less
session contention, while the memory catalog and resource accounting remain
shared owner-wide. No linear independent-session scaling is established.

Do not interpret the hot Scan slow-reader row's higher useful count as a
slow-reader optimization: queue/admission rejection changes the served operation
mix, accepted growth and subsequent work. Likewise, the hot Indexed/Segmented
useful-completion ordering reverses from the lower-rate repetitions. Different
interleavings, conflicts, rejection and short windows prevent a universal
winner or a stable crossover claim.

All final lease counts were zero; Segmented retained estimates/read counts
returned to zero. All six slow-reader cases sampled three distinct retained
session generations simultaneously. Five captured/released all eighteen planned
leases; hot Scan captured/released fifteen and rejected three captures.
Sampled managed memory peaked at 48.73 MiB and private bytes at 75.41 MiB.
Maximum observed drain was 259.22 ms, within the three-second bound. No memory
or drain stop fired and no forced GC was used.

Scheduling p95 reached 15.61 ms and maximum lateness 40.76 ms. The raw due/
offered/queue/execution fields must be examined before attributing end-to-end
tails or transient backlog to storage. This is a shared-host experiment;
lightweight artifact inspection/aggregation overlapped portions of execution.
Neither it nor the shorter high-rate probe is a controlled capacity/SLA study.

### 18.6 Verification and remaining scope

The Release solution build succeeded; all **73 LLM tests passed on each of
.NET 8 and .NET 9** (146 executions). Eight new cases cover mixed histories
and release across participants/topologies, queue overflow, memory-stop safety,
harness cancellation/drain and production disposal racing blocked admission.
The solution formatter returned zero with its existing .NET 9 workspace-reference
warnings; independent changed-file whitespace verification and `git diff --check`
passed.

Across both runs, **36 isolated cases and 298,800 offered requests** passed
terminal-accounting and semantic checks. The same 36 source/configuration
hashes were verified across every child in both runs and against the working
files. No source was modified during measurement; documentation-only edits
are excluded from the measurement manifest. Git index and power plan remained
unchanged. Each artifact root retains exact commands, logs, raw observations,
stage aggregation and verification metadata.

## 19. Hot-writer preparation amplification experiment

The production default remains speculative session preparation. An internal
`SerializeSessionPreparation` option permits a controlled alternative without
adding public configuration or changing the memory-catalog policy. The benchmark
flag `--ramp --preparationCompare` selects only Segmented, both preparation
policies, hot/distributed sessions and normal/slow readers. Each repetition is
shuffled deterministically; each case uses a fresh isolated process.

### 19.1 Execution cycle and complexity

The speculative cycle is: capture root/check expected revision, prepare immutable
replacement state, acquire the existing per-session writer gate, recheck root
identity, admit resources and publish. A competing writer can invalidate a fully
prepared replacement. For W writers sharing a revision and preparation cost P,
this can consume approximately W*P preparation work although at most one wins.
Discarded arrays/persistent paths become garbage; they are not published roots.

The experimental cycle acquires that same gate before preparation, recaptures
the current root and checks the caller's unchanged expected revision. A stale
waiter returns a conflict without building replacement state. This reduces the
shared-revision preparation work to approximately P plus O(W) revision checks,
excluding waits/timeouts and the cost of the successful commit. It does not
rebase, retry or guarantee fewer genuine conflicts. Independent sessions retain
independent gates; readers never acquire the session writer gate.

The winning transaction's data-structure complexity is unchanged: changed bounded
segment arrays and persistent order/location/search paths are still constructed.
There is no new queue, batch merger, whole-history copy or resource index. Extra
per-call tracing is O(1); retained raw evidence remains O(request count), plus
returned values, as in section 18. Contention can keep up to W speculative
private preparations alive, whereas serialized preparation permits one per
session, but caller objects, old roots and independent sessions remain live.
This is not a bound on total process memory or synchronous waiting.

The tradeoff is head-of-line waiting: preparation, estimator callbacks and
resource admission now occupy the session gate. A slow callback or budget wait
can delay later writers or cause their existing bounded gate admission to reject.
The experimental option therefore cannot be promoted merely because late
conflicts disappear. Applied writes, useful completions, reader and successful
writer latency, waiting and all rejection classes must also be compared.
Estimator callbacks remain stable and non-reentrant; nested writes through an
estimator are unsupported.

### 19.2 Diagnostic boundaries and correctness

An optional internal thread-local diagnostic records initial/gated/prepared
revision conflicts, gate/resource rejection, invalid preparation and applied
mutations. Session and memory targets are separate; memory preparation remains
speculative under both session policies. Memory revision lookup precedes tracing
and can reject before a mutation sample exists.

Preparation/storage byte counters are current-thread managed allocation, not
retained or resident estimates. Storage timing starts inside the storage method,
excluding outer lifetime-lock/bridge entry. Gate timing measures acquisition,
not gate hold time. Resource duration includes accounting-lock acquisition,
budget waiting and publication bookkeeping; it is not pure lock contention.
Tracing allocates no diagnostic object or timer when disabled. In comparison
cases both variants enable the same timers/evidence overhead; process allocation
also includes caller objects, traces, queueing, sampler and retained observations.
Different successful histories can change subsequent read/search work, so a
process allocation difference is not exclusively saved preparation allocation.

The Release solution build passed and all **86 LLM tests passed on each of
.NET 8 and .NET 9** (172 executions). New checks include all seven finite
scenarios under the independent oracle, synchronized competing writers under
both policies, reader/independent-session progress, old-view/index stability,
strict stale handling, gate timeout before preparation, removal races, rejected
resource admission without publication, separate memory diagnostics and traced
mixed-load cases. Gates and thread-local diagnostics are released/cleared on
exception paths. The public expected-revision contract and production default
are unchanged.

### 19.3 Executed comparison and provenance

The sustained-load implementation was first committed as
`abb6d1b278b71e9eefe92ab64c409ed4e4998c54`. The experiment then ran against
that commit plus the uncommitted policy/diagnostic changes, using Release/net9.0,
SDK 9.0.320 and .NET 9.0.22. It uses direct-DLL out-of-process children, not BDN:

```powershell
dotnet D:\source\esp\benchmarks\ScalablePolymorphicArray.Llm.Benchmarks\bin\Release\net9.0\ScalablePolymorphicArray.Llm.Benchmarks.dll --ramp --preparationCompare --rates 1500,5000 --stageMs 1500 --queue 256 --repetitions 3 --output D:\source\esp\TestResults\LlmContext\PreparationPolicy-20261111-024944-aa0146d0\Cases
```

Both stages last 1.5 seconds, offering 2,250 and 7,500 requests respectively.
The existing mix, four workers, 2,048 total initial entries, 10 ms admission
timeout and 32/16 MiB resident/retained estimate budgets are unchanged. Only the
arrival schedule, queue capacity, repetition count and preparation comparison
selection differ from the default ramp. All **24 cases / 234,000 requests**
passed full-value oracle and terminal-accounting checks. All 2,352 deliberately
stale requests conflicted; there were no queue rejections or cancellations.
Every child completed its duration and released all leases; final retained
reads and estimated retained bytes were zero.

All **37 measured source/configuration hashes** matched across every child,
the suite and current files. Only this excluded documentation was edited during
measurement; Git index and active power plan were unchanged. Exact command and
dirty status are in `run-before.json` / `run-after.json`. The raw aggregate is
`Cases\suite.json`; per-case JSON/logs retain individual requests and phases.
`analysis.json`, `stage-summary.csv`, `latency-summary.csv`,
`mutation-phases.csv`, `case-summary.csv` and `verification.json` retain the
derived comparison and checks. The host is shared; lightweight evidence
inspection and documentation overlapped parts of execution, but no competing
builds/tests or source edits ran.

### 19.4 Allocation mechanism and useful work

Across each policy's 117,000 offered requests, speculative session preparation
discarded **136,762,432 bytes and 681.4692 aggregate preparation milliseconds**
in **4,082 prepared revision conflicts**. These are current-thread allocation
and summed, potentially overlapping operation durations, not retained memory
or wall-clock savings. Serialized session preparation had **zero** prepared
conflicts and discarded preparation bytes, instead recording 3,770 gated
conflicts and ten gate rejections before preparation.

Initial session conflicts were 1,410 speculative / 1,363 serialized, including
1,176 intentionally stale requests per policy. Session applied writes were
29,572 / 29,921; useful reads/applied mutations were 111,462 / 111,823. Thus the
observed aggregate improvement was modest, not elimination of CAS contention.
Storage rejections were 12 / 13: speculative had no session gate rejections;
serialized had ten, all in hot profiles. Neither policy had a session resource
rejection. The remaining storage rejections were read-retention admission,
including one memory-revision lookup per policy that rejected before tracing.
Memory-catalog prepared conflicts remained 13 / 11; its policy was unchanged.

The following byte costs pool all traced session storage allocations, including
unsuccessful calls, divided by applied session writes across three repetitions.
This is not allocation per successful call alone. Applied-write ranges show
the three observed repetitions, not confidence intervals.

| Sessions | Slow readers | Rate | Speculative bytes/applied | Serialized bytes/applied | Applied speculative | Applied serialized |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Hot | No | 1,500 | 45,261 | 27,828 | 383-398 | 416-427 |
| Hot | No | 5,000 | 29,379 | 23,296 | 1,827-1,880 | 1,892-1,909 |
| Hot | Yes | 1,500 | 46,138 | 27,116 | 376-387 | 396-415 |
| Hot | Yes | 5,000 | 32,622 | 24,648 | 1,645-1,667 | 1,651-1,698 |
| Distributed | No | 1,500 | 31,239 | 29,578 | 615-624 | 613-618 |
| Distributed | No | 5,000 | 20,425 | 20,063 | 2,160-2,170 | 2,161-2,168 |
| Distributed | Yes | 1,500 | 30,773 | 29,337 | 627-628 | 620-621 |
| Distributed | Yes | 5,000 | 20,293 | 19,843 | 2,161-2,168 | 2,158-2,165 |

**Hot, normal:** this is a strong allocation win: approximately 21-39% lower
storage bytes per applied write, and more applied writes in all three
repetitions at each rate. Speculative preparation loses because writers often
build from the same root. Serialization rejects those stale contenders before
the builder. It does not win every latency metric, as shown below.

**Hot, slow readers:** storage bytes per applied write fall approximately
24-41%. Immutable readers still do not hold the session gate, but retained
generations and read admission remain resource pressure. At 1,500, applied
write ranges improve; at 5,000 they overlap. Removing wasted preparation does
not remove resource pressure or guarantee a consistent useful-work increase.

**Distributed, normal:** the saving is only approximately 2-5%; there are few
late conflicts to eliminate. At 1,500 serialized applies slightly fewer writes,
and at 5,000 the ranges overlap. The original speculative policy is already
efficient in this contention regime.

**Distributed, slow readers:** the saving is approximately 2-5%, with slightly
fewer serialized applied writes at 1,500 and overlapping ranges at 5,000.
Count/retention admission and the shared memory catalog remain independent of
the session preparation gate. Neither distributed profile establishes a
scaling advantage because individual histories are smaller than in hot cases.

### 19.5 Waiting, latency, memory and decision

Observed successful session-write execution means, milliseconds per call:

| Sessions | Slow readers | Rate | Speculative mean range | Serialized mean range |
| --- | --- | ---: | --- | --- |
| Hot | No | 1,500 | 0.096-0.153 | 0.151-0.219 |
| Hot | No | 5,000 | 0.038-0.058 | 0.049-0.087 |
| Hot | Yes | 1,500 | 0.127-0.186 | 0.152-0.180 |
| Hot | Yes | 5,000 | 0.036-0.084 | 0.041-0.047 |
| Distributed | No | 1,500 | 0.176-0.276 | 0.142-0.262 |
| Distributed | No | 5,000 | 0.043-0.118 | 0.039-0.069 |
| Distributed | Yes | 1,500 | 0.237-0.369 | 0.170-0.214 |
| Distributed | Yes | 5,000 | 0.046-0.089 | 0.042-0.080 |

For hot/normal at 1,500, successful-write execution p95 ranged
0.287-0.327 ms speculative versus 0.325-0.561 ms serialized. Successful-read
execution means ranged 0.304-0.402 versus 0.335-0.478 ms; at 5,000 they ranged
0.209-0.301 versus 0.198-0.346 ms. Reader outcomes are therefore not uniformly
better, despite readers never taking the writer gate. Accepted operation mix,
larger accepted histories, shared scheduling/GC and first-use/tiered JIT effects
are possible contributors, not isolated causal findings.

Mean gate-acquisition duration across all hot/normal session calls increased
from approximately 0.0015 to 0.1529 ms at 1,500, and 0.0002 to 0.0280 ms at
5,000 (arithmetic means of the three per-case means, including zero duration
for calls rejected before gate acquisition). Most waiting was in losing
contenders: winning-call mean acquisition remained below 0.0011 ms. Consequently
the successful-write latency differences cannot simply be attributed to their
own gate wait. The ten new gate rejections demonstrate the head-of-line tradeoff.

Hot whole-case process allocation ranged 314-318 MB/sec speculative versus
302-307 MB/sec serialized; distributed cases were approximately 97 versus
96 MB/sec. These include all harness/evidence costs and different accepted
histories, not just preparation. Hot/normal GC pause totals overlapped:
143-191 ms versus 141-229 ms. A reliable GC-pause reduction is not established.
Sampled managed memory peaked at 38.80 MiB and private bytes at 59.90 MiB;
maximum drain was 8.683 ms. No memory/drain stop fired and no forced GC ran.
These short cycles do not establish long-term memory stability.

The direct driver emits no BDN short-iteration warning, but many individual
operations are sub-millisecond and instrumentation remains material. Each
category/outcome's sample count is retained; execution p95 requires 100
observations and p99 1,000. Producer scheduling p95 reached 15.59 ms, so
end-to-end tails must not be interpreted as storage latency. Stage useful
counts include later completion/drain; dividing by scheduled stage seconds
does not identify peak sustainable throughput. Three short repetitions and
empirical ranges are not confidence intervals or production SLAs.

**Decision:** retain serialized preparation as an internal experimental
alternative, not a new default. The experiment directly validates elimination
of wasted session preparation and a meaningful hot-session allocation benefit,
with modest observed useful-work gains. It also exposes gate rejection and
mixed latency/distributed outcomes. More contention-specific policy refinement
and longer controlled tail measurements would be needed to justify changing
the production default; automatic retries/rebasing remain out of scope.

## 20. Independent useful-preparation indexing optimizations

The completed preparation-policy experiment was committed as
`87207720941c02ef0a98703d23f2b7733df56399` before starting these changes.
The production writer policy remains speculative; serialized preparation stays
internal/experimental. No new gate, retry, pooling, GC setting, dependency or
caller-owned selection policy was introduced.

### 20.1 First change: local checked accounting

`ContextStateBuilder.Index` previously constructed one intermediate state record
per distinct term solely to update `EstimatedBytes`, then another to install
the search dictionary. It now starts a local total from the same estimate,
applies the same checked addition after every membership/header delta, and
installs the search dictionary and estimate together. Checked arithmetic is
not deferred to a single unchecked accumulated delta.

This removes O(U) state-record allocations for U processed terms, without
changing tokenization, dictionary/postings updates, estimator calls or the
published accounting result. Persistent collection path copying remains.
The local variables are private to the transaction; no published root or
callback-observable state is mutated. Overflow/validation failure still
prevents publication of the complete transaction.

This version was built, tested and measured before implementing term diffing.
The Release solution build and **91 tests per runtime / 182 executions** passed.
New accounting tests cover unchanged/shared terms, duplicate words, disappearance
of a final membership/header, empty text, failure rollback and checked
addition/subtraction boundaries.

### 20.2 Second change: retain unchanged memberships

Entry replacement now tokenizes the old/new text with the unchanged lexical
policy and excludes their common terms before changing postings. Both normal
segment replacement and the coalesced replacement-only path use this operation.
Append/deletion and anchor relocation retain their full add/remove paths:
an anchor's canonical start address can change and must not be silently retained.
Role/timestamp-only changes with the identical immutable content object still
skip lexical work as before.

`Terms` already returns distinct ordinal-sorted arrays. Two linear exclusion
passes avoid allocating an additional set. All obsolete memberships are removed
before new ones are added, preserving decrease-before-increase checked
accounting. Unchanged memberships retain their actual immutable postings
objects; a lexically equivalent replacement retains the whole search root.
Snippets are still materialized from the newly published entry, not cached in
the retained posting, so unchanged terms do not imply stale result text.

For C changed characters, U total distinct old/new terms, maximum term length L,
T indexed terms, P relevant posting-set size and X changed memberships, the
lexical work remains approximately O(C + U log U * L) expected, followed by
O(U * L) exclusion comparisons. Normal persistent path work changes from
O(U * (L + log T + log P)) to O(X * (L + log T + log P)). These are normal
hashing/tree bounds; pathological collisions can add bucket traversal work.
Both lexical arrays now coexist, costing O(C + U) temporary storage in total;
there is no extra diff hash set. Changed persistent paths, segment arrays and
estimator work remain additional costs. With no common terms, X equals U and
the exclusion comparisons are extra work, not a universal CPU optimization.

Only the private builder changes; publication is still one immutable session
root with its matching index. Segment limits, identities, sequence assignment,
per-command validation, resource admission and disposal behavior are unchanged.
The Release build and **99 tests per runtime / 198 executions** passed.
New cases directly verify postings/root reference sharing, repeated batch edits,
case/Unicode/deduplication behavior, all three replacement paths, canonical
entry/anchor ordering, refreshed snippets and retained reads after disposal.
The existing oracle, admission, rollback, concurrency and disposal tests also
remain enabled. Formatting verification passed; the solution formatter still
reports its known .NET 9 workspace-reference warnings despite successful
SDK 9 compilation/tests. Independent whitespace and Git diff checks passed.

### 20.3 Workloads, source identity and artifacts

Evidence root:
`TestResults\LlmContext\IndexOptimizations-20261111-031346-d08929c6`.
The phases are `Baseline`, `LocalDeltas`, and `TermDiff` (the latter includes
the already measured local-accounting change). Each phase preserves its
`ContextState.snapshot.cs`, source/binary hashes, commands and before/after
commit, dirty-file, Git-index and active-power-plan metadata.

The baseline was captured from clean commit `8720772`. Its 37 measured
source/configuration hashes exactly match the preceding preparation-policy
experiment. Consequently its twelve speculative-policy load cases were
**reused, not freshly executed**: their raw JSON/logs were copied unchanged,
and original paths/checksums are retained in `reused-evidence.json`. The load
baseline is source-identical but non-contemporaneous; it is not an interleaved
control. Each new optimization then ran those exact case descriptors/order in
fresh .NET processes. Only `ContextState.cs` differs among measured production/
benchmark source manifests; the additional tests are outside that manifest.

All phases use Release/net9.0, SDK 9.0.320 and .NET 9.0.22, invoking the
existing direct-DLL `--pressure-case` and `--ramp-case` entry points. There is
no benchmark-source or workload-semantics change and no BDN toolchain fallback.
The artifact-only `run-index-optimization.py` coordinates these existing cases;
`commands.json` records every complete argument vector.

Fixed-work cases: nine Segmented index-payoff profiles, 1,024 seeded entries,
128 / 8,192 / 32,768 changed characters and 0 / 50 / 90% searches in a
twenty-action replay. Every case has five warmups and twenty measured replays
with fresh participant initialization each time. Setup allocation is separate;
full-value oracle and final-entry checks remain outside replay timing.

Mixed load: twelve cases per phase, hot/four distributed sessions,
normal/slow retained readers, three repetitions, four workers, queue 256,
1,500 then 5,000 offered requests/sec for 1.5 seconds each. Each phase retains
117,000 terminal requests. Mutation tracing remains enabled and session versus
memory-catalog preparation remains separate. Queue, resource and memory limits,
operation mix, strict expected revisions and no-retry behavior are unchanged.

All 27 fixed-work cases and all 36 load evidence cases passed. This includes
24 freshly executed load cases / 234,000 new requests plus twelve reused
baseline cases / 117,000 requests. Three additional unchanged-source timing
checks retain their own logs/raw samples in `TimingCheck`. No measured source
or binary changed within any phase; no concurrent build/test or machine-wide
setting change occurred. Lightweight inspection/analysis used the shared host.

Raw aggregates are in each phase's `Finite\suite.json` and `Ramp\suite.json`;
individual case JSON retains all observations. Root `analysis.json`,
`finite-summary.csv`, `ramp-summary.csv`, `category-summary.csv` and
`resource-summary.csv` retain comparisons. Execution/analysis scripts and
verification are retained alongside them.

### 20.4 Fixed-work allocation: benefit follows the writing fraction

Mean current-thread managed bytes per complete twenty-action replay, excluding
fresh initialization but including common replay consumption/result materialization:

| Changed characters | Searches | Baseline | Local accounting | Plus term diff |
| ---: | ---: | ---: | ---: | ---: |
| 128 | 0% | 447,822 | 444,578 | 347,657 |
| 128 | 50% | 9,441,795 | 9,427,071 | 9,383,323 |
| 128 | 90% | 9,274,383 | 9,272,127 | 9,265,991 |
| 8,192 | 0% | 2,030,786 | 2,012,371 | 1,920,634 |
| 8,192 | 50% | 10,205,108 | 10,201,111 | 10,152,691 |
| 8,192 | 90% | 9,397,639 | 9,395,076 | 9,388,568 |
| 32,768 | 0% | 6,820,911 | 6,798,737 | 6,712,837 |
| 32,768 | 50% | 12,545,637 | 12,528,521 | 12,487,780 |
| 32,768 | 90% | 9,765,755 | 9,763,294 | 9,757,555 |

Local accounting alone reduces observed replay allocation by approximately
0.02-0.91%. At 128 characters/write-only, term diffing adds a 21.80% reduction
relative to local accounting; the combined reduction from baseline is 22.37%.
The combined write-only savings shrink to 5.42% at 8,192 characters and
1.58% at 32,768: unchanged tokenization/string work grows with text size.
At 50% searches the combined savings are only 0.46-0.62%; at 90% they are
0.08-0.10%. Output materialization/search/replay work dominates those totals;
this is not evidence that posting preservation stopped working.

Allocation attribution is supported by source-isolated phases, fixed accepted
work and the separate storage-preparation counters below, not an allocation
stack profiler. Per-process randomized string hashing can change persistent
tree shape/allocation, so the exact byte delta is not a measured state-record
size or a guarantee for every document. Initialization also benefits from
local accounting but is deliberately not folded into steady-state replay savings.

### 20.5 Mixed load: useful preparation versus conflicts

The following byte costs include **only preparation of applied session writes**,
weighted by their actual counts across three repetitions. They exclude caller/
harness objects and discarded work, but can still vary with accepted
append/correction/delete mix and growing histories.

| Sessions | Slow readers | Rate | Baseline bytes/applied | Local accounting | Plus term diff | Applied baseline | Applied final |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Hot | No | 1,500 | 24,783 | 24,610 | 23,127 | 383-398 | 389-458 |
| Hot | No | 5,000 | 24,052 | 23,808 | 22,142 | 1,827-1,880 | 1,859-1,894 |
| Hot | Yes | 1,500 | 25,071 | 24,852 | 23,466 | 376-387 | 376-409 |
| Hot | Yes | 5,000 | 23,310 | 23,167 | 21,830 | 1,645-1,667 | 1,613-1,723 |
| Distributed | No | 1,500 | 27,439 | 27,390 | 26,052 | 615-624 | 615-626 |
| Distributed | No | 5,000 | 20,216 | 20,083 | 18,797 | 2,160-2,170 | 2,163-2,169 |
| Distributed | Yes | 1,500 | 28,213 | 28,173 | 27,357 | 627-628 | 624-642 |
| Distributed | Yes | 5,000 | 20,061 | 19,861 | 18,452 | 2,161-2,168 | 2,162-2,167 |

Local accounting lowers useful preparation allocation approximately 0.14-1.02%;
the combined change lowers it 3.03-8.02%. Pooling by mutation category gives
13,394 / 13,234 / 10,599 preparation bytes per applied correction across the
three phases: about 20.87% less than baseline, or 19.91% less than local
accounting alone. Appends remain approximately 18,096 / 17,941 / 17,866 and
deletes 61,960 / 61,605 / 61,857. That concentration in replacements matches
the term-diff mechanism; the latter two categories were not given a diff path.
These are observed category means, not identical per-command allocations.

| Terminal measure | Baseline | Local accounting | Plus term diff |
| --- | ---: | ---: | ---: |
| Offered requests | 117,000 | 117,000 | 117,000 |
| Successful reads/applied mutations | 111,462 | 111,256 | 111,719 |
| Applied session writes | 29,572 | 29,367 | 29,839 |
| Applied memory writes | 5,809 | 5,812 | 5,793 |
| Conflicted attempts, both targets | 5,526 | 5,726 | 5,275 |
| Session conflicts after preparation | 4,082 | 4,281 | 3,768 |
| Storage rejections | 12 | 18 | 6 |
| Session gate/resource rejections | 0 / 0 | 0 / 0 | 0 / 0 |
| Queue rejected / cancelled | 0 / 0 | 0 / 0 | 0 / 0 |

Storage rejections here were read-retention admission, not a new writer-gate
policy. All deliberate stale writes were rejected. Memory-catalog prepared
conflicts were 13 / 12 / 24; that code and admission domain are unchanged.
Completed conflicts/refusals are not counted as useful work.

**Hot, normal:** reduced correction cost and fewer observed late conflicts are
consistent with a shorter speculative preparation window, but not a proven
causal throughput increase. Final applied counts overlap baseline ranges;
aggregate success is not a capacity measurement. The local-only phase actually
had fewer applied writes despite slightly cheaper useful preparation.

**Hot, slow readers:** useful preparation also becomes cheaper, but at 5,000
final applied counts range 1,613-1,723 versus baseline 1,645-1,667: the result
is mixed, not a consistent win. Retention and scheduling are independent
pressures that term diffing does not remove.

**Distributed, normal:** there are few natural conflicts to eliminate, yet
useful preparation still falls approximately 5-7%. That distinguishes this
change from serialized preparation's chiefly hot-contention benefit. Applied
write ranges overlap; no scaling/throughput claim follows.

**Distributed, slow readers:** useful preparation falls approximately 3-8%.
Its 1,500 profile has the smallest gain because accepted mix/retention varies;
5,000 benefits more. Applied ranges still overlap. Comparing distributed
against hot also changes per-session history size, so neither establishes
linear scaling.

### 20.6 Timing, GC, retention and verdict

Timing is **not a demonstrated universal improvement**. In the fixed-work
write-only cases, baseline/local/final means were 0.778 / 1.150 / 1.031 ms
at 128 characters, 3.231 / 3.223 / 4.472 ms at 8,192, and
9.428 / 10.061 / 15.358 ms at 32,768. The final 128-character/50%-search
mean was 21.046 ms versus baseline 12.012 ms. Those regressions are retained,
not removed as inconvenient outliers.

A bounded unchanged-source recheck of those latter three affected cases
produced 13.420 ms (128/50%), 2.985 ms (8,192/write-only), and
12.514 ms (32,768/write-only). The large variation shows that the initial
timing penalties are not stable, but the large-text recheck remains slower
than baseline. It does not rule out a CPU regression. These sequential,
short, shared-host process samples are not a controlled paired test or
statistically reliable speedup/regression estimate.

Likewise, hot/normal successful-writer means at 5,000 ranged
0.038-0.058 ms baseline versus 0.031-0.127 ms final; successful-reader means
ranged 0.209-0.301 versus 0.221-0.552 ms. Their p95/sample counts and separate
queue/execution fields remain in the CSV/raw reports. Lower allocation is
not an established lower tail latency; no new SLA is claimed.

Whole-case hot process allocation was approximately 314-318 MB/sec baseline,
314-316 local-only and 312-315 final; distributed was approximately
97, 96-98 and 95-96 MB/sec. These include traces, materialized outputs,
samplers and different accepted histories, not just storage preparation.
Hot/normal GC pause totals were 143-191 / 147-197 / 149-386 ms:
no general pause improvement is supported. Reduced allocation must not be
misreported as reduced GC latency.

Every load case finished its planned duration with no memory/drain stop and
returned held leases, retained-read counts and estimated retained bytes to
zero. Sampled managed memory stayed below 40 MiB and private bytes below
60 MiB; conservative retained estimates stayed within the configured 16 MiB
limit. No forced GC ran. This confirms bounded-run recovery, not long-term
heap stabilization or immediate physical-page reclamation.

The direct driver has no BDN iteration warning, but many calls remain
sub-millisecond and instrumentation/first-use/tiered JIT effects matter.
Empirical category/outcome p95 requires 100 observations and p99 1,000;
three repetition ranges are not confidence intervals. Producer wake granularity,
non-contemporaneous baseline, process hash randomization and accepted-work
differences remain limitations.

**Narrow verdict:** the observed workloads allocate less managed memory during
successful correction preparation, chiefly by avoiding unchanged posting
rewrites. This is not an unconditional performance improvement, a claim of
broadly faster execution, or evidence of lower GC overhead. Useful-work gains
and timings are mixed. The consistency/lifetime contract and writer-admission
policy remain unchanged. The alternating large-text check below tests the
previously unresolved timing comparisons rather than assuming allocation
savings imply faster execution.

### 20.7 Alternating large-text baseline/optimized recheck

The follow-up retains the original `8720772` baseline and the current optimized
variant containing **both local accounting and TermDiff**, matching the earlier
timing comparison. It is not a new experiment isolating TermDiff from local
accounting. No production code, workload, dependency manifest or writer default
was changed for this recheck.

Artifacts:
`TestResults\LlmContext\TermDiff-Alternating-20261111-034446-4330ce50`.
Each variant has its own source tree with the corresponding 37-file manifest
and an SDK 9.0.320 Release/net9.0 build. The benchmark harness and dependencies
are **byte-identical** across variants; only the LLM implementation DLL/PDB
differ. Sources and binaries were verified unchanged after measurement.
The isolated builds initially needed their missing project assets restored;
the NETSDK1004 and successful restore/build logs are retained. This is not a
BDN generated-project failure or an in-process fallback. Sources/binaries are
intentionally retained as reproducible evidence, not substituted into the
working-tree build.

For each of 8,192 / 32,768 changed characters and 0 / 50 / 90% searches, six
adjacent process pairs execute the existing index-payoff case: twenty actions,
1,024 seeded entries, five warmup replays, twenty measured replays and a fresh
participant before every replay. Pair order is balanced: baseline-first in
three rounds and optimized-first in three, with the profile order shuffled
using seed 1729. This gives **72 cases / 36 pairs / 1,440 measured replays**,
plus 360 warmup replays. Every oracle, digest and final-value check passed.

Exact CLI argument vectors and order are in `commands.json` and `schedule.json`;
`run-alternating-index.py` is the artifact-only coordinator. Individual raw
reports/logs are in `Cases`; `suite.json` is the full raw aggregate.
`analysis.json`, `case-summary.csv`, `paired-summary.csv` and
`profile-summary.csv` retain process-case and paired statistics. Build/source/
binary identity and repository/index/power-plan verification are retained too.

The timing unit below is **milliseconds per complete finite replay**, not per
request. Means average six process-case means, each based on twenty replays.
Paired ratios divide optimized by baseline within each adjacent pair; below
one means optimized was faster in that pair.

| Changed characters | Searches | Baseline mean ms | Optimized mean ms | Median paired ratio | Paired ratio range | Optimized faster pairs |
| ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 8,192 | 0% | 3.789 | 4.029 | 0.957 | 0.901-1.432 | 4 / 6 |
| 8,192 | 50% | 16.870 | 14.019 | 0.806 | 0.588-1.185 | 4 / 6 |
| 8,192 | 90% | 12.640 | 12.582 | 1.005 | 0.767-1.284 | 3 / 6 |
| 32,768 | 0% | 11.009 | 10.029 | 0.984 | 0.673-1.099 | 3 / 6 |
| 32,768 | 50% | 17.362 | 17.949 | 1.063 | 0.789-1.346 | 3 / 6 |
| 32,768 | 90% | 14.006 | 13.474 | 0.864 | 0.723-1.497 | 4 / 6 |

The earlier 32K/write-only timing penalty did **not** reproduce as a consistent
ordering: the optimized mean was lower here, but it won only three pairs and
the median paired difference was small. Conversely, 8K/write-only had a
**6.34% higher optimized mean**, despite four faster pairs, because its slower
pairs had larger penalties. The 32K/50%-search optimized mean was **3.38%
higher**, with a 1.063 median paired ratio. No profile won all six pairs.
These measured losses remain part of the result; they are not discarded.

Ordering and variability remain material. At 32K/50%-search the median ratio
was 0.951 in baseline-first pairs versus 1.176 in optimized-first pairs; at
32K/90% it was 0.856 versus 1.059. Three observations per order stratum cannot
establish a causal order effect. The balance mitigates drift/position bias but
does not control shared-host scheduling, randomized per-process hash layout,
JIT/GC variation or the small number of independent process pairs. Replays
within one process are not treated as 1,440 independent paired observations;
the descriptive pair ranges are not confidence intervals.

Replay allocation remains a **different scope** from the earlier storage
preparation trace: it includes replay consumption and search-output
materialization. For example, the 32K/write-only mean was 6,821,974 baseline
versus 6,713,296 optimized bytes/replay; the corresponding 50%-search values
were 12,538,627 versus 12,487,373. These workload-specific counters do not
justify a broad allocation/performance guarantee. The narrow claim remains
the earlier observed reduction in successful **correction-preparation**
allocation, approximately 13,394 to 10,599 bytes per applied correction in
that mixed workload.

GC counters cover the **whole case**, including oracle work, seeding and
fresh initialization, not only timed correction replays. At 8K/write-only,
Gen0 count ranges were 28-29 baseline versus 27-28 optimized, while Gen1 was
7-10 versus 8-12; Gen2 was one in both. At 32K/50%-search, Gen0 was
66-68 versus 65-67, Gen1 13-19 versus 15-17 and Gen2 1-2 in both. GC pause
duration and GC CPU overhead are not measured by this finite driver.
Fewer collections in one category cannot be reported as lower GC overhead.
No forced GC or machine-wide tuning was used.

**Rechecked conclusion:** less correction-preparation allocation is supported.
Broadly faster execution and lower GC overhead are **not established**.
The alternating results are mixed, including observed timing regressions,
and do not justify calling TermDiff an unconditional performance improvement.

Completed scope is the requested first bounded load-ramp harness, including
short repeated growth/pressure/release cycles and focused lifecycle failures.
Long-duration soak stabilization and production admission cancellation remain
unestablished; no cancellation capability was silently added to the library.
No architectural/default change or Indexed promotion follows from this work.
