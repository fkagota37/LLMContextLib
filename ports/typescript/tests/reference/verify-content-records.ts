// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContextContent, ContextContentRecords as records, SummaryContent, TextContent, ToolCallContent, ToolResultContent } from '../../src/index.js';

const cases = [
  new TextContent(''), new TextContent('value'), new TextContent('value'), new TextContent('Value'),
  new SummaryContent('value', 0), new SummaryContent('value', 9007199254740993n), new SummaryContent('value', 9007199254740993n),
  new ToolCallContent('call', 'build', '{"jobs":2}'), new ToolCallContent('call', 'build', '{ "jobs":2 }'),
  new ToolResultContent('call', 'done', false), new ToolResultContent('call', 'done', true),
];
const actual = cases.map((value) => {
  const base: ContextContent = value;
  const copy = records.clone(base);
  const equal = cases.map((other) => {
    const same = records.equals(value, other);
    if (same) assert.equal(records.hash(value), records.hash(other));
    return same;
  });
  assert.equal(Object.getPrototypeOf(copy), Object.getPrototypeOf(value));
  assert(Object.isFrozen(copy));
  return {
    display: records.format(base),
    fields: records.deconstruct(value).map((field) => typeof field === 'bigint' || typeof field === 'number' ? String(field) : field),
    equal,
    equalBase: cases.map((other: ContextContent) => records.equals(base, other)),
    equalObject: [...cases, { ...value }, 'value'].map((other) => records.equals(base, other)),
    equalsNull: records.equals(value, null),
    cloneDistinct: value !== copy,
    cloneEqual: records.equals(value, copy),
    cloneHashEqual: records.hash(base) === records.hash(copy),
  };
});

assert.deepEqual(actual, JSON.parse(readFileSync(0, 'utf8')));
assert(records.equals(new SummaryContent('safe', 17), new SummaryContent('safe', 17n)));
const fake = { ...cases[0] } as TextContent;
assert(!records.equals(cases[0], fake));
assert.throws(() => records.clone(fake), TypeError);
console.log(`Matched ${cases.length} content records and ${cases.length ** 2} pairwise equality comparisons.`);
