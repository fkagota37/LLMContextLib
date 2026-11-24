// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { canonicalGuid } from './guid.js';
import { canonicalInt64, type Int64 } from './int64.js';
import type { ContextChange, ContextCursor, ContextIndexStatus, ContextSearchHit, MemoryScope, MemorySource, ModelContextItem } from './session.js';
import type { ContextExecutionOptions, ContextExecutionStatistics } from '../execution/strategy.js';
import type { DeferredIndexingOptions } from '../options.js';
import { freezePartitionedContextIndexOptions, type ContextIndexSynchronization, type PartitionedContextIndexOptions } from '../storage/partitioned-index.js';

type Scalar = string | Int64 | boolean | null;
type Command<K extends ContextChange['kind']> = Extract<ContextChange, { kind: K }>;
type Field<T> = readonly [key: keyof T & string, normalize?: (value: never) => Scalar, displayField?: (value: Scalar) => string];
type FieldValue<T, F extends Field<T>> = F[1] extends (value: never) => infer R ? R : T[F[0]];

const guid = (value: string) => canonicalGuid(value);
const optionalGuid = (value: string | null | undefined) => value == null ? null : canonicalGuid(value);
const display = (value: Scalar): string => typeof value === 'boolean' ? (value ? 'True' : 'False') : value == null ? '' : String(value);

export function scalarRecord<T extends object>(name: string, computed?: (value: T) => string, tagged = false) {
  return <const F extends readonly Field<T>[]>(...fields: F) => {
    const matches = (value: unknown) => !tagged ||
      (typeof value === 'object' && value !== null && 'kind' in value && value.kind === name);
    const values = (value: T): Scalar[] => fields.map(([key, normalize]) =>
      normalize ? normalize(value[key] as never) : value[key] as Scalar);
    return Object.freeze({
      equals(left: T | null, right: T | null): boolean {
        if ((left !== null && !matches(left)) || (right !== null && !matches(right))) return false;
        if (left === right) return true;
        if (left === null || right === null) return false;
        const other = values(right);
        return values(left).every((field, index) => field === other[index]);
      },
      hash(value: T): number {
        let result = 0x811c9dc5;
        for (const field of [name, ...values(value)]) {
          const text = `${typeof field}:${String(field)}`;
          result = Math.imul(result ^ text.length, 0x01000193);
          for (let index = 0; index < text.length; index++) result = Math.imul(result ^ text.charCodeAt(index), 0x01000193);
        }
        return result;
      },
      format(value: T): string {
        const members = values(value).map((field, index) => fields[index][2]?.(field) ?? `${fields[index][0]} = ${display(field)}`);
        if (computed) members.push(computed(value));
        return `${name} { ${members.join(', ')} }`;
      },
      deconstruct(value: T): { readonly [I in keyof F]: FieldValue<T, F[I]> } {
        return Object.freeze(values(value)) as { readonly [I in keyof F]: FieldValue<T, F[I]> };
      },
      clone(value: T): T {
        return Object.freeze({ ...value });
      },
    });
  };
}

const record = scalarRecord;

function formatTimeoutMilliseconds(milliseconds: number): string {
  const ticks = BigInt(Math.round(milliseconds * 10_000));
  const whole = (ticks < 0n ? -ticks : ticks) / 10_000_000n;
  const remainder = (ticks < 0n ? -ticks : ticks) % 10_000_000n;
  const pad = (part: bigint) => part.toString().padStart(2, '0');
  const days = whole / 86_400n;
  const hhmmss = `${pad(whole / 3600n % 24n)}:${pad(whole / 60n % 60n)}:${pad(whole % 60n)}`;
  const fraction = remainder === 0n ? '' : `.${remainder.toString().padStart(7, '0')}`;
  return `${ticks < 0n ? '-' : ''}${days === 0n ? '' : `${days}.`}${hhmmss}${fraction}`;
}

const partitionedRecord = record<PartitionedContextIndexOptions>('PartitionedContextIndexOptions')(
  ['MaximumEstimatedPartitionBytes', canonicalInt64], ['MaximumWorkingSetEntries'],
  ['MaximumEstimatedWorkingSetBytes', canonicalInt64], ['MaximumPendingSynchronizations'],
  ['MaximumEstimatedPreparationBytes', canonicalInt64], ['WriteBehavior'],
  ['SynchronizationWaitTimeoutMs', undefined, (value) => `SynchronizationWaitTimeout = ${formatTimeoutMilliseconds(Number(value))}`]);

/** Explicit operations for structural scalar records. Hashes are local to the TypeScript port. */
export const ContextScalarRecords = Object.freeze({
  MemoryScope: record<MemoryScope>('MemoryScope')(['UserId', optionalGuid], ['RepositoryId', optionalGuid], ['SessionId', optionalGuid]),
  MemorySource: record<MemorySource>('MemorySource')(['SessionId', guid], ['AnchorId', guid]),
  ContextCursor: record<ContextCursor>('ContextCursor')(['SessionId', guid], ['Revision', canonicalInt64], ['AfterSequence', canonicalInt64]),
  ModelContextItem: record<ModelContextItem>('ModelContextItem')(['EntryId', optionalGuid], ['MemoryId', optionalGuid], ['Role'], ['Text']),
  ContextSearchHit: record<ContextSearchHit>('ContextSearchHit')(
    ['EntryId', guid], ['AnchorId', optionalGuid], ['Snippet'], ['Sequence', canonicalInt64], ['SessionRevision', canonicalInt64]),
  ContextIndexStatus: record<ContextIndexStatus>('ContextIndexStatus', (value) => `IsComplete = ${display(value.PendingEntries === 0)}`)(
    ['SessionRevision', canonicalInt64], ['IndexGeneration', canonicalInt64], ['PendingEntries'], ['FailedEntries'], ['Error']),
  ContextIndexSynchronization: record<ContextIndexSynchronization>('ContextIndexSynchronization')(
    ['SessionId', guid], ['Generation', canonicalInt64], ['ContentRevision', canonicalInt64], ['PartitionsCompacted'], ['Succeeded'], ['Error']),
  DeleteEntry: record<Command<'DeleteEntry'>>('DeleteEntry', undefined, true)(['EntryId', guid]),
  RemoveAnchor: record<Command<'RemoveAnchor'>>('RemoveAnchor', undefined, true)(['AnchorId', guid]),
  SetSessionStatus: record<Command<'SetSessionStatus'>>('SetSessionStatus', undefined, true)(['Status']),
  ContextExecutionOptions: record<ContextExecutionOptions>('ContextExecutionOptions')(
    ['Indexing'], ['Preparation'], ['MinimumDeferredCharacters']),
  DeferredIndexingOptions: record<DeferredIndexingOptions>('DeferredIndexingOptions')(
    ['ForegroundWords'], ['ForegroundCharacters'], ['MaximumPendingEntries'], ['MaximumEstimatedWorkBytes', canonicalInt64]),
  PartitionedContextIndexOptions: Object.freeze({
    equals: partitionedRecord.equals, hash: partitionedRecord.hash, format: partitionedRecord.format,
    clone: freezePartitionedContextIndexOptions,
  }),
  ContextExecutionStatistics: record<ContextExecutionStatistics>('ContextExecutionStatistics')(
    ['TermCollector'], ['TermMemo'], ['Indexing'], ['Preparation'], ['EstimatedReservedBytes', canonicalInt64], ['MemoEntries'],
    ['TermCollections', canonicalInt64], ['MemoHits', canonicalInt64], ['MemoMisses', canonicalInt64],
    ['MemoBypasses', canonicalInt64], ['MemoAdmissionBypasses', canonicalInt64], ['SynchronousEntries', canonicalInt64],
    ['DeferredEntries', canonicalInt64], ['DeferredCapacityFallbacks', canonicalInt64],
    ['SpeculativePreparations', canonicalInt64], ['SerializedPreparations', canonicalInt64]),
});
