// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import {
  AnchorTargetStatus, ContextMutationStatus, ContextRole, MemoryStatus, SessionStatus,
  SummaryContent, TextContent, ToolCallContent, ToolResultContent,
  type ContextChangeSet, type ContextEntry, type ContextMemory, type ContextSearchHit,
  type ConversationAnchor, type LLMSessionContext, type MemoryChangeSet, type MemoryScope, type ModelContextItem,
} from '../src/domain/session.js';

export type ReplayRequest =
  | { Kind: 'Range'; FromSequence: number; Limit: number }
  | { Kind: 'Search'; Query: string; Limit: number }
  | { Kind: 'Anchor'; AnchorId: string }
  | { Kind: 'Memory'; Scopes: readonly MemoryScope[] }
  | { Kind: 'Conversation'; Limit: number }
  | { Kind: 'Model'; Scopes: readonly MemoryScope[]; TokenBudget: number; Limit: number };

type Session = {
  header: LLMSessionContext;
  entries: readonly ContextEntry[];
  anchors: ReadonlyMap<string, ConversationAnchor>;
  next: number;
};

const words = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{Nd}]+/gu) ?? []);
const text = ({ Content }: ContextEntry): string => {
  if (Content instanceof TextContent || Content instanceof SummaryContent) return Content.Text;
  if (Content instanceof ToolCallContent) return [Content.ToolName, Content.CallId, Content.ArgumentsJson].join(' ');
  if (Content instanceof ToolResultContent) return [Content.CallId, Content.ResultJson].join(' ');
  throw new Error('Unrecognized replay content.');
};
const scopeKeys = ['UserId', 'RepositoryId', 'SessionId'] as const;
const equalScopes = (left: MemoryScope, right: MemoryScope) =>
  scopeKeys.every((key) => (left[key] ?? null) === (right[key] ?? null));
const applies = (scope: MemoryScope, session: LLMSessionContext) =>
  scopeKeys.every((key) => scope[key] == null || scope[key] === session[key]);
const result = (Status: ContextMutationStatus, Revision: number | bigint) => ({ Status, Revision });
const byId = (left: string | null, right: string | null) => (left ?? '') < (right ?? '') ? -1 : left === right ? 0 : 1;

/** Untimed scan oracle for the canonical finite benchmark workload. */
export class SemanticOracle {
  private readonly sessions = new Map<string, Session>();
  private memory = new Map<string, ContextMemory>();
  private memoryRevision = 0;

  constructor(sessions: Iterable<LLMSessionContext>, private readonly now: string) {
    for (const header of sessions) {
      const entries = [...header.Segments.values()].flatMap((segment) => segment.Entries)
        .sort((left, right) => Number(left.Sequence) - Number(right.Sequence));
      this.sessions.set(header.SessionId, { header, entries, anchors: new Map(header.Anchors), next: Number(entries.at(-1)?.Sequence ?? -1) + 1 });
    }
  }

  Apply({ SessionId, ExpectedRevision, Changes }: ContextChangeSet) {
    const state = this.sessions.get(SessionId);
    if (!state) return result(ContextMutationStatus.NotFound, 0);
    const current = state.header.Revision;
    if (ExpectedRevision !== current) return result(ContextMutationStatus.RevisionConflict, current);
    if (!Changes.length) return result(ContextMutationStatus.InvalidOperation, current);
    const entries = [...state.entries];
    const anchors = new Map(state.anchors);
    let status = state.header.Status;
    let next = state.next;
    for (const change of Changes) {
      if (status !== SessionStatus.Active && change.kind !== 'SetSessionStatus') return result(ContextMutationStatus.InvalidOperation, current);
      switch (change.kind) {
        case 'AppendEntries':
          for (const draft of change.Entries) entries.push({ ...draft, Sequence: next++ });
          break;
        case 'ReplaceEntry':
        case 'DeleteEntry': {
          const index = entries.findIndex((entry) => entry.EntryId === change.EntryId);
          if (index < 0) return result(ContextMutationStatus.InvalidOperation, current);
          if (change.kind === 'DeleteEntry') entries.splice(index, 1);
          else entries[index] = { ...entries[index], Content: change.Content, IndexKeys: change.IndexKeys };
          break;
        }
        case 'PutAnchor': anchors.set(change.Anchor.AnchorId, change.Anchor); break;
        case 'RemoveAnchor': anchors.delete(change.AnchorId); break;
        case 'SetSessionStatus': status = change.Status; break;
        case 'ReplaceSegment': throw new Error('The finite replay oracle does not model physical segment layout.');
      }
    }
    const Revision = Number(current) + 1;
    this.sessions.set(SessionId, { header: { ...state.header, Revision, Status: status }, entries, anchors, next });
    return result(ContextMutationStatus.Applied, Revision);
  }

  ApplyMemory({ ExpectedRevision, Upserts, Deletes }: MemoryChangeSet) {
    if (ExpectedRevision !== this.memoryRevision) return result(ContextMutationStatus.RevisionConflict, this.memoryRevision);
    if (!Upserts.length && !Deletes.length || Upserts.some((record) => record.Status === MemoryStatus.Confirmed && !record.Sources.length)) {
      return result(ContextMutationStatus.InvalidOperation, this.memoryRevision);
    }
    const next = new Map(this.memory);
    const revision = this.memoryRevision + 1;
    for (const id of Deletes) next.delete(id);
    for (const record of Upserts) next.set(record.MemoryId, { ...record, Revision: revision });
    this.memory = next;
    this.memoryRevision = revision;
    return result(ContextMutationStatus.Applied, revision);
  }

  Capture(id: string) {
    const { header, entries, anchors } = this.sessions.get(id)!;
    const catalog = this.memory;
    const MemoryRevision = this.memoryRevision;
    const SessionRevision = header.Revision;
    const read = (request: ReplayRequest) => {
      const state = { SessionRevision, MemoryRevision, Entries: [], Hits: [], Anchors: [], Memories: [], Model: [] };
      const memory = 'Scopes' in request ? [...catalog.values()]
        .filter((record) => record.Status === MemoryStatus.Confirmed && applies(record.Scope, header) &&
          request.Scopes.some((scope) => equalScopes(scope, record.Scope)) &&
          (record.ExpiresAt === null || Date.parse(record.ExpiresAt) > Date.parse(this.now)))
        .sort((left, right) => byId(left.MemoryId, right.MemoryId)) : [];
      switch (request.Kind) {
        case 'Range': return { ...state, Entries: entries.filter((entry) => entry.Sequence >= request.FromSequence).slice(0, request.Limit) };
        case 'Conversation': return { ...state, Entries: entries.filter((entry) => entry.Content instanceof TextContent &&
          (entry.Role === ContextRole.User || entry.Role === ContextRole.Assistant)).slice(0, request.Limit) };
        case 'Memory': return { ...state, Memories: memory };
        case 'Model': return { ...state, Model: model(entries, memory, request.TokenBudget, request.Limit) };
        case 'Anchor': {
          const Anchor = anchors.get(request.AnchorId)!;
          const Start = entries.find((entry) => entry.EntryId === Anchor.StartEntryId);
          const End = entries.find((entry) => entry.EntryId === Anchor.EndEntryId);
          const unavailable = Anchor.PinnedRevision != null && Anchor.PinnedRevision !== SessionRevision;
          const Status = unavailable ? AnchorTargetStatus.HistoryUnavailable :
            !Start && !End ? AnchorTargetStatus.Missing : !Start || !End ? AnchorTargetStatus.Partial :
              Anchor.SourceRevision === SessionRevision ? AnchorTargetStatus.Current : AnchorTargetStatus.Edited;
          return { ...state, Anchors: [{ Anchor, SessionRevision, Status, Start: unavailable ? null : Start, End: unavailable ? null : End }] };
        }
        case 'Search': {
          const query = [...words(request.Query)];
          if (!query.length) return state;
          const hits: ContextSearchHit[] = [];
          const add = (entry: ContextEntry, AnchorId: string | null, source: string) => {
            const terms = words(source);
            if (query.every((word) => terms.has(word))) {
              hits.push({ EntryId: entry.EntryId, AnchorId, Snippet: source.slice(0, 160), Sequence: entry.Sequence, SessionRevision });
            }
          };
          for (const entry of entries) add(entry, null, text(entry));
          for (const anchor of anchors.values()) {
            const entry = entries.find((candidate) => candidate.EntryId === anchor.StartEntryId);
            if (entry) add(entry, anchor.AnchorId, `${anchor.Title} ${anchor.Summary} ${anchor.Topics.join(' ')}`);
          }
          return { ...state, Hits: hits.sort((left, right) =>
            Number(left.Sequence) - Number(right.Sequence) || byId(left.AnchorId, right.AnchorId)).slice(0, request.Limit) };
        }
      }
    };
    return { Revision: SessionRevision, FirstEntry: entries[0], Read: read };
  }
}

function model(entries: readonly ContextEntry[], memory: readonly ContextMemory[], budget: number, limit: number) {
  const chosen: ModelContextItem[] = [];
  const add = (...items: ModelContextItem[]) => {
    const cost = items.reduce((sum, item) => sum + Math.ceil(item.Text.length / 4), 0);
    if (cost > budget || chosen.length + items.length > limit) return false;
    budget -= cost;
    chosen.push(...items);
    return true;
  };
  const item = (entry: ContextEntry): ModelContextItem =>
    ({ EntryId: entry.EntryId, MemoryId: null, Role: entry.Role, Text: text(entry) });
  for (const entry of entries) if (entry.Role === ContextRole.System) add(item(entry));
  for (const record of memory) add({ EntryId: null, MemoryId: record.MemoryId, Role: ContextRole.System, Text: record.Content });
  const descending = [...entries].reverse();
  const summary = descending.find((entry) => entry.Content instanceof SummaryContent);
  const through = summary && summary.Content instanceof SummaryContent && summary.Role !== ContextRole.System && add(item(summary))
    ? summary.Content.ThroughSequence : -1;
  for (const entry of descending) {
    if (entry.Sequence <= through || entry.Role === ContextRole.System ||
        entry.Content instanceof SummaryContent || entry.Content instanceof ToolResultContent) continue;
    if (entry.Content instanceof ToolCallContent) {
      const id = entry.Content.CallId;
      const latest = descending.find((candidate) => candidate.Content instanceof ToolCallContent && candidate.Content.CallId === id);
      const response = descending.find((candidate) => candidate.Content instanceof ToolResultContent && candidate.Content.CallId === id);
      if (latest === entry && response && response.Sequence > entry.Sequence) add(item(entry), item(response));
    } else add(item(entry));
  }
  const selected = entries.flatMap((entry) => chosen.filter((candidate) => candidate.EntryId === entry.EntryId));
  const firstNonSystem = selected.findIndex((entry) => entry.Role !== ContextRole.System);
  selected.splice(firstNonSystem < 0 ? selected.length : firstNonSystem, 0, ...chosen.filter((entry) => entry.MemoryId !== null));
  return selected;
}
