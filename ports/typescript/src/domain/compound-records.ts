// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { formatTimestampInvariant, timestampTicks } from './date-time-offset.js';
import { canonicalGuid } from './guid.js';
import { canonicalInt64, type Int64 } from './int64.js';
import { ContextEntryRecords } from './entry-records.js';
import { ContextScalarRecords } from './scalar-records.js';
import type { LLMContextStatistics } from './reads.js';
import type {
  AnchorResolution, ContextChange, ContextChangeSet, ContextIndexedSearchResult, ContextMemory, ContextPage,
  ContextSegment, ConversationAnchor, LLMSessionContext, MemoryChangeSet,
} from './session.js';

type Command<K extends ContextChange['kind']> = Extract<ContextChange, { kind: K }>;
interface Rule<T, V = T> {
  read(value: T): V;
  equals(left: V, right: V): boolean;
  hash(value: V): number;
  format(value: V): string;
}
type Field<T> = { [K in keyof T & string]: readonly [key: K, rule?: Rule<T[K], unknown>] }[keyof T & string];
type Operations<T> = Pick<Rule<never, T>, 'equals' | 'hash' | 'format'>;

const identities = new WeakMap<object, number>();
let nextIdentity = 0;
const referenceHash = (value: object): number => {
  let hash = identities.get(value);
  if (hash === undefined) { hash = ++nextIdentity; identities.set(value, hash); }
  return hash;
};
const textHash = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return hash;
};
const scalar = <T, V = T>(read: (value: T) => V): Rule<T, V> => ({
  read,
  equals: (left, right) => left === right,
  hash: (value) => textHash(`${typeof value}:${String(value)}`),
  format: (value) => value == null ? '' : typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value),
});
const plain = scalar((value: unknown) => value);
const guid = scalar(canonicalGuid);
const optionalGuid = scalar((value: string | null | undefined) => value == null ? null : canonicalGuid(value));
const long = scalar(canonicalInt64);
const optionalLong = scalar((value: Int64 | null | undefined) => value == null ? null : canonicalInt64(value));
const optionalTimestamp: Rule<string | null> = {
  read: (value) => value,
  equals: (left, right) => left === right || (left !== null && right !== null && timestampTicks(left) === timestampTicks(right)),
  hash: (value) => value === null ? 0 : textHash(String(timestampTicks(value))),
  format: (value) => value === null ? '' : formatTimestampInvariant(value),
};
const reference = (typeName: string): Rule<object | null | undefined, object | null> => ({
  read: (value) => value ?? null,
  equals: (left, right) => left === right,
  hash: (value) => value === null ? 0 : referenceHash(value),
  format: (value) => value === null ? '' : typeName,
});
const array = (typeName: string) => reference(`System.Collections.Immutable.ImmutableArray\`1[${typeName}]`);
const keys = reference('LLMContextLib.ContextIndexKeys');
const nested = <T>(operations: Operations<T>): Rule<T | null | undefined, T | null> => ({
  read: (value) => value ?? null,
  equals: (left, right) => left === right || (left !== null && right !== null && operations.equals(left, right)),
  hash: (value) => value === null ? 0 : operations.hash(value),
  format: (value) => value === null ? '' : operations.format(value),
});

function record<T extends object>(name: string, extra: readonly Field<T>[] = [], tagged = false) {
  return <const F extends readonly Field<T>[]>(...positional: F) => {
    const compile = ([key, rule]: Field<T>) => {
      const operations = (rule ?? plain) as Rule<unknown, unknown>;
      return { key, ...operations, get: (value: T) => operations.read(value[key]) };
    };
    const fields = [...positional, ...extra].map(compile);
    const tag = (value: object) => !tagged || ('kind' in value && value.kind === name);
    return Object.freeze({
      equals(left: T | null, right: T | null): boolean {
        return left === null || right === null ? left === right :
          tag(left) && tag(right) && (left === right || fields.every((field) => field.equals(field.get(left), field.get(right))));
      },
      hash(value: T): number {
        return fields.reduce((hash, field) => Math.imul(hash ^ field.hash(field.get(value)), 0x01000193), textHash(name));
      },
      format(value: T): string {
        return `${name} { ${fields.map((field) => `${field.key} = ${field.format(field.get(value))}`).join(', ')} }`;
      },
      deconstruct(value: T): { readonly [I in keyof F]: T[F[I][0]] } {
        return Object.freeze(fields.slice(0, positional.length).map((field) => field.get(value))) as
          { readonly [I in keyof F]: T[F[I][0]] };
      },
      clone(value: T): T { return Object.freeze({ ...value }); },
    });
  };
}

const entries = array('LLMContextLib.ContextEntry');
const anchor = record<ConversationAnchor>('ConversationAnchor', [['IndexKeys', keys]])(
  ['AnchorId', guid], ['StartEntryId', guid], ['EndEntryId', guid], ['Title'], ['Summary'], ['Topics', array('System.String')],
  ['Kind'], ['SourceRevision', long], ['PinnedRevision', optionalLong]);

/** Explicit operations for records whose immutable collection fields retain backing-reference equality. */
export const ContextCompoundRecords = Object.freeze({
  ContextSegment: record<ContextSegment>('ContextSegment')(['SegmentId', long], ['Revision', long], ['Entries', entries]),
  LLMSessionContext: record<LLMSessionContext>('LLMSessionContext')(
    ['SessionId', guid], ['UserId', guid], ['RepositoryId', optionalGuid], ['Revision', long], ['Status'],
    ['Segments', reference('System.Collections.Immutable.ImmutableSortedDictionary`2[System.Int64,LLMContextLib.ContextSegment]')],
    ['Anchors', reference('System.Collections.Immutable.ImmutableDictionary`2[System.Guid,LLMContextLib.ConversationAnchor]')]),
  ConversationAnchor: anchor,
  ContextMemory: record<ContextMemory>('ContextMemory')(
    ['MemoryId', guid], ['Scope', nested(ContextScalarRecords.MemoryScope)], ['Content'], ['Revision', long], ['Status'],
    ['ExpiresAt', optionalTimestamp], ['Sources', array('LLMContextLib.MemorySource')]),
  ContextPage: record<ContextPage>('ContextPage')(['Entries', entries], ['Next', nested(ContextScalarRecords.ContextCursor)]),
  ContextIndexedSearchResult: record<ContextIndexedSearchResult>('ContextIndexedSearchResult')(
    ['Hits', array('LLMContextLib.ContextSearchHit')], ['IndexStatus', nested(ContextScalarRecords.ContextIndexStatus)]),
  AnchorResolution: record<AnchorResolution>('AnchorResolution')(
    ['Anchor', nested(anchor)], ['Status'], ['Start', nested(ContextEntryRecords.ContextEntry)],
    ['End', nested(ContextEntryRecords.ContextEntry)], ['SessionRevision', long]),
  AppendEntries: record<Command<'AppendEntries'>>('AppendEntries', [], true)(['Entries', array('LLMContextLib.ContextEntryDraft')]),
  ReplaceSegment: record<Command<'ReplaceSegment'>>('ReplaceSegment', [], true)(['SegmentId', long], ['Entries', entries]),
  PutAnchor: record<Command<'PutAnchor'>>('PutAnchor', [], true)(['Anchor', nested(anchor)]),
  ContextChangeSet: record<ContextChangeSet>('ContextChangeSet')(
    ['SessionId', guid], ['ExpectedRevision', long], ['Changes', array('LLMContextLib.ContextChange')]),
  MemoryChangeSet: record<MemoryChangeSet>('MemoryChangeSet')(
    ['ExpectedRevision', long], ['Upserts', array('LLMContextLib.ContextMemory')], ['Deletes', array('System.Guid')]),
  LLMContextStatistics: record<LLMContextStatistics>('LLMContextStatistics', [
    ['EstimatedSynchronizationReserveBytes', long], ['EstimatedPreparationBytes', long], ['PendingSynchronizations'],
    ['Execution', nested(ContextScalarRecords.ContextExecutionStatistics)],
  ])(
    ['Sessions'], ['EstimatedActiveBytes', long], ['EstimatedRetainedBytes', long], ['RetainedReads'], ['MemoryRevision', long],
    ['PublishedMutations', long], ['SegmentsRewritten', long], ['EstimatedSegmentBytesRewritten', long], ['EstimatedViewBytes', long],
    ['PendingIndexWork'], ['EstimatedIndexWorkBytes', long], ['CompletedIndexJobs', long], ['DiscardedIndexJobs', long]),
});
