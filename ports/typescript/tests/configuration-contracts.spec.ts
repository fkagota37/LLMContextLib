// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { configurationContracts } from './reference/configuration-contracts.js';
import { LLMContextFactory } from '../src/factory.js';

it('matches pinned nested-option, strategy-replacement and adapter errors', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/configuration-contracts.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  expect(configurationContracts()).toEqual(expected);
  expect(() => LLMContextFactory.Create().WithExecutionStrategies({ MinimumDeferredCharacters: 2147483648 })).toThrow(RangeError);
});
