// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import {
  AnchorTargetStatus, ContextMutationStatus, ContextRole, MemoryStatus, SessionStatus, TextContent,
  type ContextChangeSet, type ContextEntry, type ContextMemory, type ContextSearchHit,
  type ConversationAnchor, type LLMSessionContext, type MemoryChangeSet, type MemoryScope,
} from '../src/domain/session.js';
import { ApplicableMemory, BuildModelContext, Matches, Terms, Text, ValidateScope } from '../src/policies/context.js';
import type { ReplayRequest } from './semantic-oracle.js';

type Address = { EntryId: string; AnchorId: string | null };
type Slot = {
  header: LLMSessionContext;
  entries: ContextEntry[];
  locations: Map<string, number>;
  anchors: Map<string, ConversationAnchor>;
  seen: Set<string>;
  postings: Map<string, Set<Address>>;
  addresses: Map<string, Address>;
  next: number;
};

const anchorText = (anchor: ConversationAnchor) => `${anchor.Title} ${anchor.Summary} ${anchor.Topics.join(' ')}`;
const result = (Status: ContextMutationStatus, Revision: number | bigint) => ({ Status, Revision });
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const scopeKey = ({ UserId, RepositoryId, SessionId }: MemoryScope) => JSON.stringify([UserId, RepositoryId, SessionId]);

/** Mutable list/dictionary timing baselines, with optional maintained postings and scope buckets. */
export class ConventionalParticipant {
  private readonly sessions = new Map<string, Slot>();
  private readonly records = new Map<string, ContextMemory>();
  private readonly scopes = new Map<string, Set<string>>();
  private memoryRevision = 0;
  private retained = 0;

  constructor(sessions: Iterable<LLMSessionContext>, private readonly now: string, private readonly indexed: boolean,
    private readonly maximumReads: number) {
    for (const header of sessions) {
      const entries = [...header.Segments.values()].flatMap((segment) => segment.Entries);
      const locations = new Map(entries.map((entry, index) => [entry.EntryId, index]));
      const slot = { header, entries, locations, anchors: new Map(header.Anchors), seen: new Set(locations.keys()),
        postings: new Map(), addresses: new Map(), next: Number(entries.at(-1)?.Sequence ?? -1) + 1 };
      this.sessions.set(header.SessionId, slot);
      if (indexed) {
        for (const entry of entries) this.index(slot, entry.EntryId, null, Text(entry.Content), true);
        for (const anchor of slot.anchors.values()) this.index(slot, anchor.StartEntryId, anchor.AnchorId, anchorText(anchor), true);
      }
    }
  }

  Apply({ SessionId, ExpectedRevision, Changes }: ContextChangeSet) {
    const slot = this.sessions.get(SessionId);
    if (!slot) return result(ContextMutationStatus.NotFound, 0);
    const current = slot.header.Revision;
    if (ExpectedRevision !== current) return result(ContextMutationStatus.RevisionConflict, current);
    if (!Changes.length) return result(ContextMutationStatus.InvalidOperation, current);
    const edits = new Map<string, ContextEntry | null>();
    const anchors = new Map<string, ConversationAnchor | null>();
    const newIds = new Set<string>();
    let status = slot.header.Status;
    let next = slot.next;
    const find = (id: string) => {
      const entry = edits.has(id) ? edits.get(id) : this.find(slot, id);
      if (!entry) throw new RangeError('Unknown entry.');
      return entry;
    };
    try {
      for (const change of Changes) {
        if (status !== SessionStatus.Active && change.kind !== 'SetSessionStatus') throw new RangeError('Session is not active.');
        switch (change.kind) {
          case 'AppendEntries':
            for (const draft of change.Entries) {
              if (!draft.EntryId || slot.seen.has(draft.EntryId) || newIds.has(draft.EntryId)) throw new RangeError('Invalid entry ID.');
              newIds.add(draft.EntryId);
              edits.set(draft.EntryId, { ...draft, Sequence: next++ });
            }
            break;
          case 'ReplaceEntry':
            edits.set(change.EntryId, { ...find(change.EntryId), Content: change.Content, IndexKeys: change.IndexKeys });
            break;
          case 'DeleteEntry':
            find(change.EntryId);
            edits.set(change.EntryId, null);
            break;
          case 'PutAnchor':
            if (find(change.Anchor.StartEntryId).Sequence > find(change.Anchor.EndEntryId).Sequence) throw new RangeError('Reversed anchor.');
            anchors.set(change.Anchor.AnchorId, change.Anchor);
            break;
          case 'RemoveAnchor':
            if (!(anchors.has(change.AnchorId) ? anchors.get(change.AnchorId) : slot.anchors.get(change.AnchorId))) throw new RangeError('Unknown anchor.');
            anchors.set(change.AnchorId, null);
            break;
          case 'SetSessionStatus':
            if (status === SessionStatus.Expired && change.Status !== status) throw new RangeError('Expired session.');
            status = change.Status;
            break;
          default: throw new RangeError('Unsupported finite replay mutation.');
        }
      }
    } catch (error) {
      if (error instanceof RangeError) return result(ContextMutationStatus.InvalidOperation, current);
      throw error;
    }
    const removed: number[] = [];
    for (const [id, entry] of edits) {
      const location = slot.locations.get(id);
      if (this.indexed && location !== undefined) this.index(slot, id, null, Text(slot.entries[location].Content), false);
      if (entry) {
        if (location === undefined) {
          slot.locations.set(id, slot.entries.length);
          slot.entries.push(entry);
        } else slot.entries[location] = entry;
        if (this.indexed) this.index(slot, id, null, Text(entry.Content), true);
      } else if (location !== undefined) removed.push(location);
    }
    if (removed.length) {
      removed.sort((a, b) => b - a);
      for (const location of removed) slot.locations.delete(slot.entries.splice(location, 1)[0].EntryId);
      for (let offset = removed.at(-1)!; offset < slot.entries.length; offset++) slot.locations.set(slot.entries[offset].EntryId, offset);
    }
    for (const [id, anchor] of anchors) {
      const old = slot.anchors.get(id);
      if (this.indexed && old) this.index(slot, old.StartEntryId, id, anchorText(old), false);
      if (anchor) {
        slot.anchors.set(id, anchor);
        if (this.indexed) this.index(slot, anchor.StartEntryId, id, anchorText(anchor), true);
      } else slot.anchors.delete(id);
    }
    for (const id of newIds) slot.seen.add(id);
    slot.next = next;
    slot.header = { ...slot.header, Revision: Number(current) + 1, Status: status };
    return result(ContextMutationStatus.Applied, slot.header.Revision);
  }

  ApplyMemory({ ExpectedRevision, Upserts, Deletes }: MemoryChangeSet) {
    if (ExpectedRevision !== this.memoryRevision) return result(ContextMutationStatus.RevisionConflict, this.memoryRevision);
    const seen = new Set(Deletes);
    if (!Upserts.length && !Deletes.length || seen.size !== Deletes.length || Deletes.some((id) => !this.records.has(id))) {
      return result(ContextMutationStatus.InvalidOperation, this.memoryRevision);
    }
    try {
      for (const record of Upserts) {
        ValidateScope(record.Scope);
        if (seen.has(record.MemoryId) || (record.Status === MemoryStatus.Confirmed && !record.Sources.length)) {
          throw new RangeError('Invalid memory record.');
        }
        for (const source of record.Sources) {
          const slot = this.sessions.get(source.SessionId);
          const anchor = slot?.anchors.get(source.AnchorId);
          if (!slot || !anchor || !Matches(record.Scope, slot.header) || !this.find(slot, anchor.StartEntryId) ||
              !this.find(slot, anchor.EndEntryId) || (anchor.PinnedRevision != null && anchor.PinnedRevision !== slot.header.Revision)) {
            throw new RangeError('Invalid memory provenance.');
          }
        }
        seen.add(record.MemoryId);
      }
    } catch {
      return result(ContextMutationStatus.InvalidOperation, this.memoryRevision);
    }
    for (const id of seen) {
      const old = this.records.get(id);
      if (old && this.indexed) {
        const key = scopeKey(old.Scope);
        const ids = this.scopes.get(key)!;
        ids.delete(id);
        if (!ids.size) this.scopes.delete(key);
      }
      this.records.delete(id);
    }
    const Revision = ++this.memoryRevision;
    for (const record of Upserts) {
      this.records.set(record.MemoryId, { ...record, Revision });
      if (this.indexed) {
        const key = scopeKey(record.Scope);
        const ids = this.scopes.get(key) ?? new Set<string>();
        ids.add(record.MemoryId);
        this.scopes.set(key, ids);
      }
    }
    return result(ContextMutationStatus.Applied, Revision);
  }

  Read(session: string, request: ReplayRequest) {
    this.acquire();
    try {
      const slot = this.sessions.get(session)!;
      if (slot.header.Status === SessionStatus.Expired) throw new Error('Session expired.');
      const state = { SessionRevision: slot.header.Revision, MemoryRevision: this.memoryRevision,
        Entries: [], Hits: [], Anchors: [], Memories: [], Model: [] };
      switch (request.Kind) {
        case 'Range': {
          let start = 0;
          let end = slot.entries.length;
          while (start < end) {
            const middle = Math.floor((start + end) / 2);
            if (slot.entries[middle].Sequence < request.FromSequence) start = middle + 1;
            else end = middle;
          }
          return { ...state, Entries: slot.entries.slice(start, start + request.Limit) };
        }
        case 'Conversation': return { ...state, Entries: slot.entries.filter((entry) => entry.Content instanceof TextContent &&
          (entry.Role === ContextRole.User || entry.Role === ContextRole.Assistant)).slice(0, request.Limit) };
        case 'Anchor': {
          const Anchor = slot.anchors.get(request.AnchorId)!;
          const Start = this.find(slot, Anchor.StartEntryId);
          const End = this.find(slot, Anchor.EndEntryId);
          const unavailable = Anchor.PinnedRevision != null && Anchor.PinnedRevision !== state.SessionRevision;
          const Status = unavailable ? AnchorTargetStatus.HistoryUnavailable :
            !Start && !End ? AnchorTargetStatus.Missing : !Start || !End ? AnchorTargetStatus.Partial :
              Anchor.SourceRevision === state.SessionRevision ? AnchorTargetStatus.Current : AnchorTargetStatus.Edited;
          return { ...state, Anchors: [{ Anchor, SessionRevision: state.SessionRevision, Status,
            Start: unavailable ? null : Start, End: unavailable ? null : End }] };
        }
        case 'Search': return { ...state, Hits: this.search(slot, request.Query, request.Limit) };
        case 'Memory':
        case 'Model': {
          const candidates = this.indexed ? [...new Set(request.Scopes.flatMap((scope) => [...(this.scopes.get(scopeKey(scope)) ?? [])]))]
            .map((id) => this.records.get(id)!) : [...this.records.values()];
          const memory = ApplicableMemory(candidates, slot.header, request.Scopes, this.now);
          return request.Kind === 'Memory' ? { ...state, Memories: memory } : { ...state,
            Model: BuildModelContext(slot.entries, memory, request.TokenBudget, (text) => Math.ceil(text.length / 4), request.Limit) };
        }
      }
    } finally {
      this.retained--;
    }
  }

  Capture(session: string) {
    const slot = this.sessions.get(session)!;
    if (slot.header.Status === SessionStatus.Expired) throw new Error('Session expired.');
    this.acquire();
    let copy: ContextEntry[] | undefined = [...slot.entries];
    return {
      Revision: slot.header.Revision,
      get FirstEntry() { return copy?.[0]; },
      Release: () => {
        if (copy) { copy = undefined; this.retained--; }
      },
    };
  }

  Revision(session: string) { return this.sessions.get(session)!.header.Revision; }

  get RetainedReads() { return this.retained; }

  private acquire() {
    if (this.retained >= this.maximumReads) throw new RangeError('Read-retention budget exhausted.');
    this.retained++;
  }

  private find(slot: Slot, id: string) {
    const offset = slot.locations.get(id);
    return offset === undefined ? undefined : slot.entries[offset];
  }

  private search(slot: Slot, query: string, limit: number) {
    const terms = Terms(query);
    if (!terms.length || !limit) return [];
    const hits: ContextSearchHit[] = [];
    const add = (entry: ContextEntry, AnchorId: string | null, snippet: string) =>
      hits.push({ EntryId: entry.EntryId, AnchorId, Snippet: snippet.slice(0, 160), Sequence: entry.Sequence,
        SessionRevision: slot.header.Revision });
    if (this.indexed) {
      const sets = terms.map((term) => slot.postings.get(term));
      if (sets.every((set): set is Set<Address> => set !== undefined)) {
        sets.sort((left, right) => left.size - right.size);
        for (const address of sets[0]) {
          if (!sets.every((set) => set.has(address))) continue;
          const entry = this.find(slot, address.EntryId);
          if (entry) add(entry, address.AnchorId, address.AnchorId === null ? Text(entry.Content) : anchorText(slot.anchors.get(address.AnchorId)!));
        }
      }
    } else {
      const matches = (source: string) => {
        const words = new Set(Terms(source));
        return terms.every((term) => words.has(term));
      };
      for (const entry of slot.entries) {
        const text = Text(entry.Content);
        if (matches(text)) add(entry, null, text);
      }
      for (const anchor of slot.anchors.values()) {
        const entry = this.find(slot, anchor.StartEntryId);
        const text = anchorText(anchor);
        if (entry && matches(text)) add(entry, anchor.AnchorId, text);
      }
    }
    return hits.sort((left, right) => Number(left.Sequence) - Number(right.Sequence) ||
      compare(left.AnchorId ?? '', right.AnchorId ?? '')).slice(0, limit);
  }

  private index(slot: Slot, EntryId: string, AnchorId: string | null, text: string, add: boolean) {
    const key = JSON.stringify([EntryId, AnchorId]);
    const address = slot.addresses.get(key) ?? { EntryId, AnchorId };
    if (add) slot.addresses.set(key, address);
    else slot.addresses.delete(key);
    for (const term of Terms(text)) {
      const set = slot.postings.get(term);
      if (add) {
        if (set) set.add(address);
        else slot.postings.set(term, new Set([address]));
      } else if (set) {
        set.delete(address);
        if (!set.size) slot.postings.delete(term);
      }
    }
  }
}
