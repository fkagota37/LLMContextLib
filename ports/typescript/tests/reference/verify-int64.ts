// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { advanceInt64, canonicalInt64, checkedInt64, compareInt64, incrementCounter, isInt64 } from '../../src/domain/int64.js';

type Row = { left: string; right: string; uncheckedIncrement: string; comparison: number; sum: string | null };
const rows = readFileSync(0, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Row);
assert.equal(rows.length, 4217);
for (const row of rows) {
  const left = canonicalInt64(BigInt(row.left)), right = canonicalInt64(BigInt(row.right));
  assert.equal(typeof left, Number.isSafeInteger(Number(row.left)) ? 'number' : 'bigint');
  assert.equal(compareInt64(left, right), row.comparison);
  assert.equal(String(incrementCounter(left)), row.uncheckedIncrement);
  const sum = BigInt(left) + BigInt(right);
  if (row.sum === null) {
    assert.throws(() => checkedInt64(sum), RangeError);
    assert.throws(() => advanceInt64(left, BigInt(right)), RangeError);
    assert.equal(isInt64(sum), false);
  } else {
    assert.equal(String(checkedInt64(sum)), row.sum);
    assert.equal(String(advanceInt64(left, BigInt(right))), row.sum);
  }
}
console.log(`Matched ${rows.length} checked arithmetic, comparison, and wrapping-counter cases.`);
