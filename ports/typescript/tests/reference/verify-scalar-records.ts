// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContextScalarRecords } from '../../src/domain/scalar-records.js';
import { canonicalInt64 } from '../../src/domain/int64.js';
import { BitFasterTermMemoOptionRecords } from '../../adapters/bitfaster/index.js';

type Value = Record<string, string | number | bigint | boolean | null>;
interface Operations {
  equals(left: Value | null, right: Value | null): boolean;
  hash(value: Value): number;
  format(value: Value): string;
  clone(value: Value): Value;
  deconstruct(value: Value): readonly unknown[];
}
const schemas = { ...ContextScalarRecords, BitFasterTermMemoOptions: BitFasterTermMemoOptionRecords };
interface Row {
  readonly type: keyof typeof schemas;
  readonly value: Value;
  readonly text: string;
  readonly fields: readonly unknown[] | null;
  readonly equals: readonly boolean[];
  readonly copied: boolean;
}

const rows = JSON.parse(readFileSync(0, 'utf8')) as Row[];
const numeric = new Set([
  'Revision', 'AfterSequence', 'Sequence', 'SessionRevision', 'IndexGeneration', 'Generation', 'ContentRevision',
  'MaximumEstimatedWorkBytes', 'EstimatedReservedBytes', 'TermCollections', 'MemoHits', 'MemoMisses', 'MemoBypasses',
  'MemoAdmissionBypasses', 'SynchronousEntries', 'DeferredEntries', 'DeferredCapacityFallbacks',
  'SpeculativePreparations', 'SerializedPreparations',
  'MaximumEstimatedPartitionBytes', 'MaximumEstimatedWorkingSetBytes', 'MaximumEstimatedPreparationBytes', 'MaximumEstimatedBytes',
]);
const commands = new Set(['DeleteEntry', 'RemoveAnchor', 'SetSessionStatus']);
const inputs = rows.map(({ value, type }, index) => {
  const parsed: Value = { ...value };
  if (commands.has(type)) parsed.kind = type;
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'string' && numeric.has(key)) parsed[key] = index % 2 === 0 ? BigInt(field) : canonicalInt64(BigInt(field));
    else if (index % 2 === 0 && key.endsWith('Id') && typeof field === 'string') parsed[key] = field.toUpperCase();
    else if (type === 'MemoryScope' && index % 2 === 0 && field === null) delete parsed[key];
  }
  return parsed;
});
let pairs = 0;
for (const [index, row] of rows.entries()) {
  const operations = schemas[row.type] as unknown as Operations;
  const value = inputs[index];
  const clone = operations.clone(value);
  assert.notEqual(clone, value);
  assert(Object.isFrozen(clone));
  assert.equal(operations.equals(value, clone), row.copied);
  assert.equal(operations.hash(value), operations.hash(clone));
  assert.equal(operations.format(value), row.text, row.type);
  if (row.type === 'PartitionedContextIndexOptions') {
    assert.equal(clone.InfrastructureBytes, 4096 + 512 * Number(value.MaximumPendingSynchronizations));
    assert.equal(clone.RecoveryBytes, canonicalInt64(2n * BigInt(value.MaximumEstimatedPartitionBytes!)));
  }
  if (row.fields) {
    const fields = operations.deconstruct(value);
    assert(Object.isFrozen(fields));
    assert.deepEqual(fields.map((field) => typeof field === 'bigint' ? String(field) : field),
      row.fields.map((field, position) => typeof fields[position] === 'number' && typeof field === 'string' && /^-?\d+$/.test(field) ? Number(field) : field));
  }
  assert.equal(operations.equals(value, null), false);
  assert.equal(operations.equals(null, null), true);
  for (const [other, candidate] of rows.entries()) {
    if (candidate.type !== row.type && !commands.has(row.type)) continue;
    assert.equal(operations.equals(value, inputs[other]), row.equals[other]);
    if (row.equals[other]) assert.equal(operations.hash(value), operations.hash(inputs[other]));
    pairs++;
  }
}
assert.equal(new Set(rows.map(({ type }) => type)).size, Object.keys(schemas).length);
console.log(`Matched ${rows.length} scalar records and ${pairs} equality comparisons.`);
