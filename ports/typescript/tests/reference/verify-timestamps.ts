// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { timestampTicks } from '../../src/domain/date-time-offset.js';

const rows = readFileSync(0, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { input: string; ticks: string | null });
assert.equal(rows.length, 10014);
for (const { input, ticks } of rows) {
  if (ticks === null) assert.throws(() => timestampTicks(input), RangeError, input);
  else assert.equal(timestampTicks(input), BigInt(ticks), input);
}
console.log(`Matched ${rows.length} DateTimeOffset observations at 100 ns precision.`);
