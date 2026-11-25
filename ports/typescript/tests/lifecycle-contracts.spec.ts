// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { lifecycleContracts } from './reference/lifecycle-contracts.js';

it('matches pinned synchronization cancellation, failure recovery and supported provider shutdown', async () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/lifecycle-contracts.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  expect(await lifecycleContracts()).toEqual(expected);
}, 15000);
