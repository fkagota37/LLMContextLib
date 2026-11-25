// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { type ContextEntry, type ContextMemory, type ContextContent, type LLMSessionContext, type MemoryScope, type ModelContextItem, MemoryStatus, ContextRole, SummaryContent, ToolCallContent, ToolResultContent } from '../domain/session.js';
import type { Int64 } from '../domain/int64.js';
import { timestampTicks } from '../domain/date-time-offset.js';
import { canonicalGuid } from '../domain/guid.js';
import { scanTerms, textLength, textParts } from './lexical.js';

export function* Entries(session: LLMSessionContext): IterableIterator<ContextEntry> {
  for (const segment of session.Segments.values()) yield* segment.Entries;
}

export function Text(content: ContextContent): string {
  return textParts(content).join('');
}

export function EstimateEntryBytes(entry: ContextEntry): number {
  return 128 + 2 * textLength(entry.Content);
}

export function Terms(text: string): readonly string[] {
  if (typeof text !== 'string') {
    throw new TypeError('Text must be a string.');
  }
  return scanTerms([text]).Terms;
}

export function Matches(scope: MemoryScope, session: LLMSessionContext): boolean {
  return (
    (scope.UserId == null || canonicalGuid(scope.UserId) === canonicalGuid(session.UserId)) &&
    (scope.RepositoryId == null || (session.RepositoryId != null && canonicalGuid(scope.RepositoryId) === canonicalGuid(session.RepositoryId))) &&
    (scope.SessionId == null || canonicalGuid(scope.SessionId) === canonicalGuid(session.SessionId))
  );
}

export function ValidateScope(scope: MemoryScope): void {
  if (!scope || (scope.UserId == null && scope.RepositoryId == null && scope.SessionId == null)) {
    throw new Error('Memory needs nonempty, explicit scope identities.');
  }

  const emptyGuid = '00000000-0000-0000-0000-000000000000';
  for (const value of [scope.UserId, scope.RepositoryId, scope.SessionId]) {
    if (value != null && canonicalGuid(value) === emptyGuid) {
      throw new Error('Memory needs nonempty, explicit scope identities.');
    }
  }
}

export function ApplicableMemory(
  candidates: Iterable<ContextMemory>,
  session: LLMSessionContext,
  scopes: readonly MemoryScope[],
  now: Date | number | string,
): readonly ContextMemory[] {
  if (!Array.isArray(scopes)) throw new TypeError('Scopes must be initialized.');
  const key = (scope: MemoryScope) =>
    JSON.stringify([scope.UserId, scope.RepositoryId, scope.SessionId].map((id) => id == null ? null : canonicalGuid(id)));
  const allowed = new Set(scopes.map((scope) => {
    ValidateScope(scope);
    if (!Matches(scope, session)) throw new TypeError('Requested scope does not apply to this session.');
    return key(scope);
  }));
  if (allowed.size === 0) return Object.freeze([]);
  const instant = timestampTicks(now);
  const matches: ContextMemory[] = [];
  for (const memory of candidates) {
    const memoryKey = key(memory.Scope);
    if (!allowed.has(memoryKey)) {
      continue;
    }
    if (!Matches(memory.Scope, session)) {
      continue;
    }
    if (memory.Status !== MemoryStatus.Confirmed) {
      continue;
    }
    if (memory.ExpiresAt !== null && timestampTicks(memory.ExpiresAt) <= instant) {
      continue;
    }
    matches.push(memory);
  }
  return Object.freeze(matches.sort((a, b) => a.MemoryId < b.MemoryId ? -1 : a.MemoryId > b.MemoryId ? 1 : 0));
}

export function BuildModelContext(
  source: Iterable<ContextEntry>,
  memory: Iterable<ContextMemory>,
  tokenBudget: number,
  estimateTokens: (text: string) => number,
  maximumItems = 2147483647,
): readonly ModelContextItem[] {
  if (!Number.isInteger(tokenBudget) || tokenBudget < 0 || tokenBudget > 2147483647) {
    throw new RangeError('tokenBudget must be non-negative.');
  }
  if (!Number.isInteger(maximumItems) || maximumItems < 0 || maximumItems > 2147483647) {
    throw new RangeError('maximumItems must be non-negative.');
  }
  if (estimateTokens === undefined || estimateTokens === null) {
    throw new TypeError('estimateTokens must be defined.');
  }

  const entries = [...source];
  const selected: Map<string, ModelContextItem> = new Map();
  const memoryItems: ModelContextItem[] = [];
  let remaining = tokenBudget;

  const fits = (items: readonly ModelContextItem[]): boolean => {
    let total = 0;
    let count = 0;
    for (const item of items) {
      const cost = estimateTokens(item.Text);
      if (!Number.isInteger(cost) || cost < 0 || cost > 2147483647) {
        throw new TypeError('Token estimates must be non-negative Int32 values.');
      }
      total += cost;
      count += 1;
    }
    if (total > remaining || selected.size + memoryItems.length + count > maximumItems) {
      return false;
    }
    remaining -= total;
    return true;
  };

  for (const entry of entries.filter((item) => item.Role === ContextRole.System)) {
    const item: ModelContextItem = { EntryId: entry.EntryId, MemoryId: null, Role: entry.Role, Text: Text(entry.Content) };
    if (fits([item])) {
      selected.set(entry.EntryId, item);
    }
  }

  for (const record of [...memory].sort((a, b) => a.MemoryId < b.MemoryId ? -1 : a.MemoryId > b.MemoryId ? 1 : 0)) {
    const item: ModelContextItem = { EntryId: null, MemoryId: record.MemoryId, Role: ContextRole.System, Text: record.Content };
    if (fits([item])) {
      memoryItems.push(item);
    }
  }

  let summarizedThrough: Int64 = -1;
  const latestSummary = [...entries].reverse().find((entry) => entry.Content instanceof SummaryContent);
  if (latestSummary && latestSummary.Role !== ContextRole.System && latestSummary.Content instanceof SummaryContent) {
    const item: ModelContextItem = { EntryId: latestSummary.EntryId, MemoryId: null, Role: latestSummary.Role, Text: Text(latestSummary.Content) };
    if (fits([item])) {
      selected.set(latestSummary.EntryId, item);
      summarizedThrough = latestSummary.Content.ThroughSequence;
    }
  }

  const results = new Map<string, ContextEntry>();
  for (const entry of entries) {
    if (entry.Content instanceof ToolResultContent) {
      results.set(entry.Content.CallId, entry);
    }
  }

  const calls = new Map<string, ContextEntry>();
  for (const entry of entries) {
    if (entry.Content instanceof ToolCallContent) {
      calls.set(entry.Content.CallId, entry);
    }
  }

  const groups: ContextEntry[][] = [];
  for (const entry of entries) {
    if (entry.Role === ContextRole.System || entry.Sequence <= summarizedThrough || entry.Content instanceof SummaryContent || entry.Content instanceof ToolResultContent) {
      continue;
    }

    if (entry.Content instanceof ToolCallContent) {
      const call = entry.Content;
      const result = results.get(call.CallId);
      if (calls.get(call.CallId)?.EntryId === entry.EntryId && result && result.Sequence > entry.Sequence) {
        groups.push([entry, result]);
      }
    } else {
      groups.push([entry]);
    }
  }

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const items = groups[index].map((entry) => ({
      EntryId: entry.EntryId,
      MemoryId: null,
      Role: entry.Role,
      Text: Text(entry.Content),
    }));
    if (!fits(items)) {
      continue;
    }
    for (const item of items) {
      if (item.EntryId !== null) {
        selected.set(item.EntryId, item);
      }
    }
  }

  const ordered = entries.filter((entry) => selected.has(entry.EntryId)).map((entry) => selected.get(entry.EntryId)!);
  let insertionIndex = 0;
  while (insertionIndex < ordered.length && ordered[insertionIndex]?.Role === ContextRole.System) {
    insertionIndex += 1;
  }
  ordered.splice(insertionIndex, 0, ...memoryItems);
  return ordered;
}

export const ContextPolicies = {
  Entries,
  Text,
  EstimateEntryBytes,
  Terms,
  Matches,
  ValidateScope,
  ApplicableMemory,
  BuildModelContext,
};
