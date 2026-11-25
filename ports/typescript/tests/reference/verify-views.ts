// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { viewContracts } from './view-contracts.js';

const expected = JSON.parse(readFileSync(process.argv[2] ?? 0, 'utf8').replace(/^\uFEFF/, ''));
const actual = viewContracts();
assert.deepEqual(actual, expected);
console.log(`Matched ${actual.rows.length} pinned built-in view observations.`);
