// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContextEntryRecords } from '../../src/domain/entry-records.js';
import { ContextIndexKeys } from '../../src/domain/index-keys.js';
import { TextContent, type ContextRole } from '../../src/domain/session.js';

type Value = { EntryId: string; Sequence?: bigint; Role?: ContextRole; CreatedAt?: string; Content: TextContent; IndexKeys?: readonly string[] };
type Wire = Omit<Value, 'Content' | 'IndexKeys' | 'Sequence'> & { Content: { Text: string }; Sequence?: string; IndexKeys: string | null };
interface Operations {
  equals(left: Value | null, right: Value | null): boolean;
  hash(value: Value): number;
  format(value: Value): string;
  deconstruct(value: Value): readonly unknown[];
  clone(value: Value): Value;
}
interface Row {
  type: keyof typeof ContextEntryRecords;
  value: Wire;
  text: string;
  fields: readonly unknown[];
  equals: readonly boolean[];
  copied: boolean;
}
const inputs = JSON.parse(readFileSync(0, 'utf8')) as Row[];
const shared = new ContextIndexKeys(['opaque']).Keys;
const separate = new ContextIndexKeys(['opaque']).Keys;
const values = inputs.map(({ value, type }, index): Value => ({
  ...value, ...(type === 'ReplaceEntry' ? { kind: 'ReplaceEntry' } : {}),
  EntryId: index % 2 === 0 ? value.EntryId.toUpperCase() : value.EntryId,
  Content: new TextContent(value.Content.Text), Sequence: value.Sequence === undefined ? undefined : BigInt(value.Sequence),
  IndexKeys: value.IndexKeys === null ? undefined : value.IndexKeys === 'shared' ? shared : separate,
}));

let pairs = 0;
for (const [index, row] of inputs.entries()) {
  const operations = ContextEntryRecords[row.type] as unknown as Operations;
  const value = values[index];
  const copy = operations.clone(value);
  assert.notEqual(copy, value);
  assert(Object.isFrozen(copy));
  assert.equal(operations.equals(value, copy), row.copied);
  assert.equal(operations.hash(value), operations.hash(copy));
  assert.equal(copy.Content, value.Content);
  assert.equal(copy.IndexKeys, value.IndexKeys);
  assert.equal(operations.format(value), row.text, row.type);
  const fields = operations.deconstruct(value);
  assert.equal(fields.at(-1), value.Content);
  assert.deepEqual(fields.map((field) => typeof field === 'bigint' ? String(field) :
    field instanceof TextContent ? { kind: field.kind, Text: field.Text } : field), row.fields);
  for (const [other, candidate] of inputs.entries()) {
    if (candidate.type !== row.type) continue;
    assert.equal(operations.equals(value, values[other]), row.equals[other]);
    if (row.equals[other]) assert.equal(operations.hash(value), operations.hash(values[other]));
    pairs++;
  }
}
assert.equal(new Set(inputs.map(({ type }) => type)).size, Object.keys(ContextEntryRecords).length);
console.log(`Matched ${inputs.length} entry records and ${pairs} same-type equality comparisons.`);
