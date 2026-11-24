// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextContentRecords } from './content-records.js';
import { formatTimestampInvariant, timestampTicks } from './date-time-offset.js';
import { canonicalGuid } from './guid.js';
import { canonicalInt64 } from './int64.js';
import type { ContextChange, ContextEntry, ContextEntryDraft } from './session.js';

type Replace = Extract<ContextChange, { kind: 'ReplaceEntry' }>;
type KeyOwner = ContextEntry | ContextEntryDraft | Replace;
const keyIdentities = new WeakMap<readonly string[], bigint>();
let nextIdentity = 0n;

function keyHash(keys: readonly string[] | undefined): bigint {
  if (keys == null) return 0n;
  const hash = keyIdentities.get(keys);
  if (hash !== undefined) return hash;
  const assigned = ++nextIdentity;
  keyIdentities.set(keys, assigned);
  return assigned;
}

function entryRecord<T extends KeyOwner, F extends readonly unknown[]>(name: string, parts: {
  deconstruct(value: T): F;
  equalMetadata(left: T, right: T): boolean;
  hashMetadata(value: T): string;
  formatMetadata(value: T): string;
}) {
  return Object.freeze({
    equals(left: T | null, right: T | null): boolean {
      if (left === right) return true;
      return left !== null && right !== null && canonicalGuid(left.EntryId) === canonicalGuid(right.EntryId) &&
        (left.IndexKeys ?? null) === (right.IndexKeys ?? null) &&
        parts.equalMetadata(left, right) && ContextContentRecords.equals(left.Content, right.Content);
    },
    hash(value: T): number {
      let hash = 0x811c9dc5;
      const inputs = [name, canonicalGuid(value.EntryId), parts.hashMetadata(value),
        ContextContentRecords.hash(value.Content), keyHash(value.IndexKeys)];
      for (const input of inputs.map(String)) {
        hash = Math.imul(hash ^ input.length, 0x01000193);
        for (let index = 0; index < input.length; index++) hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193);
      }
      return hash;
    },
    format(value: T): string {
      const keys = value.IndexKeys == null ? '' : 'LLMContextLib.ContextIndexKeys';
      return `${name} { EntryId = ${canonicalGuid(value.EntryId)}, ${parts.formatMetadata(value)}Content = ${ContextContentRecords.format(value.Content)}, IndexKeys = ${keys} }`;
    },
    deconstruct(value: T): F { return Object.freeze(parts.deconstruct(value)); },
    clone(value: T): T { return Object.freeze({ ...value } as T); },
  });
}

const sameDraft = (left: ContextEntryDraft, right: ContextEntryDraft) =>
  left.Role === right.Role && timestampTicks(left.CreatedAt) === timestampTicks(right.CreatedAt);
const hashDraft = (value: ContextEntryDraft) => `${value.Role}:${timestampTicks(value.CreatedAt)}`;
const formatDraft = (value: ContextEntryDraft) => `Role = ${value.Role}, CreatedAt = ${formatTimestampInvariant(value.CreatedAt)}, `;

/** Entry and command record operations for supported built-in content, without changing storage equality. */
export const ContextEntryRecords = Object.freeze({
  ContextEntry: entryRecord('ContextEntry', {
    deconstruct: (value: ContextEntry) =>
      [canonicalGuid(value.EntryId), canonicalInt64(value.Sequence), value.Role, value.CreatedAt, value.Content] as const,
    equalMetadata: (left, right) => canonicalInt64(left.Sequence) === canonicalInt64(right.Sequence) && sameDraft(left, right),
    hashMetadata: (value) => `${canonicalInt64(value.Sequence)}:${hashDraft(value)}`,
    formatMetadata: (value) => `Sequence = ${canonicalInt64(value.Sequence)}, ${formatDraft(value)}`,
  }),
  ContextEntryDraft: entryRecord('ContextEntryDraft', {
    deconstruct: (value: ContextEntryDraft) => [canonicalGuid(value.EntryId), value.Role, value.CreatedAt, value.Content] as const,
    equalMetadata: sameDraft, hashMetadata: hashDraft, formatMetadata: formatDraft,
  }),
  ReplaceEntry: entryRecord('ReplaceEntry', {
    deconstruct: (value: Replace) => [canonicalGuid(value.EntryId), value.Content] as const,
    equalMetadata: (left, right) => left.kind === 'ReplaceEntry' && right.kind === 'ReplaceEntry',
    hashMetadata: () => '', formatMetadata: () => '',
  }),
});
