// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextIndexingMode } from '../domain/index-keys.js';
import { advanceInt64, checkedInt64, compareInt64, type Int64 } from '../domain/int64.js';
import type { ContextContent, ContextEntry, ContextIndexStatus, ContextSearchHit, ConversationAnchor, Guid, LLMSessionContext } from '../domain/session.js';
import { ContextIndexingStrategy, indexRetentionReservation, indexWorkReservation, type ContextExecution } from '../execution/strategy.js';
import type { LLMContextOptions } from '../options.js';
import { Terms, Text } from '../policies/context.js';
import { scanTerms, textLength, textParts } from '../policies/lexical.js';
import type { ContextIndexPartition } from './partitioned-index.js';
import { PersistentStringTree } from './persistent-string-tree.js';
import { nonnegativeInt64Key } from './ordered-int64-map.js';

interface IndexedEntry {
  readonly Entry: ContextEntry;
  readonly Terms: readonly string[];
  readonly Pending?: PendingEntry;
}

interface PendingEntry {
  readonly Content: ContextContent;
  readonly Prefix: readonly string[];
  readonly Offset: number;
  readonly IndexBytes: number;
  readonly WorkBytes: number;
  readonly Error?: string;
}

export interface IndexJob {
  readonly SessionId: Guid;
  readonly EntryId: Guid;
  readonly Pending: PendingEntry;
}

export interface SessionIndexEdits {
  entry(old: ContextEntry | undefined, next: ContextEntry | undefined): void;
  anchor(old: ConversationAnchor | undefined, next: ConversationAnchor | undefined): void;
}

export interface PreparedSessionIndex {
  readonly Index: SessionIndex;
  readonly Jobs: readonly IndexJob[];
}

type Posting = PersistentStringTree<true>;
type Postings = PersistentStringTree<Posting>;
type Entries = PersistentStringTree<IndexedEntry>;
type Pending = PersistentStringTree<IndexedEntry>;

const anchorText = (anchor: ConversationAnchor) => `${anchor.Title} ${anchor.Summary} ${anchor.Topics.join(' ')}`;
const ordinal = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const entryAddress = (id: Guid) => `e${id}`;
const anchorAddress = (anchor: ConversationAnchor) => `a${JSON.stringify([anchor.StartEntryId, anchor.AnchorId])}`;

export function estimateTermBytes(terms: readonly string[]): number {
  return terms.reduce((sum, term) => sum + 40 + 2 * term.length, 128);
}

function putEntry(entries: Entries, id: Guid, entry: IndexedEntry): Entries {
  return entries.set(id, entry, BigInt(estimateTermBytes(entry.Terms)) + BigInt(entry.Pending?.IndexBytes ?? 0));
}

function putPending(pending: Pending, id: Guid, entry: IndexedEntry): Pending {
  return entry.Pending ? pending.set(id, entry, entry.Pending.Error === undefined ? 0n : 1n) : pending.delete(id);
}

export class SessionIndex {
  public readonly EstimatedBytes: bigint;
  public readonly Status: ContextIndexStatus;

  private constructor(
    private readonly session: LLMSessionContext,
    private readonly entries: Entries,
    private readonly pending: Pending,
    private readonly anchors: PersistentStringTree<ConversationAnchor>,
    private readonly postings: Postings,
    private readonly partitions: ReadonlyMap<Int64, ContextIndexPartition>,
    generation: Int64,
    private readonly order: PersistentStringTree<ContextEntry>,
  ) {
    let firstFailure: IndexedEntry | undefined;
    if (pending.weight) {
      for (const id of pending) {
        const entry = pending.get(id)!;
        if (entry.Pending?.Error !== undefined && (!firstFailure || entry.Entry.Sequence < firstFailure.Entry.Sequence)) {
          firstFailure = entry;
        }
      }
    }
    this.EstimatedBytes = checkedInt64(entries.weight + postings.weight);
    this.Status = Object.freeze({
      SessionRevision: session.Revision, IndexGeneration: generation, PendingEntries: pending.size,
      FailedEntries: Number(pending.weight), Error: firstFailure?.Pending?.Error ?? null, IsComplete: pending.size === 0,
    });
  }

  public static prepare(options: LLMContextOptions, previous: SessionIndex | undefined,
    canDefer: (characters: number) => boolean, execution?: ContextExecution) {
    let entries = previous?.entries ?? new PersistentStringTree<IndexedEntry>();
    let pending = previous?.pending ?? new PersistentStringTree<IndexedEntry>();
    let order = previous?.order ?? new PersistentStringTree<ContextEntry>();
    const changedPending = new Set<Guid>();
    const put = (id: Guid, entry: IndexedEntry) => {
      entries = putEntry(entries, id, entry);
      pending = putPending(pending, id, entry);
      order = order.set(nonnegativeInt64Key(entry.Entry.Sequence), entry.Entry);
      if (entry.Pending) changedPending.add(id);
    };
    let anchors = previous?.anchors ?? new PersistentStringTree<ConversationAnchor>();
    let postings = previous?.postings ?? new PersistentStringTree<Posting>();
    const producerOwned = options.IndexingMode === ContextIndexingMode.ProducerOwned;
    const route = options.Execution.Indexing;
    const limits = options.DeferredIndexing;
    const edits: SessionIndexEdits = {
      entry(oldEntry, entry) {
        const id = (entry ?? oldEntry)!.EntryId;
        const old = entries.get(id);
        if (!entry) {
          if (!options.PartitionedIndex) postings = updatePostings(postings, entryAddress(id), old!.Terms, []);
          entries = entries.delete(id);
          pending = pending.delete(id);
          order = order.delete(nonnegativeInt64Key(old!.Entry.Sequence));
          changedPending.delete(id);
          return;
        }
        if (old && old.Entry.Content === entry.Content && old.Entry.IndexKeys === entry.IndexKeys) {
          if (old.Entry !== entry) put(id, { ...old, Entry: entry });
          return;
        }
        let terms: readonly string[];
        let pendingEntry: PendingEntry | undefined;
        if (producerOwned) {
          terms = entry.IndexKeys!;
          execution?.RecordSuppliedEntry();
        } else {
          let defer = !!limits && route !== ContextIndexingStrategy.Synchronous;
          const characters = textLength(entry.Content);
          const indexBytes = indexRetentionReservation(characters);
          const reservation = indexWorkReservation(characters);
          if (route === ContextIndexingStrategy.AppendOptimized) {
            defer &&= !old && characters >= options.Execution.MinimumDeferredCharacters && canDefer(characters);
          }
          const parts = textParts(entry.Content);
          const prefix = execution ? execution.PrepareEntry(entry.Content, !!old, canDefer) :
            defer ? scanTerms(parts, limits!.ForegroundWords, limits!.ForegroundCharacters) : scanTerms(parts);
          terms = prefix.Terms;
          if (!prefix.Complete) {
            pendingEntry = { Content: entry.Content, Prefix: terms, Offset: prefix.ResumeOffset, IndexBytes: indexBytes, WorkBytes: reservation };
          }
        }
        put(id, { Entry: entry, Terms: terms, Pending: pendingEntry });
        if (!options.PartitionedIndex) postings = updatePostings(postings, entryAddress(id), old?.Terms ?? [], terms);
      },
      anchor(old, next) {
        const collect = (anchor: ConversationAnchor) => producerOwned ? anchor.IndexKeys! :
          execution ? execution.Collect(anchorText(anchor)) : Terms(anchorText(anchor));
        if (old) {
          postings = updatePostings(postings, anchorAddress(old), collect(old), []);
          anchors = anchors.delete(anchorAddress(old));
        }
        if (next) {
          postings = updatePostings(postings, anchorAddress(next), [], collect(next));
          anchors = anchors.set(anchorAddress(next), next);
        }
      },
    };
    return {
      Edits: edits,
      finish(session: LLMSessionContext, partitions: ReadonlyMap<Int64, ContextIndexPartition>): PreparedSessionIndex {
        const jobs: IndexJob[] = [];
        for (const id of changedPending) {
          const entry = pending.get(id);
          if (entry?.Pending && entry.Pending !== previous?.pending.get(id)?.Pending) {
            jobs.push({ SessionId: session.SessionId, EntryId: id, Pending: entry.Pending });
          }
        }
        jobs.sort((left, right) => compareInt64(entries.get(left.EntryId)!.Entry.Sequence, entries.get(right.EntryId)!.Entry.Sequence));
        const generation = previous ? advanceInt64(previous.Status.IndexGeneration,
          limits && route !== ContextIndexingStrategy.Synchronous ? 1n : 0n) : 0;
        return { Index: new SessionIndex(session, entries, pending, anchors, postings, partitions, generation, order), Jobs: jobs };
      },
    };
  }

  public isCurrent(job: IndexJob): boolean {
    return this.entries.get(job.EntryId)?.Pending === job.Pending;
  }

  public complete(job: IndexJob, error?: string, execution?: ContextExecution, collected?: readonly string[]): SessionIndex {
    const old = this.entries.get(job.EntryId)!;
    const pending = job.Pending;
    let postings = this.postings;
    let replacement: IndexedEntry;
    if (error === undefined) {
      const terms = collected ?? (execution ? execution.Complete(pending.Content, { Terms: pending.Prefix, ResumeOffset: pending.Offset, Complete: false }) :
        scanTerms(textParts(pending.Content), Infinity, Infinity, pending.Offset, pending.Prefix).Terms);
      replacement = { Entry: old.Entry, Terms: terms };
      postings = updatePostings(postings, entryAddress(job.EntryId), old.Terms, terms);
    } else {
      replacement = { ...old, Pending: { ...pending, Error: error } };
    }
    return new SessionIndex(this.session, putEntry(this.entries, job.EntryId, replacement), putPending(this.pending, job.EntryId, replacement),
      this.anchors, postings, this.partitions, advanceInt64(this.Status.IndexGeneration), this.order);
  }

  public mergeDeferredProgress(captured: SessionIndex, current: SessionIndex): SessionIndex {
    if (captured === current) return this;
    let entries = this.entries;
    let pending = this.pending;
    let postings = this.postings;
    for (const id of captured.pending) {
      const before = captured.pending.get(id)!.Pending;
      const live = current.entries.get(id)!;
      const candidate = entries.get(id);
      if (!before || !live || live.Pending === before || candidate?.Pending !== before) continue;
      postings = updatePostings(postings, entryAddress(id), candidate.Terms, live.Terms);
      const replacement = { ...live, Entry: candidate.Entry };
      entries = putEntry(entries, id, replacement);
      pending = putPending(pending, id, replacement);
    }
    return new SessionIndex(this.session, entries, pending, this.anchors, postings, this.partitions,
      advanceInt64(current.Status.IndexGeneration), this.order);
  }

  public withPartitions(partitions: ReadonlyMap<Int64, ContextIndexPartition>): SessionIndex {
    return new SessionIndex(this.session, this.entries, this.pending, this.anchors, this.postings, partitions,
      advanceInt64(this.Status.IndexGeneration), this.order);
  }

  public find(id: Guid): ContextEntry | null {
    return this.entries.get(id)?.Entry ?? null;
  }

  public range(fromSequence: Int64, count: number): readonly ContextEntry[] {
    const result: ContextEntry[] = [];
    if (count > 0) {
      for (const entry of this.order.from(nonnegativeInt64Key(fromSequence))) {
        result.push(entry);
        if (result.length === count) break;
      }
    }
    return Object.freeze(result);
  }

  public hasAfter(sequence: Int64): boolean {
    return this.order.hasAfter(nonnegativeInt64Key(sequence));
  }

  public search(terms: readonly string[], limit: number, includePending: boolean): readonly ContextSearchHit[] {
    if (!terms.length || !limit) return Object.freeze([]);
    const sets = terms.map((term) => this.postings.get(term));
    const hits: ContextSearchHit[] = [];
    const add = (entry: ContextEntry, anchor?: ConversationAnchor) => {
      const text = anchor ? anchorText(anchor) : Text(entry.Content);
      hits.push(Object.freeze({
        EntryId: entry.EntryId, AnchorId: anchor?.AnchorId ?? null, Snippet: text.slice(0, 160),
        Sequence: entry.Sequence, SessionRevision: this.session.Revision,
      }));
    };
    if (sets.every((set): set is Posting => set !== undefined)) {
      sets.sort((left, right) => left.size - right.size);
      for (const address of sets[0]) {
        if (!sets.every((set) => set.has(address))) continue;
        if (address[0] === 'a') {
          const anchor = this.anchors.get(address);
          const entry = anchor && this.find(anchor.StartEntryId);
          if (entry && anchor) add(entry, anchor);
        } else add(this.entries.get(address.slice(1))!.Entry);
      }
    }
    for (const partition of this.partitions.values()) {
      const postings = terms.map((term) => partition.Search.get(term));
      if (postings.every((posting): posting is readonly Guid[] => posting !== undefined)) {
        postings.sort((left, right) => left.length - right.length);
        const remaining = postings.slice(1).map((posting) => new Set(posting));
        for (const id of postings[0]) {
          if (!partition.Overrides.has(id) && remaining.every((posting) => posting.has(id))) add(this.find(id)!);
        }
      }
      for (const [id, contribution] of partition.Overrides) {
        if (contribution && terms.every((term) => contribution.Terms.includes(term))) add(this.find(id)!);
      }
    }
    if (includePending) {
      for (const id of this.pending) {
        const { Entry: entry, Terms: indexed, Pending: pending } = this.pending.get(id)!;
        if (terms.every((term) => indexed.includes(term))) continue;
        const full = new Set(scanTerms(textParts(pending!.Content)).Terms);
        if (terms.every((term) => full.has(term))) add(entry);
      }
    }
    return Object.freeze(hits.sort((left, right) => compareInt64(left.Sequence, right.Sequence) ||
      (left.AnchorId === null ? (right.AnchorId === null ? 0 : -1) :
        right.AnchorId === null ? 1 : ordinal(left.AnchorId, right.AnchorId))).slice(0, limit));
  }
}

function updatePostings(postings: Postings, address: string, previous: readonly string[], next: readonly string[]): Postings {
  const put = (term: string, addresses: Posting) =>
    postings.set(term, addresses, BigInt(96 + 2 * term.length + 64 * addresses.size));
  const oldTerms = new Set(previous);
  const newTerms = new Set(next);
  for (const term of oldTerms) {
    if (newTerms.has(term)) continue;
    const set = postings.get(term)?.delete(address);
    postings = set?.size ? put(term, set) : postings.delete(term);
  }
  for (const term of newTerms) {
    if (oldTerms.has(term)) continue;
    const set = (postings.get(term) ?? new PersistentStringTree<true>()).set(address, true);
    postings = put(term, set);
  }
  return postings;
}
