// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;

namespace LLMContextLib;

/// <summary>
/// A published immutable session root, not a mutable conversation list. Retaining this object
/// retains its reachable segments; returning a root is O(1), but its lifetime footprint is not.
/// The storage owner validates the complete reachable graph and publishes matching indexes.
/// </summary>
/// <param name="SessionId">Canonical, nonempty identity. An owner never reuses a removed session's ID.</param>
/// <param name="UserId">Nonempty application identity used when evaluating memory applicability.</param>
/// <param name="RepositoryId">Optional repository identity; null means there is no repository scope.</param>
/// <param name="Revision">Nonnegative version of this root, advanced once per accepted session change set.</param>
/// <param name="Status">Lifecycle metadata controlling content mutation and opening new reads.</param>
/// <param name="Segments">Physical segments ordered by ID; entry sequences increase across this order.</param>
/// <param name="Anchors">Navigation metadata keyed by canonical anchor ID, not text or display offsets.</param>
/// <remarks>
/// Initialize with explicit immutable collections, including when empty. Changing a record with
/// <c>with</c> creates a caller-owned value; it does not update an initialized owner. Publish changes
/// through <see cref="ILLMContextPolymorphicArray.Apply"/> and reopen a read to observe the new root.
/// </remarks>
public sealed record LLMSessionContext(
    Guid SessionId,
    Guid UserId,
    Guid? RepositoryId,
    long Revision,
    SessionStatus Status,
    ImmutableSortedDictionary<long, ContextSegment> Segments,
    ImmutableDictionary<Guid, ConversationAnchor> Anchors);

/// <summary>
/// Physical bounded storage, independent of a consumer view. ImmutableArray gives direct
/// indexing but SetItem/Add/RemoveAt copy entry references in O(B). Strings remain shared.
/// Both count and estimated-byte limits are checked before this segment can be published.
/// </summary>
/// <param name="SegmentId">Nonnegative physical segment key, matching its session-directory key.</param>
/// <param name="Revision">Session revision at which the segment was last rewritten.</param>
/// <param name="Entries">Initialized, ordered immutable entries; empty segments can remain after deletion.</param>
public sealed record ContextSegment(long SegmentId, long Revision, ImmutableArray<ContextEntry> Entries);

/// <summary>
/// One canonical transcript item. Identity and sequence survive content replacement; deletion
/// leaves a sequence gap and reserves the identity for the remainder of this owner's session.
/// </summary>
/// <param name="EntryId">Nonempty identity used by mutations, search hits, and anchor endpoints.</param>
/// <param name="Sequence">Monotonically assigned ordering key, not an array index or timestamp.</param>
/// <param name="Role">Speaker/category; tool calls require Assistant and tool results require Tool.</param>
/// <param name="CreatedAt">Application-supplied timestamp; it does not determine transcript ordering.</param>
/// <param name="Content">One supported immutable payload; arbitrary derived payload types are rejected.</param>
public sealed record ContextEntry(
    Guid EntryId, long Sequence, ContextRole Role, DateTimeOffset CreatedAt, ContextContent Content);

/// <summary>
/// Base for immutable transcript payloads. Storage admits only the built-in cases below:
/// deriving another record does not extend indexing, validation, or model-context formatting.
/// </summary>
public abstract record ContextContent;
/// <summary>Ordinary transcript text, preserved as supplied rather than parsed or summarized.</summary>
/// <param name="Text">Non-null text. An empty string is permitted.</param>
public sealed record TextContent(string Text) : ContextContent;
/// <summary>
/// A recorded tool invocation, not an instruction to execute a tool. Pairing uses CallId,
/// which is distinct from the containing entry's canonical EntryId.
/// </summary>
/// <param name="CallId">Nonblank provider/application correlation ID shared with the result.</param>
/// <param name="ToolName">Nonblank application tool name.</param>
/// <param name="ArgumentsJson">Non-null opaque text; storage does not validate JSON or execute it.</param>
public sealed record ToolCallContent(string CallId, string ToolName, string ArgumentsJson) : ContextContent;
/// <summary>A recorded outcome of an external invocation; storing it does not undo or retry that work.</summary>
/// <param name="CallId">Nonblank correlation ID of the recorded invocation.</param>
/// <param name="ResultJson">Non-null opaque result text; no JSON schema is enforced by storage.</param>
/// <param name="IsError">Application-reported failure flag, not a storage mutation status.</param>
public sealed record ToolResultContent(string CallId, string ResultJson, bool IsError) : ContextContent;
/// <summary>
/// Application-authored summary of earlier history. Storage neither generates the summary nor
/// deletes its sources. Model selection suppresses covered history only if this summary fits.
/// </summary>
/// <param name="Text">Non-null summary text.</param>
/// <param name="ThroughSequence">Inclusive covered sequence, nonnegative and earlier than the summary entry.</param>
public sealed record SummaryContent(string Text, long ThroughSequence) : ContextContent;

/// <summary>
/// Names an inclusive passage using stable entry endpoints. Anchors are metadata over the
/// canonical transcript, not duplicate text, an embedding, or an archive of prior revisions.
/// </summary>
/// <param name="AnchorId">Nonempty key for creating or updating this bookmark.</param>
/// <param name="StartEntryId">Existing first entry in the passage when the anchor is published.</param>
/// <param name="EndEntryId">Existing last entry, at or after the start sequence.</param>
/// <param name="Title">Nonblank navigation label, also indexed for lexical search.</param>
/// <param name="Summary">Non-null application-authored description, also indexed.</param>
/// <param name="Topics">Initialized non-null topic strings included in lexical search.</param>
/// <param name="Kind">Application-facing category; it does not change endpoint semantics.</param>
/// <param name="SourceRevision">Session revision against which the description was authored.</param>
/// <param name="PinnedRevision">Optional exact revision required for resolution; no history is fetched.</param>
/// <remarks>
/// Source/pinned revisions may refer to the revision being published by the current transaction.
/// Later deletion need not delete an anchor: resolution reports unavailable endpoints instead.
/// A later unrelated session update can also report Edited; that is not proof of a passage edit.
/// </remarks>
public sealed record ConversationAnchor(
    Guid AnchorId, Guid StartEntryId, Guid EndEntryId, string Title, string Summary,
    ImmutableArray<string> Topics, AnchorKind Kind, long SourceRevision, long? PinnedRevision);

/// <summary>Populated identities are conjunctive applicability conditions, not access grants.</summary>
/// <param name="UserId">When present, the target session must belong to this user.</param>
/// <param name="RepositoryId">When present, the target session must belong to this repository.</param>
/// <param name="SessionId">When present, only this session can receive the memory.</param>
/// <remarks>
/// At least one nonempty identity is required. Retrieval requests exact scope values: requesting
/// a repository-only scope does not implicitly include user-plus-repository or session scopes.
/// The application must enforce permissions separately.
/// </remarks>
public sealed record MemoryScope(Guid? UserId = null, Guid? RepositoryId = null, Guid? SessionId = null);
/// <summary>Provenance reference into a session's anchored passage; it does not copy or pin the source.</summary>
/// <param name="SessionId">Source session, which must be compatible with the memory's scope at publication.</param>
/// <param name="AnchorId">Source bookmark, whose endpoints must resolve at publication.</param>
public sealed record MemorySource(Guid SessionId, Guid AnchorId);
/// <summary>
/// Application-owned knowledge/configuration in the separate memory catalog. Only confirmed,
/// unexpired records with explicitly requested applicable scopes appear in ordinary memory reads.
/// </summary>
/// <param name="MemoryId">Nonempty catalog key; an upsert with this key replaces the existing record.</param>
/// <param name="Scope">Explicit applicability conditions; not an authorization policy.</param>
/// <param name="Content">Nonblank opaque text or application-encoded data, not a library-defined cache format.</param>
/// <param name="Revision">Nonnegative input metadata, overwritten with the accepted catalog revision.</param>
/// <param name="Status">Publication/review state. Confirmation requires at least one source.</param>
/// <param name="ExpiresAt">Optional exclusive expiry time; expiry filters reads, not physical storage.</param>
/// <param name="Sources">Initialized provenance references validated at publication, not continuously thereafter.</param>
/// <remarks>
/// A source may later change or disappear. Consumers that require current evidence must resolve
/// it explicitly. An old read keeps its captured memory catalog and expiry-evaluation time.
/// </remarks>
public sealed record ContextMemory(
    Guid MemoryId, MemoryScope Scope, string Content, long Revision, MemoryStatus Status,
    DateTimeOffset? ExpiresAt, ImmutableArray<MemorySource> Sources);

/// <summary>Transcript speaker/category. The library stores roles; it does not execute a conversation protocol.</summary>
public enum ContextRole
{
    /// <summary>Application instructions, prioritized during model-context selection.</summary>
    System,
    /// <summary>Human or application request.</summary>
    User,
    /// <summary>Assistant output, including recorded tool invocations.</summary>
    Assistant,
    /// <summary>External tool output; required for ToolResultContent.</summary>
    Tool,
    /// <summary>Application-internal history, excluded from the plain conversation view.</summary>
    Internal
}
/// <summary>Session lifecycle policy; already captured reads remain usable after status changes.</summary>
public enum SessionStatus
{
    /// <summary>Accepts transcript, anchor, and status changes.</summary>
    Active,
    /// <summary>Accepts status changes but not content changes; reads remain available.</summary>
    Suspended,
    /// <summary>Accepts status changes but not content changes; closure is not automatic deletion.</summary>
    Closed,
    /// <summary>Rejects new reads and cannot be reopened; removal and existing leases are separate.</summary>
    Expired
}
/// <summary>Descriptive navigation categories; none invokes inference or changes range resolution.</summary>
public enum AnchorKind
{
    /// <summary>An explicitly created bookmark without a more specific category.</summary>
    Manual,
    /// <summary>A passage grouped around an application-defined topic.</summary>
    Topic,
    /// <summary>A conclusion or choice worth returning to.</summary>
    Decision,
    /// <summary>A question and its surrounding evidence.</summary>
    Question,
    /// <summary>A passage associated with an external or recorded artifact.</summary>
    Artifact
}
/// <summary>Application-managed review state; only Confirmed records are returned as applicable memory.</summary>
public enum MemoryStatus
{
    /// <summary>Stored candidate, not yet admitted to ordinary memory reads.</summary>
    Proposed,
    /// <summary>Approved by the application and backed by validated source references.</summary>
    Confirmed,
    /// <summary>Retained catalog record replaced conceptually by newer knowledge.</summary>
    Superseded,
    /// <summary>Retained catalog record withdrawn by the application.</summary>
    Retracted
}
/// <summary>Terminal outcome of one mutation attempt; failures never partially publish its commands.</summary>
public enum ContextMutationStatus
{
    /// <summary>The complete change was published; inspect Revision for its accepted version.</summary>
    Applied,
    /// <summary>The expected revision was stale; storage did not rebase or retry.</summary>
    RevisionConflict,
    /// <summary>Validation rejected the proposed graph or command sequence.</summary>
    InvalidOperation,
    /// <summary>A writer gate or estimated resource budget could not admit the operation.</summary>
    AdmissionRejected,
    /// <summary>The requested session is absent or was removed before commit.</summary>
    NotFound
}
/// <summary>Resolution against one captured root, not an assessment of an anchor's semantic truth.</summary>
public enum AnchorTargetStatus
{
    /// <summary>Both endpoints exist and the captured revision equals SourceRevision.</summary>
    Current,
    /// <summary>Both endpoints exist but the session revision differs, even after an unrelated edit.</summary>
    Edited,
    /// <summary>Exactly one endpoint remains; the library does not reconstruct the missing one.</summary>
    Partial,
    /// <summary>Neither endpoint remains in the captured root.</summary>
    Missing,
    /// <summary>The anchor pins a different revision; this owner supplies no historical lookup.</summary>
    HistoryUnavailable
}

/// <summary>An append request before storage assigns its sequence and, optionally, identity.</summary>
/// <param name="EntryId">Caller-supplied stable ID, or Guid.Empty to generate one during preparation.</param>
/// <param name="Role">Category validated together with the payload.</param>
/// <param name="CreatedAt">Application timestamp, not an ordering or concurrency token.</param>
/// <param name="Content">Supported immutable payload to append.</param>
public sealed record ContextEntryDraft(
    Guid EntryId, ContextRole Role, DateTimeOffset CreatedAt, ContextContent Content);

/// <summary>
/// A declarative command in an ordered session transaction. Constructing a command performs
/// no publication or external work; only Apply validates and attempts to commit it.
/// </summary>
public abstract record ContextChange;
/// <summary>Append drafts in array order, assigning monotonically increasing sequences.</summary>
/// <param name="Entries">Initialized drafts; returned mutation IDs correspond to this append order.</param>
public sealed record AppendEntries(ImmutableArray<ContextEntryDraft> Entries) : ContextChange;
/// <summary>Replace only the payload, preserving identity, sequence, role, and creation time.</summary>
/// <param name="EntryId">Existing canonical identity, not an offset from a view.</param>
/// <param name="Content">New immutable payload, still valid for the entry's existing role.</param>
public sealed record ReplaceEntry(Guid EntryId, ContextContent Content) : ContextChange;
/// <summary>Remove an entry without renumbering survivors, reusing its identity, or repairing anchors.</summary>
/// <param name="EntryId">Existing canonical identity to remove.</param>
public sealed record DeleteEntry(Guid EntryId) : ContextChange;
/// <summary>
/// Replace a physical segment while preserving each member's identity and sequence at the
/// same offset. Use append/delete commands for membership changes, not this operation.
/// </summary>
/// <param name="SegmentId">Existing segment key.</param>
/// <param name="Entries">Initialized replacement entries; role/content/timestamps may change subject to validation.</param>
public sealed record ReplaceSegment(long SegmentId, ImmutableArray<ContextEntry> Entries) : ContextChange;
/// <summary>Create or replace a bookmark after validating its endpoints in the transaction's current state.</summary>
/// <param name="Anchor">Metadata; it can refer to an entry appended earlier in the same change set.</param>
public sealed record PutAnchor(ConversationAnchor Anchor) : ContextChange;
/// <summary>Remove an existing bookmark and its search memberships, without deleting transcript entries.</summary>
/// <param name="AnchorId">Existing bookmark key.</param>
public sealed record RemoveAnchor(Guid AnchorId) : ContextChange;
/// <summary>
/// Change lifecycle status. Command order matters: a non-active session must be activated
/// before content changes in the same transaction. Expired sessions cannot be reactivated.
/// </summary>
/// <param name="Status">Defined lifecycle value to publish.</param>
public sealed record SetSessionStatus(SessionStatus Status) : ContextChange;

/// <summary>
/// One atomic session publication. Commands target canonical identities rather than offsets
/// in a filtered view. ExpectedRevision prevents stale writes from overwriting accepted updates.
/// Preparation is speculative and can allocate before a conflict/admission failure is known.
/// </summary>
/// <param name="SessionId">Existing target session.</param>
/// <param name="ExpectedRevision">Exact revision to compare at preparation and again before publication.</param>
/// <param name="Changes">Initialized, nonempty ordered commands, all committed or all discarded.</param>
public sealed record ContextChangeSet(
    Guid SessionId, long ExpectedRevision, ImmutableArray<ContextChange> Changes);
/// <summary>
/// One atomic catalog transaction, independent of session transactions. Deletes are processed
/// before upserts, and an ID may occur only once across both arrays. Accepted upserts receive
/// the new catalog revision regardless of their input record revision.
/// </summary>
/// <param name="ExpectedRevision">Expected memory-catalog revision, not a session or record revision.</param>
/// <param name="Upserts">Initialized records to create or replace.</param>
/// <param name="Deletes">Initialized existing memory IDs to remove. Unknown IDs reject the transaction.</param>
public sealed record MemoryChangeSet(
    long ExpectedRevision, ImmutableArray<ContextMemory> Upserts, ImmutableArray<Guid> Deletes);

/// <summary>
/// Outcome of an attempted publication. Always inspect Status before using the revision as
/// proof of a write; a failed external-tool recording does not undo the external invocation.
/// </summary>
public interface IContextMutationResult
{
    /// <summary>Applied is the only success outcome; no failure denotes a partial commit.</summary>
    ContextMutationStatus Status { get; }
    /// <summary>
    /// Accepted revision on success, otherwise a revision associated with rejection (or zero
    /// when unavailable). Failure metadata is not a fresh read or a safe automatic-retry token.
    /// </summary>
    long Revision { get; }
    /// <summary>Optional diagnostic explanation, not a stable machine-readable error code.</summary>
    string? Error { get; }
    /// <summary>IDs assigned to appended drafts, in command/draft order, on successful session publication.</summary>
    ImmutableArray<Guid> AppendedEntryIds { get; }
}

internal sealed record ContextMutationResult(
    ContextMutationStatus Status, long Revision, string? Error = null,
    ImmutableArray<Guid> AppendedEntryIds = default) : IContextMutationResult;

/// <summary>A continuation tied to an exact session revision, not a live-tail subscription.</summary>
/// <param name="SessionId">Session that produced the page.</param>
/// <param name="Revision">Captured session revision; a newer read rejects this cursor.</param>
/// <param name="AfterSequence">Exclusive lower boundary for the next page.</param>
public sealed record ContextCursor(Guid SessionId, long Revision, long AfterSequence);
/// <summary>A materialized page of references whose managed payloads remain valid after lease disposal.</summary>
/// <param name="Entries">Ordered entries from one captured root.</param>
/// <param name="Next">Continuation for that revision, or null when no later entries remain.</param>
public sealed record ContextPage(ImmutableArray<ContextEntry> Entries, ContextCursor? Next);
/// <summary>Lexical hit with canonical navigation identities; it is not an embedding similarity score.</summary>
/// <param name="EntryId">Matching entry, or the start entry of matching anchor metadata.</param>
/// <param name="AnchorId">Matching bookmark, or null for a plain entry-text hit.</param>
/// <param name="Snippet">At most 160 UTF-16 characters from the indexed entry or anchor description.</param>
/// <param name="Sequence">Matched entry's order key.</param>
/// <param name="SessionRevision">Captured revision against which the hit was resolved.</param>
public sealed record ContextSearchHit(
    Guid EntryId, Guid? AnchorId, string Snippet, long Sequence, long SessionRevision);
/// <summary>Bookmark metadata and surviving endpoints from one captured session root.</summary>
/// <param name="Anchor">The stored bookmark; an unknown anchor throws instead of returning this record.</param>
/// <param name="Status">Availability/revision assessment, not semantic freshness certification.</param>
/// <param name="Start">Resolved start, or null if unavailable.</param>
/// <param name="End">Resolved end, or null if unavailable.</param>
/// <param name="SessionRevision">Revision actually consulted; no historical root is loaded.</param>
public sealed record AnchorResolution(
    ConversationAnchor Anchor, AnchorTargetStatus Status,
    ContextEntry? Start, ContextEntry? End, long SessionRevision);
/// <summary>
/// One selected model-input item. This is formatted text plus provenance identity, not a
/// provider message or token buffer; the application maps it to its chosen model protocol.
/// </summary>
/// <param name="EntryId">Transcript source identity, or null for a memory-derived item.</param>
/// <param name="MemoryId">Memory source identity, or null for a transcript-derived item.</param>
/// <param name="Role">Transcript role, or System for an inserted memory item.</param>
/// <param name="Text">Formatted payload whose estimated cost participates in selection.</param>
public sealed record ModelContextItem(Guid? EntryId, Guid? MemoryId, ContextRole Role, string Text);

/// <summary>
/// Disposable capture of a session root, memory-catalog root, and expiry-evaluation clock.
/// Reads never refresh themselves; open another lease to see later publications.
/// </summary>
/// <remarks>
/// The session and memory roots are captured independently, not atomically across catalogs.
/// Dispose promptly to release retention admission. Existing leases survive owner disposal,
/// session removal, and later writes; operations on the disposed lease throw.
/// Coordinate disposal with active use rather than racing Dispose against its own operations.
/// </remarks>
public interface ILLMContextReadLease : IDisposable
{
    /// <summary>The immutable session root captured by this lease, not the owner's latest value.</summary>
    LLMSessionContext Session { get; }
    /// <summary>Version of the independently captured memory catalog used by memory reads.</summary>
    long MemoryRevision { get; }
    /// <summary>Look up a live canonical entry in this revision; deleted/unknown IDs return false.</summary>
    bool TryFindEntry(Guid entryId, out ContextEntry entry);
    /// <summary>
    /// Return at most count entries at or after the nonnegative sequence, skipping gaps left by
    /// deletion. Count must be nonnegative; it is a result bound, not a maximum sequence delta.
    /// </summary>
    ImmutableArray<ContextEntry> ReadRange(long fromSequence, int count);
    /// <summary>
    /// Read a positive-sized page. Null starts at the beginning; a supplied cursor must name
    /// this exact session/revision. Pages do not silently migrate across intervening writes.
    /// </summary>
    ContextPage ReadPage(ContextCursor? cursor, int count);
    /// <summary>
    /// Intersect all normalized query-term postings and order hits by sequence then anchor ID.
    /// A nonnegative limit bounds output, not search work. Empty/no-token queries return no hits.
    /// </summary>
    ImmutableArray<ContextSearchHit> Search(string query, int limit);
    /// <summary>
    /// Resolve a stored bookmark against this root. Unknown IDs throw KeyNotFoundException;
    /// known bookmarks report missing endpoints or unavailable pinned history explicitly.
    /// </summary>
    AnchorResolution ResolveAnchor(Guid anchorId);
    /// <summary>
    /// Return confirmed, unexpired memories for the exact initialized scopes requested,
    /// ordered by MemoryId. Every scope must apply to this session or the request is rejected.
    /// Expiry uses the time captured when this lease opened, not the clock at each call.
    /// </summary>
    ImmutableArray<ContextMemory> GetApplicableMemory(ImmutableArray<MemoryScope> scopes);
}

/// <summary>
/// Reusable query recipe over a captured read. Opening it materializes a separate disposable
/// view; the definition itself is neither a live subscription nor a retained session.
/// </summary>
/// <typeparam name="T">Projection value, ideally immutable so callers cannot mutate a captured result.</typeparam>
/// <remarks>
/// Evaluate runs synchronously inside the owner's operation lifetime. Custom evaluators must
/// not dispose/retain the borrowed lease, reenter the owner, or assume a result cap bounds
/// work before the first yield. A view freezes membership, not arbitrary mutable projected objects.
/// </remarks>
public interface ILLMContextViewDefinition<T>
{
    /// <summary>Session whose root and applicable memory are captured when the view is opened.</summary>
    Guid SessionId { get; }
    /// <summary>Nonnegative output cap, no greater than the owner's MaximumViewResults.</summary>
    int MaximumResults { get; }
    /// <summary>Produce results using the borrowed read; the owner consumes at most MaximumResults items.</summary>
    IEnumerable<T> Evaluate(ILLMContextReadLease context);
}

/// <summary>
/// Materialized, revision-stable projection holding a read lease and output-retention charge.
/// Dispose releases both; it does not refresh the original definition or dispose the owner.
/// </summary>
/// <typeparam name="T">Projected value type; custom reference payloads remain the caller's responsibility.</typeparam>
/// <remarks>Using or enumerating the view after disposal fails. Coordinate disposal with enumeration.</remarks>
public interface ILLMContextView<out T> : IReadOnlyList<T>, IDisposable
{
    /// <summary>Session revision used for every item in this projection.</summary>
    long SessionRevision { get; }
    /// <summary>Independently captured memory revision used during evaluation.</summary>
    long MemoryRevision { get; }
}

/// <summary>
/// Single owning client for canonical sessions, their immutable revisions, and a shared
/// memory catalog. Obtain it from the factory and share it with application workers.
/// </summary>
/// <remarks>
/// Concurrent operations are supported; session writers still supply strict expected revisions.
/// There is no automatic rebase, retry, persistence, agent scheduler, or model execution.
/// Dispose prevents new owner operations and releases active storage; existing leases/views
/// remain valid until independently disposed. No writable top-level session array is exposed.
/// </remarks>
public interface ILLMContextPolymorphicArray : IDisposable
{
    /// <summary>
    /// Return an immutable root without a lease or memory snapshot. Absent IDs return false.
    /// Retaining an escaped root retains its graph outside the owner's lease accounting.
    /// </summary>
    bool TryFind(Guid sessionId, out LLMSessionContext session);
    /// <summary>
    /// Validate and index a complete immutable session before admitting it. Its initial
    /// revision is preserved; duplicate and previously removed session IDs are rejected.
    /// </summary>
    IContextMutationResult CreateSession(LLMSessionContext session);
    /// <summary>
    /// Remove an existing session only at the expected revision. Already captured reads survive;
    /// its identity remains reserved and referring memories are not automatically deleted.
    /// </summary>
    IContextMutationResult RemoveSession(Guid sessionId, long expectedRevision);
    /// <summary>
    /// Attempt one atomic ordered session change set. Validation, conflicts, and admission
    /// failures return statuses; null arguments and unexpected callback failures can throw.
    /// The external operations described in transcript content are never executed here.
    /// </summary>
    IContextMutationResult Apply(ContextChangeSet changes);
    /// <summary>
    /// Attempt one atomic memory-catalog update using the catalog's own expected revision.
    /// Source validation does not create a transaction with the referenced sessions.
    /// </summary>
    IContextMutationResult ApplyMemory(MemoryChangeSet changes);
    /// <summary>
    /// Capture independently versioned session/memory roots and an expiry clock, charging
    /// retention admission. Missing/expired sessions or exhausted read budgets throw.
    /// The caller owns disposal; no session writer gate is taken by the read path.
    /// </summary>
    ILLMContextReadLease OpenRead(Guid sessionId);
    /// <summary>
    /// Capture a read, evaluate a bounded definition, and account for materialized output.
    /// Enumeration/estimation/admission failures release the read before propagating.
    /// The caller owns the returned view; output caps do not bound arbitrary evaluator work.
    /// </summary>
    ILLMContextView<T> OpenView<T>(ILLMContextViewDefinition<T> definition);
    /// <summary>Capture owner accounting counters, not a GC heap measurement or session/memory transaction.</summary>
    LLMContextStatistics GetStatistics();
}

/// <summary>
/// Owner accounting, not GC/process telemetry. Rewritten bytes describe logical segment
/// footprint, not actual payload copying. Resident/retained numbers are documented estimates;
/// escaped immutable roots and caller-owned read arrays cannot be forcibly reclaimed.
/// </summary>
/// <param name="Sessions">Number of sessions currently in the owner's directory.</param>
/// <param name="EstimatedActiveBytes">Estimated active session/catalog/index and reserved-identity footprint.</param>
/// <param name="EstimatedRetainedBytes">Conservative distinct captured-root charges plus projected-view output.</param>
/// <param name="RetainedReads">Open read leases, including leases owned by views.</param>
/// <param name="MemoryRevision">Current catalog revision when statistics are read.</param>
/// <param name="PublishedMutations">Successful create/remove/session/memory publications.</param>
/// <param name="SegmentsRewritten">Segment rewrites charged by successful session change sets, not failed preparation.</param>
/// <param name="EstimatedSegmentBytesRewritten">Logical rewritten segment sizes, not allocated/copied payload bytes.</param>
/// <param name="EstimatedViewBytes">Output-retention component already included in EstimatedRetainedBytes.</param>
public sealed record LLMContextStatistics(
    int Sessions, long EstimatedActiveBytes, long EstimatedRetainedBytes,
    int RetainedReads, long MemoryRevision, long PublishedMutations,
    long SegmentsRewritten, long EstimatedSegmentBytesRewritten, long EstimatedViewBytes = 0);

/// <summary>
/// Construction-time segmentation and admission policies. Limits are estimates for this
/// owner, not hard process-memory ceilings, and changing a separate record does not reconfigure it.
/// </summary>
/// <remarks>
/// All numeric capacity limits must be positive. The owner checks immutable published graphs
/// and retained output, but preparation/materialization can allocate before admission rejects it.
/// Estimator callbacks can run concurrently: keep them deterministic, thread-safe, and non-reentrant.
/// Do not call back into the owner from estimators or its TimeProvider.
/// </remarks>
public sealed record LLMContextOptions
{
    // Experimental policy, deliberately not a public configuration/default change.
    // Benchmarks/tests compare it with speculative preparation before any promotion.
    internal bool SerializeSessionPreparation { get; init; }
    /// <summary>Maximum entries in each physical segment; exceeding a tail cap starts another segment.</summary>
    public int MaximumEntriesPerSegment { get; init; } = 128;
    /// <summary>
    /// Maximum sum of entry estimates in a segment. A single oversized entry or a replacement
    /// that exceeds this cap rejects the transaction; storage does not split a payload.
    /// </summary>
    public long MaximumEstimatedBytesPerSegment { get; init; } = 256 * 1024;
    /// <summary>Admission ceiling for active estimates plus retained-root/output estimates.</summary>
    public long EstimatedResidentByteBudget { get; init; } = 64 * 1024 * 1024;
    /// <summary>Maximum simultaneously admitted read leases, including those held by views.</summary>
    public int MaximumRetainedReads { get; init; } = 128;
    /// <summary>Largest accepted view-definition output cap; it does not cap direct ReadRange calls.</summary>
    public int MaximumViewResults { get; init; } = 4096;
    /// <summary>
    /// Admission ceiling for captured roots and view output, separate from the resident ceiling.
    /// Same-root reads share a root charge; different revisions are conservatively charged in full.
    /// </summary>
    public long MaximumEstimatedRetainedBytes { get; init; } = 64 * 1024 * 1024;
    /// <summary>
    /// Nonnegative wait allowance for writer-gate and budget admission attempts. Zero fails
    /// immediately when unavailable. This is not an end-to-end deadline or cancellation token:
    /// preparation, callbacks, and ordinary accounting-lock acquisition are not deadline-bounded.
    /// </summary>
    public TimeSpan AdmissionTimeout { get; init; } = TimeSpan.Zero;
    /// <summary>Clock sampled when a read opens; that captured time governs memory expiry for the lease.</summary>
    public TimeProvider TimeProvider { get; init; } = TimeProvider.System;
    /// <summary>
    /// Positive estimated bytes for one immutable entry, used for segmentation and admission.
    /// The same entry must estimate consistently across preparation; checked arithmetic rejects
    /// overflow. The default counts a fixed overhead plus formatted UTF-16 text, not actual heap size.
    /// </summary>
    public Func<ContextEntry, long> EntrySizeEstimator { get; init; } = ContextPolicies.EstimateEntryBytes;
    /// <summary>
    /// Positive estimate per materialized view item, added to read-root retention. The default
    /// knows common payloads and otherwise charges a fixed fallback: supply a meaningful estimator
    /// for large custom projections. It does not recursively measure arbitrary object graphs.
    /// </summary>
    public Func<object?, long> ProjectionSizeEstimator { get; init; } = value => value switch
    {
        ContextEntry entry => ContextPolicies.EstimateEntryBytes(entry),
        string text => checked(32L + 2L * text.Length),
        ModelContextItem item => checked(96L + 2L * item.Text.Length),
        ContextMemory memory => checked(128L + 2L * memory.Content.Length),
        ContextSearchHit hit => checked(96L + 2L * hit.Snippet.Length),
        _ => 128
    };

    internal void Validate()
    {
        if (MaximumEntriesPerSegment <= 0 || MaximumEstimatedBytesPerSegment <= 0 ||
            EstimatedResidentByteBudget <= 0 || MaximumRetainedReads <= 0 || MaximumViewResults <= 0 ||
            MaximumEstimatedRetainedBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(MaximumEntriesPerSegment), "Limits must be positive.");
        if (AdmissionTimeout < TimeSpan.Zero || AdmissionTimeout.TotalMilliseconds > int.MaxValue)
            throw new ArgumentOutOfRangeException(nameof(AdmissionTimeout));
        ArgumentNullException.ThrowIfNull(TimeProvider);
        ArgumentNullException.ThrowIfNull(EntrySizeEstimator);
        ArgumentNullException.ThrowIfNull(ProjectionSizeEstimator);
    }
}
