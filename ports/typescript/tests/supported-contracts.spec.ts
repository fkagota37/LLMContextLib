// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { supportedContracts } from './reference/supported-contracts.js';

it('matches pinned option, projection, scope, error and recovery observations', async () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/supported-contracts.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  expect(await supportedContracts()).toEqual(expected);
});
