// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ForegroundLfu } from '../benchmarks/foreground-lfu.js';

it('matches pinned LFU aging, adaptive partition eviction and retained membership', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/foreground-lfu.json', import.meta.url), 'utf8')) as {
    capacity: number; allCounterAging: boolean; steps: [string, boolean][]; finalKeys: string[];
  };
  const cache = new ForegroundLfu(fixture.capacity, fixture.allCounterAging);
  const independent = new ForegroundLfu(fixture.capacity);
  const first = Object.freeze([fixture.steps[0][0]]);
  let retained: readonly string[] | undefined;
  try {
    fixture.steps.forEach(([key, expected], index) => {
      const hit = cache.TryGet(key);
      if (index === 1) retained = hit;
      expect(!!hit, `step ${index}`).toBe(expected);
      if (!hit) cache.TryAdd(key, index === 0 ? first : Object.freeze([key]));
      if (index % 19 === 0) cache.Maintain();
    });
    expect(cache.Keys).toEqual(fixture.finalKeys);
    expect(independent.Count).toBe(0);
    independent.TryAdd('independent', ['separate']);
    cache.dispose();
    expect(cache.Count).toBe(0);
    expect(retained).toBe(first);
    expect(retained).toEqual([fixture.steps[0][0]]);
    expect(independent.TryGet('independent')).toEqual(['separate']);
    expect(() => cache.TryGet('disposed')).toThrow(/disposed/);
  } finally { cache.dispose(); independent.dispose(); }
});
