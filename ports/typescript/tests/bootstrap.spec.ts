// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { describe, expect, it } from 'vitest';
import { bootstrapContractSummary, exactIntegerProbe, ordinalCompare, utf16TextProbe } from '../src/bootstrap-probe.js';

describe('bootstrap toolchain', () => {
  it('preserves exact integer and UTF-16 semantics', () => {
    expect(exactIntegerProbe).toBe(9007199254740991n);
    expect(utf16TextProbe).toBe('A😀B');
    expect(utf16TextProbe.length).toBe(4);
    expect(ordinalCompare('apple', 'banana')).toBeLessThan(0);
    expect(ordinalCompare('banana', 'apple')).toBeGreaterThan(0);
    expect(bootstrapContractSummary()).toContain('Exact integer: 9007199254740991');
  });
});
