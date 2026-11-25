// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { randomUUID } from 'node:crypto';
import { ContextIndexingMode, ContextIndexKeys } from '../domain/index-keys.js';
import { timestampTicks } from '../domain/date-time-offset.js';
import { canonicalGuid } from '../domain/guid.js';
import { ImmutableMap } from '../domain/immutable-map.js';
import { advanceInt64, canonicalInt64, checkedInt64, compareInt64, isInt64, isPositiveInt64, type Int64 } from '../domain/int64.js';
import { isNativePayload } from '../domain/payload-identity.js';
import {
  AnchorKind, ContextMutationResult, ContextMutationStatus, ContextRole, SessionStatus,
  SummaryContent, TextContent, ToolCallContent, ToolResultContent,
  type ContextChangeSet, type ContextEntry, type ContextEntryDraft, type ContextSegment, type ConversationAnchor,
  type Guid, type LLMSessionContext,
} from '../domain/session.js';
import { defaultLLMContextOptions, type LLMContextOptions } from '../options.js';
import { ContextIndexPartition, PartitionCapacityException, type PartitionContribution, type PartitionedContextIndexOptions } from './partitioned-index.js';
import { estimateTermBytes, type SessionIndexEdits } from './session-index.js';
import { PersistentStringTree } from './persistent-string-tree.js';
import { OrderedInt64Map } from './ordered-int64-map.js';
import { restoreWireContent } from '../runtime/wire-content.js';

export interface SessionRoot {
  readonly Session: LLMSessionContext;
  readonly Segments: OrderedInt64Map<ContextSegment>;
  readonly Seen: PersistentStringTree<true>;
  readonly Locations: Locations;
  readonly NextSequence: Int64;
  readonly NextSegment: Int64;
  readonly Bytes: bigint;
  readonly AnchorBytes: bigint;
  readonly Partitions: OrderedInt64Map<ContextIndexPartition>;
}

export interface PreparedSessionChange {
  readonly Next: SessionRoot;
  readonly Delta: bigint;
  publish(): ContextMutationResult;
}

interface ReplacementBatchInput {
  readonly Kind: 'Replacement';
  readonly MaximumSegmentBytes: Int64;
  readonly Limits: PartitionedContextIndexOptions;
  readonly Segments: ReadonlyMap<Int64, ReplacementSegmentInput>;
  readonly Edits: readonly { readonly SegmentId: Int64; readonly Offset: number; readonly Old: ContextEntry;
    readonly Content: ContextEntry['Content']; readonly IndexKeys: readonly string[] }[];
}

interface DeletionInput extends ReplacementSegmentInput {
  readonly Kind: 'Deletion';
  readonly SegmentId: Int64;
  readonly Offset: number;
  readonly Old: ContextEntry;
  readonly Limits: PartitionedContextIndexOptions;
  readonly BaseContribution?: PartitionContribution;
  readonly Empty: boolean;
}

interface SegmentReplacementInput extends ReplacementSegmentInput {
  readonly Kind: 'SegmentReplacement';
  readonly SegmentId: Int64;
  readonly Old: readonly ContextEntry[];
  readonly Entries: readonly ContextEntry[];
  readonly MaximumSegmentBytes: Int64;
  readonly Limits: PartitionedContextIndexOptions;
}

interface AppendInput {
  readonly Kind: 'Append';
  readonly SessionId: Guid;
  readonly Revision: Int64;
  readonly Drafts: readonly ContextEntryDraft[];
  readonly NextSequence: Int64;
  readonly NextSegment: Int64;
  readonly Tail?: { readonly Segment: ContextSegment; readonly SegmentBytes: bigint; readonly Partition?: PartitionPreparationInput };
  readonly Seen: readonly Guid[];
  readonly MaximumEntriesPerSegment: number;
  readonly MaximumSegmentBytes: Int64;
  readonly Limits: PartitionedContextIndexOptions;
}

interface MixedSegmentInput {
  readonly Segment: ContextSegment;
  readonly Bytes: bigint;
  readonly Partition?: PartitionPreparationInput & { readonly Contributions: ReadonlyMap<Guid, PartitionContribution> };
}

interface MixedEntryInput {
  readonly Kind: 'MixedEntry';
  readonly SessionId: Guid;
  readonly Revision: Int64;
  readonly Status: SessionStatus;
  readonly Commands: ContextChangeSet['Changes'];
  readonly Segments: ReadonlyMap<Int64, MixedSegmentInput>;
  readonly Anchors: ReadonlyMap<Guid, ConversationAnchor>;
  readonly Seen: readonly Guid[];
  readonly NextSequence: Int64;
  readonly NextSegment: Int64;
  readonly MaximumEntriesPerSegment: number;
  readonly MaximumSegmentBytes: Int64;
  readonly Limits: PartitionedContextIndexOptions | null;
  readonly IndexingMode: ContextIndexingMode;
}

export type EntryPreparationInput = ReplacementBatchInput | DeletionInput | SegmentReplacementInput | AppendInput | MixedEntryInput;

interface PartitionPreparationInput {
  readonly BaseBytes: number;
  readonly WorkingSetBytes: number;
  readonly Overrides: ReadonlyMap<Guid, PartitionContribution | null>;
}

interface ReplacementSegmentInput extends PartitionPreparationInput {
  readonly SegmentBytes: bigint;
}

interface ReplacementSegmentOutput {
  readonly SegmentBytes: bigint;
  readonly WorkingSetBytes: number;
  readonly Overrides: ReadonlyMap<Guid, PartitionContribution>;
}

interface ReplacementBatchOutput {
  readonly Edits: readonly { readonly SegmentId: Int64; readonly Offset: number;
    readonly Content: ContextEntry['Content']; readonly IndexKeys: readonly string[]; readonly Metadata?: ContextEntry }[];
  readonly Segments: ReadonlyMap<Int64, ReplacementSegmentOutput>;
  readonly RewrittenBytes: bigint;
}

interface DeletionOutput {
  readonly Delete: { readonly SegmentId: Int64; readonly Offset: number; readonly SegmentBytes: bigint;
    readonly Empty: boolean; readonly Tombstone: boolean; readonly WorkingSetBytes: number };
}

interface AppendSegmentOutput extends ReplacementSegmentOutput {
  readonly Entries: readonly ContextEntry[];
}

interface AppendOutput {
  readonly Append: ReadonlyMap<Int64, AppendSegmentOutput>;
  readonly Ids: readonly Guid[];
  readonly NextSequence: Int64;
  readonly NextSegment: Int64;
  readonly RewrittenBytes: bigint;
}

interface MixedSegmentOutput {
  readonly Ids: readonly Guid[];
  readonly Bytes: bigint;
  readonly Partition?: PartitionPreparationInput & { readonly PreservesBase: boolean };
}

interface MixedEntryOutput {
  readonly Mixed: ReadonlyMap<Int64, MixedSegmentOutput>;
  readonly Edits: readonly (
    { readonly Kind: 'Entry'; readonly Id: Guid; readonly Value?: ContextEntry } |
    { readonly Kind: 'Anchor'; readonly Id: Guid; readonly Value?: ConversationAnchor }
  )[];
  readonly Status: SessionStatus;
  readonly Appended: readonly Guid[];
  readonly NextSequence: Int64;
  readonly NextSegment: Int64;
  readonly Rewrites: number;
  readonly RewrittenBytes: bigint;
}

export type EntryPreparationOutput = ReplacementBatchOutput | DeletionOutput | AppendOutput | MixedEntryOutput |
  { readonly Error: string; readonly Capacity?: { readonly CanSynchronize: boolean; readonly SegmentId: Int64 | null } };

type EntryLocation = readonly [segment: Int64, offset: number];
type Locations = PersistentStringTree<EntryLocation>;

function updateEntryLocation(locations: Locations, entryId: Guid, location?: EntryLocation): Locations {
  return location ? locations.set(entryId, location) : locations.delete(entryId);
}

function updateEntryLocations(locations: Locations, edits: readonly (readonly [Guid, EntryLocation])[]): Locations {
  return edits.length === 1 ? updateEntryLocation(locations, ...edits[0]) : locations.replaceValues(edits);
}

function copySegmentEntries(segment: ContextSegment): ContextEntry[] {
  return [...segment.Entries];
}

const emptyId = '00000000-0000-0000-0000-000000000000';
const validId = (id: Guid) => typeof id === 'string' && id.length > 0 && canonicalGuid(id) !== emptyId;
const nonnegative = (value: Int64) => isInt64(value) && value >= 0;

function checked(value: number): number {
  if (!nonnegative(value)) throw new RangeError('Integer overflow.');
  return value;
}

export class SessionStore {
  private readonly sessions = new Map<Guid, SessionRoot>();
  private readonly seenSessions = new Set<Guid>();
  private readonly segmentEstimates = new WeakMap<ContextSegment, bigint>();
  private activeBytes = 0n;
  private rewrittenSegments = 0n;
  private rewrittenBytes = 0n;

  constructor(private readonly options: LLMContextOptions) {}

  public get ActiveBytes(): bigint { return this.activeBytes; }
  public get Count(): number { return this.sessions.size; }
  public get SegmentsRewritten(): Int64 { return canonicalInt64(this.rewrittenSegments); }
  public get SegmentBytesRewritten(): bigint { return this.rewrittenBytes; }
  public estimate(id: Guid): bigint { return this.sessions.get(canonicalGuid(id))?.Bytes ?? 0n; }
  public partitions(id: Guid): ReadonlyMap<Int64, ContextIndexPartition> {
    return this.sessions.get(id)!.Partitions;
  }

  public prepareCompaction(sessionId: Guid, segmentId: Int64, compacted: ContextIndexPartition): {
    partitions: ReadonlyMap<Int64, ContextIndexPartition>;
    publish(): void;
  } {
    const root = this.sessions.get(sessionId)!;
    const previous = root.Partitions.get(segmentId)!;
    if (compacted.EstimatedBytes > this.options.PartitionedIndex!.MaximumEstimatedPartitionBytes) {
      throw new RangeError('Compacted partition exceeded its reserved limit.');
    }
    const partitions = root.Partitions.add(segmentId, compacted, BigInt(compacted.EstimatedBytes));
    const delta = BigInt(compacted.EstimatedBytes - previous.EstimatedBytes);
    const activeBytes = checkedInt64(this.activeBytes + delta);
    const next = { ...root, Partitions: partitions, Bytes: checkedInt64(root.Bytes + delta) };
    return { partitions, publish: () => {
      this.sessions.set(sessionId, next);
      this.activeBytes = activeBytes;
    } };
  }

  public clear(): void {
    this.sessions.clear();
    this.seenSessions.clear();
    this.activeBytes = this.rewrittenBytes = 0n;
    this.rewrittenSegments = 0n;
  }

  public tryFind(sessionId: Guid): LLMSessionContext | null {
    return this.sessions.get(canonicalGuid(sessionId))?.Session ?? null;
  }

  public capture(sessionId: Guid): SessionRoot | undefined {
    return this.sessions.get(sessionId);
  }

  public createSession(session: LLMSessionContext, index: SessionIndexEdits,
    admit: (delta: bigint, next: LLMSessionContext, partitions: ReadonlyMap<Int64, ContextIndexPartition>) => string | null,
    canPublish: () => boolean): ContextMutationResult {
    try {
      if (!session || !validId(session.SessionId) || !validId(session.UserId) ||
          (session.RepositoryId !== null && !validId(session.RepositoryId)) ||
          !nonnegative(session.Revision) || !Object.values(SessionStatus).includes(session.Status) ||
          !session.Segments || !session.Anchors) throw new TypeError('Invalid session metadata.');

      let seen = new PersistentStringTree<true>();
      let locations = new PersistentStringTree<EntryLocation>();
      let segments = new OrderedInt64Map<ContextSegment>();
      const anchors = new Map<Guid, ConversationAnchor>();
      let partitions = new OrderedInt64Map<ContextIndexPartition>();
      let previousSequence: Int64 = -1;
      let nextSegment: Int64 = 0;
      const revision = canonicalInt64(session.Revision);
      const sessionId = canonicalGuid(session.SessionId);
      for (const [key, segment] of [...session.Segments].sort(([a], [b]) => compareInt64(a, b))) {
        const id = canonicalInt64(key);
        if (!segment || !nonnegative(id) || segments.has(id) || id !== canonicalInt64(segment.SegmentId) ||
            !nonnegative(segment.Revision) || segment.Revision > session.Revision || !Array.isArray(segment.Entries)) {
          throw new TypeError('Invalid segment metadata.');
        }
        const entries: ContextEntry[] = [];
        for (const value of segment.Entries) {
          const entry = this.copyEntry(value);
          if (seen.has(entry.EntryId) || entry.Sequence <= previousSequence) {
            throw new TypeError('Duplicate entry identity or unordered sequences.');
          }
          seen = seen.set(entry.EntryId, true);
          locations = locations.set(entry.EntryId, [id, entries.length]);
          previousSequence = entry.Sequence;
          entries.push(entry);
        }
        const imported = this.segment(id, canonicalInt64(segment.Revision), entries);
        segments = segments.add(id, imported, 128n + this.segmentEstimates.get(imported)!);
        for (const entry of entries) index.entry(undefined, entry);
        if (this.options.PartitionedIndex && entries.length) {
          const partition = ContextIndexPartition.Build(new Map(entries.map((entry) => [entry.EntryId, this.contribution(entry)])));
          if (partition.EstimatedBytes > this.options.PartitionedIndex.MaximumEstimatedPartitionBytes) {
            throw new RangeError('Imported entry index exceeds the partition byte limit.');
          }
          partitions = partitions.add(id, partition, BigInt(partition.EstimatedBytes));
        }
        nextSegment = advanceInt64(id);
      }
      for (const [id, anchor] of session.Anchors) {
        if (!anchor || canonicalGuid(id) !== canonicalGuid(anchor.AnchorId) || anchors.has(canonicalGuid(id))) {
          throw new TypeError('Anchor identity mismatch.');
        }
        const next = this.copyAnchor(anchor, segments, locations, session.Revision);
        index.anchor(undefined, next);
        anchors.set(canonicalGuid(id), next);
      }
      const root = this.root({ ...session, SessionId: sessionId, UserId: canonicalGuid(session.UserId),
        RepositoryId: session.RepositoryId === null ? null : canonicalGuid(session.RepositoryId),
        Revision: revision, Segments: segments, Anchors: anchors },
        seen, locations, advanceInt64(previousSequence), nextSegment, partitions);
      if (this.seenSessions.has(sessionId)) {
        return new ContextMutationResult(ContextMutationStatus.InvalidOperation, session.Revision, 'Session identities cannot be reused.');
      }
      const delta = checkedInt64(root.Bytes + 48n);
      const admissionError = admit(delta, root.Session, partitions);
      if (admissionError !== null) {
        return new ContextMutationResult(ContextMutationStatus.AdmissionRejected, session.Revision, admissionError);
      }
      if (this.seenSessions.has(sessionId)) {
        return new ContextMutationResult(ContextMutationStatus.InvalidOperation, session.Revision, 'Session identity was admitted while waiting.');
      }
      if (!canPublish()) {
        return new ContextMutationResult(ContextMutationStatus.AdmissionRejected, session.Revision, 'Deferred indexing backlog or work budget exhausted.');
      }
      this.activeBytes = checkedInt64(this.activeBytes + delta);
      this.sessions.set(sessionId, root);
      this.seenSessions.add(sessionId);
      return new ContextMutationResult(ContextMutationStatus.Applied, revision);
    } catch (error) {
      return new ContextMutationResult(ContextMutationStatus.InvalidOperation, 0, (error as Error).message);
    }
  }

  public removeSession(sessionId: Guid, expectedRevision: Int64): ContextMutationResult {
    sessionId = canonicalGuid(sessionId);
    const root = this.sessions.get(sessionId);
    if (!root) return new ContextMutationResult(ContextMutationStatus.NotFound, 0);
    if (!isInt64(expectedRevision) || compareInt64(root.Session.Revision, expectedRevision) !== 0) {
      return new ContextMutationResult(ContextMutationStatus.RevisionConflict, root.Session.Revision);
    }
    this.sessions.delete(sessionId);
    this.activeBytes -= root.Bytes;
    return new ContextMutationResult(ContextMutationStatus.Applied, root.Session.Revision);
  }

  public entryPreparationInput(changes: ContextChangeSet, root: SessionRoot): EntryPreparationInput | undefined {
    if (this.options.EntrySizeEstimator !== defaultLLMContextOptions.EntrySizeEstimator || !changes.Changes.length) return;
    try {
      advanceInt64(root.Session.Revision);
      const command = changes.Changes[0];
      if (!this.options.PartitionedIndex || command?.kind === 'PutAnchor' || command?.kind === 'RemoveAnchor' || command?.kind === 'SetSessionStatus' ||
          (changes.Changes.length > 1 && changes.Changes.some((edit) => edit?.kind !== 'ReplaceEntry'))) {
        return this.mixedEntryInput(changes, root, this.options.PartitionedIndex);
      }
      if (root.Session.Status !== SessionStatus.Active) return;
      if (changes.Changes.length === 1 && command?.kind === 'AppendEntries') {
        if (!Array.isArray(command.Entries) || !command.Entries.length) return;
        const Seen = new Set<Guid>();
        for (const draft of command.Entries) {
          if (!draft || !isNativePayload(draft.Content)) return;
          if (draft.EntryId === emptyId || draft.EntryId === '') continue;
          const id = canonicalGuid(draft.EntryId);
          if (root.Seen.has(id)) Seen.add(id);
        }
        const tail = root.Segments.get(advanceInt64(root.NextSegment, -1n));
        const partition = tail && root.Partitions.get(tail.SegmentId);
        return { Kind: 'Append', SessionId: root.Session.SessionId, Revision: root.Session.Revision, Drafts: command.Entries,
          NextSequence: root.NextSequence, NextSegment: root.NextSegment, Seen: [...Seen],
          MaximumEntriesPerSegment: this.options.MaximumEntriesPerSegment, MaximumSegmentBytes: this.options.MaximumEstimatedBytesPerSegment,
          Limits: this.options.PartitionedIndex, Tail: tail && { Segment: tail, SegmentBytes: this.segmentEstimates.get(tail)!,
            Partition: partition && { BaseBytes: partition.BaseBytes,
              WorkingSetBytes: partition.WorkingSetBytes, Overrides: partition.Overrides } } };
      }
      if (changes.Changes.length === 1 && command?.kind === 'ReplaceSegment') {
        const segment = root.Segments.get(canonicalInt64(command.SegmentId));
        if (!segment?.Entries.length || !Array.isArray(command.Entries) || command.Entries.length !== segment.Entries.length ||
            !Array.from(command.Entries).every((entry) => entry && isNativePayload(entry.Content)) ||
            !segment.Entries.every((entry) => isNativePayload(entry.Content))) return;
        const partition = root.Partitions.get(segment.SegmentId) ?? ContextIndexPartition.Empty;
        return { Kind: 'SegmentReplacement', SegmentId: segment.SegmentId, Old: segment.Entries, Entries: command.Entries,
          SegmentBytes: this.segmentEstimates.get(segment)!, Limits: this.options.PartitionedIndex,
          MaximumSegmentBytes: this.options.MaximumEstimatedBytesPerSegment, BaseBytes: partition.BaseBytes,
          Overrides: partition.Overrides, WorkingSetBytes: partition.WorkingSetBytes };
      }
      if (changes.Changes.length === 1 && command?.kind === 'DeleteEntry') {
        const [segment, Offset] = this.locate(root.Segments, root.Locations, command.EntryId);
        const Old = segment.Entries[Offset];
        if (!isNativePayload(Old.Content)) return;
        const partition = root.Partitions.get(segment.SegmentId) ?? ContextIndexPartition.Empty;
        return { Kind: 'Deletion', SegmentId: segment.SegmentId, Offset, Old, SegmentBytes: this.segmentEstimates.get(segment)!,
          Limits: this.options.PartitionedIndex, Empty: segment.Entries.length === 1,
          BaseContribution: partition.Contributions.get(Old.EntryId), BaseBytes: partition.BaseBytes,
          Overrides: partition.Overrides, WorkingSetBytes: partition.WorkingSetBytes };
      }
      const Segments = new Map<Int64, ReplacementSegmentInput>();
      const Edits: ReplacementBatchInput['Edits'][number][] = [];
      for (const change of changes.Changes) {
        if (change?.kind !== 'ReplaceEntry' || !Array.isArray(change.IndexKeys) || typeof change.EntryId !== 'string' ||
            !isNativePayload(change.Content)) return;
        const [segment, Offset] = this.locate(root.Segments, root.Locations, change.EntryId);
        const SegmentId = segment.SegmentId;
        const Old = segment.Entries[Offset];
        if (!isNativePayload(Old.Content)) return;
        if (!Segments.has(SegmentId)) {
          const partition = root.Partitions.get(SegmentId) ?? ContextIndexPartition.Empty;
          Segments.set(SegmentId, { SegmentBytes: this.segmentEstimates.get(segment)!, BaseBytes: partition.BaseBytes,
            WorkingSetBytes: partition.WorkingSetBytes, Overrides: partition.Overrides });
        }
        Edits.push({ SegmentId, Offset, Old, Content: change.Content, IndexKeys: change.IndexKeys });
      }
      return { Kind: 'Replacement', Edits, Segments, MaximumSegmentBytes: this.options.MaximumEstimatedBytesPerSegment,
        Limits: this.options.PartitionedIndex };
    } catch { return undefined; }
  }

  private mixedEntryInput(changes: ContextChangeSet, root: SessionRoot, limits: PartitionedContextIndexOptions | null): MixedEntryInput | undefined {
    const Segments = new Map<Int64, MixedSegmentInput>();
    const Anchors = new Map<Guid, ConversationAnchor>();
    const Seen = new Set<Guid>();
    const Commands: ContextChangeSet['Changes'][number][] = [];
    const includeSegment = (segment: ContextSegment) => {
      if (Segments.has(segment.SegmentId)) return true;
      if (!segment.Entries.every((entry) => isNativePayload(entry.Content))) return false;
      const partition = root.Partitions.get(segment.SegmentId);
      const Contributions = new Map<Guid, PartitionContribution>();
      if (partition) for (const entry of segment.Entries) {
        const value = partition.Contributions.get(entry.EntryId);
        if (value) Contributions.set(entry.EntryId, value);
      }
      Segments.set(segment.SegmentId, { Segment: segment, Bytes: this.segmentEstimates.get(segment)!,
        Partition: partition && { BaseBytes: partition.BaseBytes, WorkingSetBytes: partition.WorkingSetBytes,
          Overrides: partition.Overrides, Contributions } });
      return true;
    };
    const includeAnchor = (id: Guid) => {
      const anchor = root.Session.Anchors.get(canonicalGuid(id));
      if (anchor) Anchors.set(anchor.AnchorId, anchor);
    };
    const entrySegment = (id: Guid) => {
      const location = root.Locations.get(canonicalGuid(id));
      return location ? root.Segments.get(location[0]) : undefined;
    };
    for (const edit of changes.Changes) {
      let segment: ContextSegment | undefined;
      if (edit?.kind === 'ReplaceEntry' && !isNativePayload(edit.Content)) return;
      switch (edit?.kind) {
        case 'ReplaceEntry':
        case 'DeleteEntry':
          segment = entrySegment(edit.EntryId);
          break;
        case 'ReplaceSegment':
          if (!Array.isArray(edit.Entries) || !Array.from(edit.Entries).every((entry) => entry && isNativePayload(entry.Content))) return;
          segment = root.Segments.get(canonicalInt64(edit.SegmentId));
          break;
        case 'AppendEntries': {
          if (!Array.isArray(edit.Entries)) return;
          for (const draft of edit.Entries) {
            if (!draft || !isNativePayload(draft.Content)) return;
            if (draft.EntryId === emptyId || draft.EntryId === '') continue;
            const id = canonicalGuid(draft.EntryId);
            if (root.Seen.has(id)) Seen.add(id);
          }
          segment = root.Segments.get(advanceInt64(root.NextSegment, -1n));
          break;
        }
        case 'PutAnchor': {
          const { StartEntryId, EndEntryId, AnchorId } = edit.Anchor;
          const start = entrySegment(StartEntryId);
          const end = entrySegment(EndEntryId);
          if ((start && !includeSegment(start)) || (end && !includeSegment(end))) return;
          includeAnchor(AnchorId);
          break;
        }
        case 'RemoveAnchor':
          includeAnchor(edit.AnchorId);
          break;
        case 'SetSessionStatus':
          break;
        default: return;
      }
      if (segment && !includeSegment(segment)) return;
      Commands.push(edit);
    }
    return { Kind: 'MixedEntry', SessionId: root.Session.SessionId, Revision: root.Session.Revision, Status: root.Session.Status,
      Commands, Segments, Anchors, Seen: [...Seen], NextSequence: root.NextSequence, NextSegment: root.NextSegment,
      MaximumEntriesPerSegment: this.options.MaximumEntriesPerSegment, MaximumSegmentBytes: this.options.MaximumEstimatedBytesPerSegment,
      Limits: limits, IndexingMode: this.options.IndexingMode };
  }

  public static collectEntryPreparation(input: EntryPreparationInput, checkCancellation: () => void): EntryPreparationOutput {
    if (input.Kind === 'Append' || input.Kind === 'MixedEntry') {
      const store = new SessionStore({ ...defaultLLMContextOptions,
        IndexingMode: input.Kind === 'MixedEntry' ? input.IndexingMode : ContextIndexingMode.ProducerOwned,
        PartitionedIndex: input.Limits, MaximumEntriesPerSegment: input.MaximumEntriesPerSegment,
        MaximumEstimatedBytesPerSegment: input.MaximumSegmentBytes });
      return input.Kind === 'Append' ? store.collectAppend(input, checkCancellation) : store.collectMixedEntry(input, checkCancellation);
    }
    const store = new SessionStore({ ...defaultLLMContextOptions, IndexingMode: ContextIndexingMode.ProducerOwned });
    if (input.Kind === 'Deletion') return store.collectDeletion(input);
    if (input.Kind === 'SegmentReplacement') return store.collectSegmentReplacement(input, checkCancellation);
    const buffers = new Map<Int64, { bytes: bigint; partition: ContextIndexPartition;
      latest: Map<number, ContextEntry>; overrides: Map<Guid, PartitionContribution> }>();
    const Edits: ReplacementBatchOutput['Edits'][number][] = [];
    let activeSegment: Int64 = 0;
    try {
      for (const edit of input.Edits) {
        checkCancellation();
        const { SegmentId, Offset } = edit;
        activeSegment = SegmentId;
        let buffer = buffers.get(SegmentId);
        if (!buffer) {
          const source = input.Segments.get(SegmentId)!;
          buffer = { bytes: source.SegmentBytes, latest: new Map(), overrides: new Map(),
            partition: new ContextIndexPartition(new Map(), new Map(), source.Overrides, source.BaseBytes, source.WorkingSetBytes) };
          buffers.set(SegmentId, buffer);
        }
        const old = buffer.latest.get(Offset) ?? { ...edit.Old, Content: restoreWireContent(edit.Old.Content) };
        const replacement = store.copyEntry({ ...old, Content: restoreWireContent(edit.Content), IndexKeys: edit.IndexKeys });
        buffer.bytes = checkedInt64(checkedInt64(buffer.bytes + store.entryBytes(replacement)) - store.entryBytes(old));
        if (buffer.bytes > input.MaximumSegmentBytes) throw new RangeError('Segment limit exceeded.');
        if (!store.sameKeys(old.IndexKeys!, replacement.IndexKeys!)) {
          const contribution = store.contribution(replacement);
          buffer.partition = buffer.partition.Override(old.EntryId, contribution, input.Limits);
          buffer.overrides.set(old.EntryId, contribution);
        }
        buffer.latest.set(Offset, replacement);
        Edits.push({ SegmentId, Offset, Content: replacement.Content, IndexKeys: replacement.IndexKeys! });
      }
      let RewrittenBytes = 0n;
      const Segments = new Map<Int64, ReplacementSegmentOutput>();
      for (const [id, buffer] of buffers) {
        RewrittenBytes = checkedInt64(RewrittenBytes + buffer.bytes);
        Segments.set(id, { SegmentBytes: buffer.bytes, WorkingSetBytes: buffer.partition.WorkingSetBytes, Overrides: buffer.overrides });
      }
      return { Edits, Segments, RewrittenBytes };
    } catch (error) {
      return { Error: (error as Error).message, Capacity: error instanceof PartitionCapacityException ? {
        CanSynchronize: error.CanSynchronize && !!input.Segments.get(activeSegment)?.Overrides.size, SegmentId: activeSegment,
      } : undefined };
    }
  }

  private collectMixedEntry(input: MixedEntryInput, checkCancellation: () => void): EntryPreparationOutput {
    let segments = new OrderedInt64Map<ContextSegment>();
    let partitions = new OrderedInt64Map<ContextIndexPartition>();
    let locations = new PersistentStringTree<EntryLocation>();
    let seen = new PersistentStringTree<true>();
    for (const id of input.Seen) seen = seen.set(id, true);
    for (const [id, source] of input.Segments) {
      checkCancellation();
      const Entries = source.Segment.Entries.map((entry) => ({ ...entry, Content: restoreWireContent(entry.Content) }));
      const segment = { ...source.Segment, Entries };
      this.segmentEstimates.set(segment, source.Bytes);
      segments = segments.add(id, segment, 128n + source.Bytes);
      for (const [offset, entry] of Entries.entries()) {
        locations = locations.set(entry.EntryId, [id, offset]);
        seen = seen.set(entry.EntryId, true);
      }
      if (source.Partition) {
        const { BaseBytes, WorkingSetBytes, Overrides, Contributions } = source.Partition;
        const partition = new ContextIndexPartition(Contributions, new Map(), Overrides, BaseBytes, WorkingSetBytes);
        partitions = partitions.add(id, partition, BigInt(partition.EstimatedBytes));
      }
    }
    const current = this.root({ SessionId: input.SessionId, UserId: input.SessionId, RepositoryId: null, Revision: input.Revision,
      Status: input.Status, Anchors: input.Anchors, Segments: segments },
    seen, locations, input.NextSequence, input.NextSegment, partitions);
    const Changes = input.Commands.map((edit): ContextChangeSet['Changes'][number] => {
      if (edit.kind === 'ReplaceEntry') return { ...edit, Content: restoreWireContent(edit.Content) };
      if (edit.kind === 'ReplaceSegment') return { ...edit, Entries: edit.Entries.map((entry) =>
        ({ ...entry, Content: restoreWireContent(entry.Content) })) };
      if (edit.kind === 'AppendEntries') return { ...edit, Entries: edit.Entries.map((draft) =>
        ({ ...draft, Content: restoreWireContent(draft.Content) })) };
      return edit;
    });
    const Edits: MixedEntryOutput['Edits'][number][] = [];
    try {
      const prepared = this.prepareSession({ SessionId: input.SessionId, ExpectedRevision: input.Revision, Changes }, current, {
        entry(old, Value) { Edits.push({ Kind: 'Entry', Id: (old ?? Value)!.EntryId, Value }); },
        anchor(old, Value) { Edits.push({ Kind: 'Anchor', Id: (old ?? Value)!.AnchorId, Value }); },
      }, checkCancellation);
      if (!('publish' in prepared)) return { Error: prepared.Error! };
      const Mixed = new Map<Int64, MixedSegmentOutput>();
      for (const [id, segment] of prepared.Next.Segments) {
        if (segment === segments.get(id)) continue;
        const partition = prepared.Next.Partitions.get(id);
        Mixed.set(id, { Ids: segment.Entries.map((entry) => entry.EntryId), Bytes: this.segmentEstimates.get(segment)!,
          Partition: partition && { Overrides: partition.Overrides, BaseBytes: partition.BaseBytes, WorkingSetBytes: partition.WorkingSetBytes,
            PreservesBase: partition.Contributions === partitions.get(id)?.Contributions } });
      }
      const Appended = prepared.publish().AppendedEntryIds;
      return { Mixed, Edits, Appended, Status: prepared.Next.Session.Status, NextSequence: prepared.Next.NextSequence,
        NextSegment: prepared.Next.NextSegment, Rewrites: Number(this.rewrittenSegments), RewrittenBytes: this.rewrittenBytes };
    } catch (error) {
      return { Error: (error as Error).message, Capacity: error instanceof PartitionCapacityException ? {
        CanSynchronize: error.CanSynchronize, SegmentId: error.SegmentId,
      } : undefined };
    }
  }

  private collectAppend(input: AppendInput, checkCancellation: () => void): EntryPreparationOutput {
    // The append algorithm touches only the tail, counters, and candidate identities.
    let segments = new OrderedInt64Map<ContextSegment>();
    let partitions = new OrderedInt64Map<ContextIndexPartition>();
    let seen = new PersistentStringTree<true>();
    let locations = new PersistentStringTree<EntryLocation>();
    for (const id of input.Seen) seen = seen.set(id, true);
    const tail = input.Tail?.Segment;
    if (tail && input.Tail) {
      const { SegmentBytes, Partition } = input.Tail;
      this.segmentEstimates.set(tail, SegmentBytes);
      segments = segments.add(tail.SegmentId, tail, 128n + SegmentBytes);
      if (Partition) {
        const { BaseBytes, WorkingSetBytes, Overrides } = Partition;
        const partition = new ContextIndexPartition(new Map(), new Map(), Overrides, BaseBytes, WorkingSetBytes);
        partitions = partitions.add(tail.SegmentId, partition, BigInt(partition.EstimatedBytes));
      }
      for (const [offset, entry] of tail.Entries.entries()) {
        seen = seen.set(entry.EntryId, true);
        locations = locations.set(entry.EntryId, [tail.SegmentId, offset]);
      }
    }
    const root = this.root({ SessionId: input.SessionId, UserId: input.SessionId, RepositoryId: null, Revision: input.Revision,
      Status: SessionStatus.Active, Anchors: new Map(), Segments: segments },
    seen, locations, input.NextSequence, input.NextSegment, partitions, 0n);
    const drafts = input.Drafts.map((draft) => ({ ...draft, Content: restoreWireContent(draft.Content) }));
    try {
      const prepared = this.prepareSession({ SessionId: input.SessionId, ExpectedRevision: input.Revision,
        Changes: [{ kind: 'AppendEntries', Entries: drafts }] }, root, { entry() {}, anchor() {} }, checkCancellation);
      if (!('publish' in prepared)) return { Error: prepared.Error! };
      const { Next } = prepared;
      const Append = new Map<Int64, AppendSegmentOutput>();
      for (const [id, segment] of Next.Segments) {
        if (segment === tail) continue;
        const Entries = tail?.SegmentId === id ? segment.Entries.slice(tail.Entries.length) : segment.Entries;
        const partition = Next.Partitions.get(id)!;
        const Overrides = new Map(Entries.map((entry) => [entry.EntryId, partition.Overrides.get(entry.EntryId)!]));
        Append.set(id, { Entries, Overrides, SegmentBytes: this.segmentEstimates.get(segment)!, WorkingSetBytes: partition.WorkingSetBytes });
      }
      return { Append, Ids: prepared.publish().AppendedEntryIds, NextSequence: Next.NextSequence, NextSegment: Next.NextSegment,
        RewrittenBytes: this.rewrittenBytes };
    } catch (error) {
      return { Error: (error as Error).message, Capacity: error instanceof PartitionCapacityException ? {
        CanSynchronize: error.CanSynchronize, SegmentId: error.SegmentId,
      } : undefined };
    }
  }

  private collectSegmentReplacement(input: SegmentReplacementInput, checkCancellation: () => void): EntryPreparationOutput {
    const { SegmentId, Old, Entries } = input;
    try {
      const validated = Entries.map((entry, offset) => {
        checkCancellation();
        const value = this.copyEntry({ ...entry, Content: restoreWireContent(entry.Content) });
        if (value.EntryId !== Old[offset].EntryId || value.Sequence !== Old[offset].Sequence) {
          throw new TypeError('Segment replacement cannot change identities or ordering.');
        }
        return value;
      });
      let bytes = input.SegmentBytes;
      for (const [offset, value] of validated.entries()) {
        checkCancellation();
        const old = Old[offset];
        bytes = checkedInt64(checkedInt64(bytes + this.entryBytes(value)) -
          this.entryBytes({ ...old, Content: restoreWireContent(old.Content) }));
      }
      if (bytes > input.MaximumSegmentBytes) throw new RangeError('Segment limit exceeded.');
      let partition = new ContextIndexPartition(new Map(), new Map(), input.Overrides, input.BaseBytes, input.WorkingSetBytes);
      const overrides = new Map<Guid, PartitionContribution>();
      const edits = validated.map((Value, Offset) => {
        checkCancellation();
        if (!this.sameKeys(Old[Offset].IndexKeys!, Value.IndexKeys!)) {
          const contribution = this.contribution(Value);
          partition = partition.Override(Value.EntryId, contribution, input.Limits);
          overrides.set(Value.EntryId, contribution);
        }
        return { SegmentId, Offset, Content: Value.Content, IndexKeys: Value.IndexKeys!, Metadata: Value };
      });
      return { Edits: edits, RewrittenBytes: bytes,
        Segments: new Map([[SegmentId, { SegmentBytes: bytes, WorkingSetBytes: partition.WorkingSetBytes, Overrides: overrides }]]) };
    } catch (error) {
      return { Error: (error as Error).message, Capacity: error instanceof PartitionCapacityException ? {
        CanSynchronize: error.CanSynchronize && !!input.Overrides.size, SegmentId,
      } : undefined };
    }
  }

  private collectDeletion(input: DeletionInput): EntryPreparationOutput {
    const { SegmentId, Offset, Empty, BaseContribution } = input;
    try {
      const old = { ...input.Old, Content: restoreWireContent(input.Old.Content) };
      const SegmentBytes = checkedInt64(input.SegmentBytes - this.entryBytes(old));
      const Tombstone = !Empty && !!BaseContribution;
      const next = Empty ? ContextIndexPartition.Empty : new ContextIndexPartition(
        BaseContribution ? new Map([[old.EntryId, BaseContribution]]) : new Map(),
        new Map(), input.Overrides, input.BaseBytes, input.WorkingSetBytes)
        .Override(old.EntryId, null, input.Limits);
      return { Delete: { SegmentId, Offset, SegmentBytes, Empty, Tombstone, WorkingSetBytes: next.WorkingSetBytes } };
    } catch (error) {
      return { Error: (error as Error).message, Capacity: error instanceof PartitionCapacityException ? {
        CanSynchronize: error.CanSynchronize, SegmentId,
      } : undefined };
    }
  }

  public acceptEntryPreparation(root: SessionRoot, prepared: EntryPreparationOutput, index: SessionIndexEdits):
    ContextMutationResult | PreparedSessionChange | undefined {
    if ('Error' in prepared) {
      if (prepared.Capacity) throw new PartitionCapacityException(prepared.Capacity.CanSynchronize, prepared.Error, prepared.Capacity.SegmentId);
      return new ContextMutationResult(ContextMutationStatus.InvalidOperation, root.Session.Revision, prepared.Error);
    }
    if ('Delete' in prepared) return this.acceptDeletion(root, prepared.Delete, index);
    if ('Append' in prepared) return this.acceptAppend(root, prepared, index);
    if ('Mixed' in prepared) return this.acceptMixedEntry(root, prepared, index);
    const buffers = new Map<Int64, ContextEntry[]>();
    for (const edit of prepared.Edits) {
      let entries = buffers.get(edit.SegmentId);
      if (!entries) {
        entries = copySegmentEntries(root.Segments.get(edit.SegmentId)!);
        buffers.set(edit.SegmentId, entries);
      }
      const old = entries[edit.Offset];
      const replacement = Object.freeze({ ...(edit.Metadata ?? old), Content: restoreWireContent(edit.Content),
        IndexKeys: new ContextIndexKeys(edit.IndexKeys).Keys });
      index.entry(old, replacement);
      entries[edit.Offset] = replacement;
    }
    const revision = advanceInt64(root.Session.Revision);
    let segments = root.Segments;
    let partitions = root.Partitions;
    for (const [id, segment] of prepared.Segments) {
      const next = this.segment(id, revision, buffers.get(id)!, segment.SegmentBytes);
      segments = segments.add(id, next, 128n + segment.SegmentBytes);
      if (segment.Overrides.size) {
        const previous = partitions.get(id) ?? ContextIndexPartition.Empty;
        const overrides = new Map(previous.Overrides);
        for (const [entryId, contribution] of segment.Overrides) {
          const [, offset] = root.Locations.get(entryId)!;
          overrides.set(entryId, { ...contribution, Terms: next.Entries[offset].IndexKeys! });
        }
        const partition = new ContextIndexPartition(previous.Contributions, previous.Search, overrides, previous.BaseBytes, segment.WorkingSetBytes);
        partitions = partitions.add(id, partition, BigInt(partition.EstimatedBytes));
      }
    }
    const next = this.root({ ...root.Session, Revision: revision, Segments: segments },
      root.Seen, root.Locations, root.NextSequence, root.NextSegment, partitions, root.AnchorBytes);
    return this.preparedChange(root, next, prepared.Segments.size, prepared.RewrittenBytes, []);
  }

  private acceptMixedEntry(root: SessionRoot, prepared: MixedEntryOutput, index: SessionIndexEdits): PreparedSessionChange | undefined {
    if (prepared.Appended.some((id) => root.Seen.has(id))) return undefined;
    const edited = new Map<Guid, ContextEntry | undefined>();
    let { Seen: seen, Locations: locations, Segments: segments, Partitions: partitions } = root;
    for (const id of prepared.Appended) seen = seen.set(id, true);
    let anchorBytes = root.AnchorBytes;
    let anchors: Map<Guid, ConversationAnchor> | undefined;
    const revision = advanceInt64(root.Session.Revision);
    const original = (id: Guid) => {
      const location = root.Locations.get(id);
      return location && root.Segments.get(location[0])!.Entries[location[1]];
    };
    for (const edit of prepared.Edits) {
      const { Id: id } = edit;
      if (edit.Kind === 'Anchor') {
        anchors ??= new Map(root.Session.Anchors);
        const old = anchors.get(id);
        const next = edit.Value && Object.freeze({ ...edit.Value, Topics: Object.freeze([...edit.Value.Topics]),
          IndexKeys: this.copyKeys(edit.Value.IndexKeys) });
        index.anchor(old, next);
        if (next) anchors.set(id, next);
        else anchors.delete(id);
        anchorBytes = next ? checkedInt64(anchorBytes + this.anchorBytes(next) - (old ? this.anchorBytes(old) : 0n)) :
          anchorBytes - this.anchorBytes(old!);
        continue;
      }
      const old = edited.has(id) ? edited.get(id) : original(id);
      const value = edit.Value;
      const next = value && Object.freeze({ ...value, Content: restoreWireContent(value.Content),
        IndexKeys: this.copyKeys(value.IndexKeys) });
      index.entry(old, next);
      edited.set(id, next);
      if (!next) locations = locations.delete(id);
    }
    for (const [id, state] of prepared.Mixed) {
      const entries = state.Ids.map((entryId) => (edited.get(entryId) ?? original(entryId))!);
      const shifted: [Guid, EntryLocation][] = [];
      for (const [offset, entry] of entries.entries()) {
        const previous = locations.get(entry.EntryId);
        if (!previous) locations = locations.set(entry.EntryId, [id, offset]);
        else if (previous[1] !== offset) shifted.push([entry.EntryId, [id, offset]]);
      }
      if (shifted.length) locations = updateEntryLocations(locations, shifted);
      segments = segments.add(id, this.segment(id, revision, entries, state.Bytes), 128n + state.Bytes);
      if (!state.Partition) partitions = partitions.remove(id);
      else {
        const previous = (state.Partition.PreservesBase && partitions.get(id)) || ContextIndexPartition.Empty;
        const overrides = new Map<Guid, PartitionContribution | null>();
        for (const [entryId, value] of state.Partition.Overrides) {
          const existing = previous.Overrides.get(entryId);
          overrides.set(entryId, value && (existing && this.sameKeys(existing.Terms, value.Terms) ? existing :
            { ...value, Terms: new ContextIndexKeys(value.Terms).Keys }));
        }
        const next = new ContextIndexPartition(previous.Contributions, previous.Search, overrides, state.Partition.BaseBytes, state.Partition.WorkingSetBytes);
        partitions = partitions.add(id, next, BigInt(next.EstimatedBytes));
      }
    }
    const next = this.root({ ...root.Session, Revision: revision, Segments: segments, Status: prepared.Status,
      Anchors: anchors ?? root.Session.Anchors }, seen, locations, prepared.NextSequence, prepared.NextSegment, partitions, anchorBytes);
    return this.preparedChange(root, next, prepared.Rewrites, prepared.RewrittenBytes, prepared.Appended);
  }

  private acceptAppend(root: SessionRoot, prepared: AppendOutput, index: SessionIndexEdits): PreparedSessionChange | undefined {
    if (prepared.Ids.some((id) => root.Seen.has(id))) return undefined;
    let { Locations: locations, Seen: seen, Segments: segments, Partitions: partitions } = root;
    const revision = advanceInt64(root.Session.Revision);
    for (const [id, append] of prepared.Append) {
      const previous = segments.get(id);
      const entries = previous ? copySegmentEntries(previous) : [];
      const base = partitions.get(id) ?? ContextIndexPartition.Empty;
      const overrides = new Map(base.Overrides);
      for (const wire of append.Entries) {
        const entry = Object.freeze({ ...wire, Content: restoreWireContent(wire.Content), IndexKeys: new ContextIndexKeys(wire.IndexKeys!).Keys });
        locations = locations.set(entry.EntryId, [id, entries.length]);
        seen = seen.set(entry.EntryId, true);
        entries.push(entry);
        index.entry(undefined, entry);
        overrides.set(entry.EntryId, { ...append.Overrides.get(entry.EntryId)!, Terms: entry.IndexKeys });
      }
      segments = segments.add(id, this.segment(id, revision, entries, append.SegmentBytes), 128n + append.SegmentBytes);
      const partition = new ContextIndexPartition(base.Contributions, base.Search, overrides, base.BaseBytes, append.WorkingSetBytes);
      partitions = partitions.add(id, partition, BigInt(partition.EstimatedBytes));
    }
    const next = this.root({ ...root.Session, Revision: revision, Segments: segments }, seen, locations,
      prepared.NextSequence, prepared.NextSegment, partitions, root.AnchorBytes);
    return this.preparedChange(root, next, prepared.Ids.length, prepared.RewrittenBytes, prepared.Ids);
  }

  private acceptDeletion(root: SessionRoot, deletion: DeletionOutput['Delete'], index: SessionIndexEdits): PreparedSessionChange {
    const { SegmentId, Offset, SegmentBytes, Empty, Tombstone, WorkingSetBytes } = deletion;
    const entries = copySegmentEntries(root.Segments.get(SegmentId)!);
    const old = entries[Offset];
    entries.splice(Offset, 1);
    index.entry(old, undefined);
    let locations = root.Locations.delete(old.EntryId);
    if (Offset < entries.length) {
      const shifted: [Guid, EntryLocation][] = [];
      for (let offset = Offset; offset < entries.length; offset++) shifted.push([entries[offset].EntryId, [SegmentId, offset]]);
      locations = updateEntryLocations(locations, shifted);
    }
    const revision = advanceInt64(root.Session.Revision);
    const segments = root.Segments.add(SegmentId, this.segment(SegmentId, revision, entries, SegmentBytes), 128n + SegmentBytes);
    let partitions = root.Partitions;
    if (Empty) partitions = partitions.remove(SegmentId);
    else {
      const previous = partitions.get(SegmentId) ?? ContextIndexPartition.Empty;
      const overrides = new Map(previous.Overrides);
      if (Tombstone) overrides.set(old.EntryId, null);
      else overrides.delete(old.EntryId);
      const partition = new ContextIndexPartition(previous.Contributions, previous.Search, overrides, previous.BaseBytes, WorkingSetBytes);
      partitions = partitions.add(SegmentId, partition, BigInt(partition.EstimatedBytes));
    }
    const next = this.root({ ...root.Session, Revision: revision, Segments: segments },
      root.Seen, locations, root.NextSequence, root.NextSegment, partitions, root.AnchorBytes);
    return this.preparedChange(root, next, 1, SegmentBytes, []);
  }

  public prepareSession(changes: ContextChangeSet, current: SessionRoot, index: SessionIndexEdits, checkCancellation?: () => void):
    ContextMutationResult | PreparedSessionChange {
    const previous = current.Session;

    try {
      if (!Array.isArray(changes.Changes) || !changes.Changes.length) throw new TypeError('Empty session change.');
      const revision = advanceInt64(previous.Revision);
      let segments = current.Segments;
      let editedAnchors: Map<Guid, ConversationAnchor> | undefined;
      let seen = current.Seen;
      let locations = current.Locations;
      let partitions = current.Partitions;
      let anchorBytes = current.AnchorBytes;
      const limits = this.options.PartitionedIndex;
      const appended: Guid[] = [];
      let nextSequence = current.NextSequence;
      let nextSegment = current.NextSegment;
      let status = previous.Status;
      let rewrites = 0;
      let bytesRewritten = 0n;
      const publishSegment = (next: ContextSegment) => {
        const bytes = this.segmentEstimates.get(next)!;
        bytesRewritten = checkedInt64(bytesRewritten + bytes);
        rewrites++;
        segments = segments.add(next.SegmentId, next, 128n + bytes);
      };
      const updatePartition = (id: Int64, update: (partition: ContextIndexPartition) => ContextIndexPartition) => {
        try {
          const next = update(partitions.get(id) ?? ContextIndexPartition.Empty);
          partitions = partitions.add(id, next, BigInt(next.EstimatedBytes));
        } catch (error) {
          if (!(error instanceof PartitionCapacityException)) throw error;
          throw new PartitionCapacityException(error.CanSynchronize && !!current.Partitions.get(id)?.Overrides.size,
            error.message, id);
        }
      };
      const rewrite = (id: Int64, entries: readonly ContextEntry[]) => {
        if (entries.length > this.options.MaximumEntriesPerSegment) throw new RangeError('Segment limit exceeded.');
        const previous = segments.get(id);
        const previousEntries = new Map(previous?.Entries.map((entry) => [entry.EntryId, entry]));
        const edited: [ContextEntry | undefined, ContextEntry][] = [];
        let bytes = previous ? this.segmentEstimates.get(previous)! : 0n;
        for (const entry of entries) {
          const old = previousEntries.get(entry.EntryId);
          previousEntries.delete(entry.EntryId);
          if (old === entry) continue;
          bytes = checkedInt64(checkedInt64(bytes + this.entryBytes(entry)) - (old ? this.entryBytes(old) : 0n));
          edited.push([old, entry]);
        }
        for (const entry of previousEntries.values()) bytes = checkedInt64(bytes - this.entryBytes(entry));
        const next = this.segment(id, revision, entries, bytes);
        if (limits && !entries.length) partitions = partitions.remove(id);
        for (const [old, entry] of edited) {
          index.entry(old, entry);
          if (limits && (!old || !this.sameKeys(old.IndexKeys!, entry.IndexKeys!))) {
            updatePartition(id, (partition) => partition.Override(entry.EntryId, this.contribution(entry), limits));
          }
        }
        for (const entry of previousEntries.values()) {
          index.entry(entry, undefined);
          if (limits && entries.length) updatePartition(id, (partition) => partition.Override(entry.EntryId, null, limits));
          locations = updateEntryLocation(locations, entry.EntryId);
        }
        const shifted: [Guid, EntryLocation][] = [];
        for (const [offset, entry] of entries.entries()) {
          const old = locations.get(entry.EntryId);
          if (!old) locations = updateEntryLocation(locations, entry.EntryId, [id, offset]);
          else if (old[0] !== id || old[1] !== offset) shifted.push([entry.EntryId, [id, offset]]);
        }
        if (shifted.length) locations = updateEntryLocations(locations, shifted);
        publishSegment(next);
      };

      const ordered = changes.Changes as ContextChangeSet['Changes'];
      if (ordered.length > 1 && ordered.every((change) => change.kind === 'ReplaceEntry')) {
        if (status !== SessionStatus.Active) throw new TypeError('Only active sessions accept content changes.');
        const buffers = new Map<Int64, { Entries: ContextEntry[]; Bytes: bigint }>();
        for (const change of ordered) {
          checkCancellation?.();
          const [original, offset] = this.locate(segments, locations, change.EntryId);
          const id = original.SegmentId;
          let buffer = buffers.get(id);
          if (!buffer) {
            buffer = { Entries: [...original.Entries], Bytes: this.segmentEstimates.get(original)! };
            buffers.set(id, buffer);
          }
          const old = buffer.Entries[offset];
          const replacement = this.copyEntry({ ...old, Content: change.Content, IndexKeys: change.IndexKeys });
          const bytes = checkedInt64(checkedInt64(buffer.Bytes + this.entryBytes(replacement)) - this.entryBytes(old));
          if (bytes > this.options.MaximumEstimatedBytesPerSegment) throw new RangeError('Segment limit exceeded.');
          index.entry(old, replacement);
          if (limits && !this.sameKeys(old.IndexKeys!, replacement.IndexKeys!)) {
            updatePartition(id, (partition) => partition.Override(replacement.EntryId, this.contribution(replacement), limits));
          }
          buffer.Entries[offset] = replacement;
          buffer.Bytes = bytes;
        }
        for (const [id, buffer] of buffers) publishSegment(this.segment(id, revision, buffer.Entries, buffer.Bytes));
      } else for (const change of ordered) {
        checkCancellation?.();
        if (status !== SessionStatus.Active && change.kind !== 'SetSessionStatus') {
          throw new TypeError('Only active sessions accept content changes.');
        }
        switch (change.kind) {
          case 'AppendEntries':
            if (!Array.isArray(change.Entries)) throw new TypeError('Entries must be initialized.');
            for (const draft of change.Entries) {
              checkCancellation?.();
              const id = draft.EntryId === emptyId || draft.EntryId === '' ? randomUUID() : canonicalGuid(draft.EntryId);
              if (seen.has(id)) throw new TypeError('Entry identities cannot be reused.');
              const entry = this.copyEntry({ ...draft, EntryId: id, Sequence: nextSequence });
              const entryBytes = this.entryBytes(entry);
              const tail = segments.get(advanceInt64(nextSegment, -1n));
              const partition = tail && partitions.get(tail.SegmentId);
              const overrideBytes = partition && ContextIndexPartition.OverrideBytes(this.contribution(entry));
              const fitsIndex = !partition || (partition.Overrides.size < limits!.MaximumWorkingSetEntries &&
                partition.WorkingSetBytes + overrideBytes! <= limits!.MaximumEstimatedWorkingSetBytes &&
                partition.EstimatedBytes + overrideBytes! <= limits!.MaximumEstimatedPartitionBytes);
              if (tail && tail.Entries.length < this.options.MaximumEntriesPerSegment &&
                  checkedInt64(this.segmentEstimates.get(tail)! + entryBytes) <= this.options.MaximumEstimatedBytesPerSegment && fitsIndex) {
                rewrite(tail.SegmentId, [...tail.Entries, entry]);
              } else {
                rewrite(nextSegment, [entry]);
                nextSegment = advanceInt64(nextSegment);
              }
              seen = seen.set(id, true);
              appended.push(id);
              nextSequence = advanceInt64(nextSequence);
            }
            break;
          case 'ReplaceEntry':
          case 'DeleteEntry': {
            const [segment, offset] = this.locate(segments, locations, change.EntryId);
            const entries = copySegmentEntries(segment);
            if (change.kind === 'DeleteEntry') entries.splice(offset, 1);
            else entries[offset] = this.copyEntry({ ...entries[offset], Content: change.Content, IndexKeys: change.IndexKeys });
            rewrite(segment.SegmentId, entries);
            break;
          }
          case 'ReplaceSegment': {
            const segment = segments.get(canonicalInt64(change.SegmentId));
            if (!segment || !Array.isArray(change.Entries) || change.Entries.length !== segment.Entries.length) {
              throw new TypeError('Segment replacement preserves membership.');
            }
            const entries = change.Entries.map((value, index) => {
              const entry = this.copyEntry(value);
              if (segment.Entries[index].EntryId !== entry.EntryId || segment.Entries[index].Sequence !== entry.Sequence) {
                throw new TypeError('Segment replacement cannot change identities or ordering.');
              }
              return entry;
            });
            rewrite(segment.SegmentId, entries);
            break;
          }
          case 'PutAnchor': {
            const next = this.copyAnchor(change.Anchor, segments, locations, revision);
            const anchors = editedAnchors ??= new Map(previous.Anchors);
            const old = anchors.get(next.AnchorId);
            index.anchor(old, next);
            anchorBytes = checkedInt64(anchorBytes + this.anchorBytes(next) - (old ? this.anchorBytes(old) : 0n));
            anchors.set(next.AnchorId, next);
            break;
          }
          case 'RemoveAnchor': {
            const id = canonicalGuid(change.AnchorId);
            const anchors = editedAnchors ??= new Map(previous.Anchors);
            const old = anchors.get(id);
            if (!old) throw new TypeError('Unknown anchor.');
            index.anchor(old, undefined);
            anchorBytes -= this.anchorBytes(old);
            anchors.delete(id);
            break;
          }
          case 'SetSessionStatus':
            if (!Object.values(SessionStatus).includes(change.Status) ||
                (status === SessionStatus.Expired && change.Status !== SessionStatus.Expired)) {
              throw new TypeError('Invalid session status transition.');
            }
            status = change.Status;
            break;
          default:
            throw new TypeError('Unknown change type.');
        }
      }

      const next = this.root({ ...previous, Revision: revision, Status: status, Segments: segments, Anchors: editedAnchors ?? previous.Anchors },
        seen, locations, nextSequence, nextSegment, partitions, anchorBytes);
      return this.preparedChange(current, next, rewrites, bytesRewritten, appended);
    } catch (error) {
      if (error instanceof PartitionCapacityException) throw error;
      return new ContextMutationResult(ContextMutationStatus.InvalidOperation, previous.Revision, (error as Error).message);
    }
  }

  private preparedChange(current: SessionRoot, next: SessionRoot, rewrites: number, rewrittenBytes: bigint,
    appended: readonly Guid[]): PreparedSessionChange {
    const delta = next.Bytes - current.Bytes;
    return {
      Next: next,
      Delta: delta,
      publish: () => {
        const activeBytes = checkedInt64(this.activeBytes + delta);
        this.rewrittenSegments = BigInt.asIntN(64, this.rewrittenSegments + BigInt(rewrites));
        this.rewrittenBytes = BigInt.asIntN(64, this.rewrittenBytes + rewrittenBytes);
        this.sessions.set(next.Session.SessionId, next);
        this.activeBytes = activeBytes;
        return new ContextMutationResult(ContextMutationStatus.Applied, next.Session.Revision, null, appended);
      },
    };
  }

  private contribution(entry: ContextEntry): PartitionContribution {
    const terms = entry.IndexKeys!;
    const bytes = estimateTermBytes(terms);
    return { Terms: terms, Bytes: bytes, IndexBytes: checked(128 + 6 * bytes) };
  }

  private sameKeys(left: readonly string[], right: readonly string[]): boolean {
    return left === right || (left.length === right.length && left.every((key, index) => key === right[index]));
  }

  private anchorBytes(anchor: ConversationAnchor): bigint {
    const length = anchor.Title.length + anchor.Summary.length + 2 + anchor.Topics.join(' ').length;
    return BigInt(128 + 2 * length + (anchor.IndexKeys ? estimateTermBytes(anchor.IndexKeys) : 0));
  }

  private root(session: LLMSessionContext & { readonly Segments: OrderedInt64Map<ContextSegment> },
    seen: PersistentStringTree<true>, locations: Locations,
    nextSequence: Int64, nextSegment: Int64,
    partitions: OrderedInt64Map<ContextIndexPartition>, anchorBytes?: bigint): SessionRoot {
    if (anchorBytes === undefined) {
      anchorBytes = 0n;
      for (const anchor of session.Anchors.values()) anchorBytes = checkedInt64(anchorBytes + this.anchorBytes(anchor));
    }
    const bytes = checkedInt64(280n + 48n * BigInt(seen.size) + session.Segments.weight + partitions.weight + anchorBytes +
      (this.options.PartitionedIndex ? 16n : 0n));
    const root = Object.freeze({ ...session, Segments: new ImmutableMap(session.Segments),
      Anchors: session.Anchors instanceof ImmutableMap ? session.Anchors : new ImmutableMap(session.Anchors, canonicalGuid) });
    return { Session: root, Segments: session.Segments, Seen: seen, Locations: locations, NextSequence: nextSequence,
      NextSegment: nextSegment, Bytes: bytes, AnchorBytes: anchorBytes, Partitions: partitions };
  }

  private segment(id: Int64, revision: Int64, entries: readonly ContextEntry[], bytes = this.segmentBytes(entries)): ContextSegment {
    if (entries.length > this.options.MaximumEntriesPerSegment || bytes > this.options.MaximumEstimatedBytesPerSegment) {
      throw new RangeError('Segment limit exceeded.');
    }
    const segment = Object.freeze({ SegmentId: id, Revision: revision, Entries: Object.freeze(entries) });
    this.segmentEstimates.set(segment, bytes);
    return segment;
  }

  private segmentBytes(entries: readonly ContextEntry[]): bigint {
    return entries.reduce((sum, entry) => checkedInt64(sum + this.entryBytes(entry)), 0n);
  }

  private entryBytes(entry: ContextEntry): bigint {
    const bytes = this.options.EntrySizeEstimator(entry);
    if (!isPositiveInt64(bytes)) throw new RangeError('Entry size estimates must be positive.');
    return BigInt(bytes);
  }

  private copyKeys(keys: readonly string[] | undefined): readonly string[] | undefined {
    if ((keys != null) !== (this.options.IndexingMode === ContextIndexingMode.ProducerOwned)) {
      throw new TypeError('ProducerOwned requires explicit keys; Text does not accept supplied keys.');
    }
    return keys == null || isNativePayload(keys) ? keys ?? undefined : new ContextIndexKeys(keys).Keys;
  }

  private copyEntry(value: ContextEntry): ContextEntry {
    if (!value || !validId(value.EntryId) || !nonnegative(value.Sequence) || !Object.values(ContextRole).includes(value.Role)) {
      throw new TypeError('Invalid entry identity, ordering or role.');
    }
    if (typeof value.CreatedAt !== 'string') throw new TypeError('Entry creation time must be a timestamp.');
    timestampTicks(value.CreatedAt);
    const { Content: content, Role: role } = value;
    const native = isNativePayload(content);
    let copy: ContextEntry['Content'];
    if (content instanceof TextContent && typeof content.Text === 'string') copy = native ? content : new TextContent(content.Text);
    else if (content instanceof ToolCallContent && role === ContextRole.Assistant && typeof content.CallId === 'string' &&
        content.CallId.trim() && typeof content.ToolName === 'string' && content.ToolName.trim() &&
        typeof content.ArgumentsJson === 'string') {
      copy = native ? content : new ToolCallContent(content.CallId, content.ToolName, content.ArgumentsJson);
    } else if (content instanceof ToolResultContent && role === ContextRole.Tool && typeof content.CallId === 'string' &&
        content.CallId.trim() && typeof content.ResultJson === 'string' && typeof content.IsError === 'boolean') {
      copy = native ? content : new ToolResultContent(content.CallId, content.ResultJson, content.IsError);
    } else if (content instanceof SummaryContent && typeof content.Text === 'string' &&
        nonnegative(content.ThroughSequence) && content.ThroughSequence < value.Sequence) {
      const through = canonicalInt64(content.ThroughSequence);
      copy = native && through === content.ThroughSequence ? content : new SummaryContent(content.Text, through);
    } else throw new TypeError('Invalid or unsupported content.');
    return Object.freeze({ ...value, EntryId: canonicalGuid(value.EntryId), Sequence: canonicalInt64(value.Sequence),
      Content: copy, IndexKeys: this.copyKeys(value.IndexKeys) });
  }

  private copyAnchor(anchor: ConversationAnchor, segments: ReadonlyMap<Int64, ContextSegment>,
    locations: Locations, revision: Int64): ConversationAnchor {
    if (!validId(anchor.AnchorId) || typeof anchor.Title !== 'string' || !anchor.Title.trim() ||
        typeof anchor.Summary !== 'string' || !Array.isArray(anchor.Topics) || anchor.Topics.some((topic) => typeof topic !== 'string') ||
        !Object.values(AnchorKind).includes(anchor.Kind) || !nonnegative(anchor.SourceRevision) || anchor.SourceRevision > revision ||
        (anchor.PinnedRevision != null && (!nonnegative(anchor.PinnedRevision) || anchor.PinnedRevision > revision))) {
      throw new TypeError('Invalid anchor metadata.');
    }
    const [start, startOffset] = this.locate(segments, locations, anchor.StartEntryId);
    const [end, endOffset] = this.locate(segments, locations, anchor.EndEntryId);
    if (start.Entries[startOffset].Sequence > end.Entries[endOffset].Sequence) throw new TypeError('Anchor range is reversed.');
    return Object.freeze({ ...anchor, AnchorId: canonicalGuid(anchor.AnchorId), StartEntryId: canonicalGuid(anchor.StartEntryId),
      EndEntryId: canonicalGuid(anchor.EndEntryId), Topics: Object.freeze([...anchor.Topics]), IndexKeys: this.copyKeys(anchor.IndexKeys),
      SourceRevision: canonicalInt64(anchor.SourceRevision), PinnedRevision: anchor.PinnedRevision == null ? null : canonicalInt64(anchor.PinnedRevision) });
  }

  private locate(segments: ReadonlyMap<Int64, ContextSegment>, locations: Locations,
    id: Guid): [ContextSegment, number] {
    const location = locations.get(canonicalGuid(id));
    if (!location) throw new TypeError('Unknown entry.');
    return [segments.get(location[0])!, location[1]];
  }
}
