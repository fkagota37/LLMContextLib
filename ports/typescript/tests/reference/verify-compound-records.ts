// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContextChangeRecords, ContextCompoundRecords, ContextEntryRecords, ContextScalarRecords, TextContent, type ContextChange } from '../../src/index.js';
import { canonicalInt64 } from '../../src/domain/int64.js';

type Value = Record<string, unknown>;
type Wire = null | string | number | boolean | { number: string } | { reference: number; isMap: boolean } |
  { record: string; members: Record<string, Wire> };
interface Row {
  type: keyof typeof schemas;
  value: Wire;
  text: string;
  fields: readonly Wire[];
  equals: readonly boolean[];
  changeEquals: readonly boolean[] | null;
  copied: boolean;
}
interface Operations {
  equals(left: Value | null, right: Value | null): boolean;
  hash(value: Value): number;
  format(value: Value): string;
  deconstruct(value: Value): readonly unknown[];
  clone(value: Value): Value;
}
const commandSchemas = {
  AppendEntries: ContextCompoundRecords.AppendEntries,
  ReplaceEntry: ContextEntryRecords.ReplaceEntry,
  DeleteEntry: ContextScalarRecords.DeleteEntry,
  ReplaceSegment: ContextCompoundRecords.ReplaceSegment,
  PutAnchor: ContextCompoundRecords.PutAnchor,
  RemoveAnchor: ContextScalarRecords.RemoveAnchor,
  SetSessionStatus: ContextScalarRecords.SetSessionStatus,
};
const schemas = { ...ContextCompoundRecords, ...commandSchemas };
const commands = new Set(Object.keys(commandSchemas));
const references = new Map<number, object>();
function decode(wire: Wire): unknown {
  if (wire === null || typeof wire !== 'object') return wire;
  if ('number' in wire) return canonicalInt64(BigInt(wire.number));
  if ('reference' in wire) {
    let value = references.get(wire.reference);
    if (value === undefined) {
      value = wire.isMap ? new Map() : Object.freeze([]);
      references.set(wire.reference, value);
    }
    return value;
  }
  if (wire.record === 'TextContent') return new TextContent(String(wire.members.Text));
  return {
    ...Object.fromEntries(Object.entries(wire.members).map(([key, member]) => [key, decode(member)])),
    ...(commands.has(wire.record) ? { kind: wire.record } : {}),
  };
}

const rows = JSON.parse(readFileSync(0, 'utf8')) as Row[];
const values = rows.map(({ value }) => decode(value) as Value);
const changes = values.filter((value, index) => commands.has(rows[index].type)) as unknown as ContextChange[];
let pairs = 0;
let commandPairs = 0;
for (const [index, row] of rows.entries()) {
  const operations = schemas[row.type] as unknown as Operations;
  const value = values[index];
  const copy = operations.clone(value);
  assert.notEqual(copy, value);
  assert(Object.isFrozen(copy));
  assert.equal(operations.equals(value, copy), row.copied, `${row.type} clone`);
  assert.equal(operations.hash(value), operations.hash(copy));
  for (const key of Object.keys(value)) assert.equal(copy[key], value[key], `${row.type}.${key} clone identity`);
  assert.equal(operations.format(value), row.text, row.type);
  const fields = operations.deconstruct(value);
  assert.deepEqual(fields, row.fields.map(decode), `${row.type} positional fields`);
  for (const [field, encoded] of row.fields.entries()) {
    if (encoded !== null && typeof encoded === 'object' && 'reference' in encoded) {
      assert.equal(fields[field], decode(encoded), `${row.type} positional collection identity`);
    }
  }
  for (const [other, candidate] of rows.entries()) {
    if (candidate.type !== row.type) continue;
    assert.equal(operations.equals(value, values[other]), row.equals[other], `${row.type} equality: ${index}, ${other}`);
    if (row.equals[other]) assert.equal(operations.hash(value), operations.hash(values[other]));
    pairs++;
  }
  if (row.changeEquals !== null) {
    const change = value as unknown as ContextChange;
    const cloned = ContextChangeRecords.clone(change);
    assert.notEqual(cloned, change);
    assert.deepEqual(cloned, copy);
    for (const [key, member] of Object.entries(cloned)) assert.equal(member, value[key]);
    assert.equal(ContextChangeRecords.hash(change), operations.hash(value));
    assert.equal(ContextChangeRecords.format(change), row.text);
    assert.deepEqual([...changes, null].map((other) => ContextChangeRecords.equals(change, other)), row.changeEquals);
    assert.equal(ContextChangeRecords.equals(null, change), false);
    commandPairs += row.changeEquals.length;
  }
}
assert.equal(ContextChangeRecords.equals(null, null), true);
assert.equal(new Set(rows.map(({ type }) => type)).size, Object.keys(schemas).length);
console.log(`Matched ${rows.length} records, ${pairs} concrete equality comparisons, and ${commandPairs} base command comparisons.`);
