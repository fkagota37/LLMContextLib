// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { viewContracts } from './reference/view-contracts.js';

it('matches pinned view recipes, limits, callback errors and captured lifetimes', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/view-contracts.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  expect(viewContracts()).toEqual(expected);
});
