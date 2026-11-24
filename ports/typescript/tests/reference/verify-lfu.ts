// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { ForegroundLfu } from '../../benchmarks/foreground-lfu.js';

let traces = 0, observations = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const trace = JSON.parse(line.replace(/^\uFEFF/, '')) as {
    capacity: number; allCounterAging: boolean; steps: { key: string; hit: boolean; count: number; maintain: boolean; keys: string[] | null;
      debug?: { frequencies: number[] } | null }[]; keys: string[];
  };
  const cache = new ForegroundLfu(trace.capacity, trace.allCounterAging);
  try {
    for (const [index, step] of trace.steps.entries()) {
      const hit = cache.TryGet(step.key);
      if (!hit) cache.TryAdd(step.key, [step.key]);
      if (step.maintain) cache.Maintain();
      assert.equal(!!hit, step.hit, `hit trace=${traces} step=${index}`);
      assert.equal(cache.Count, step.count, `count trace=${traces} step=${index}`);
      if (step.debug) assert.deepEqual(cache.Diagnostics(step.debug.frequencies.map((_, i) => `word${i}`)),
        step.debug, `debug trace=${traces} step=${index}`);
      if (step.keys) assert.deepEqual(cache.Keys, step.keys, `keys trace=${traces} step=${index}`);
      observations++;
    }
    cache.Maintain();
    assert.deepEqual(cache.Keys, trace.keys);
  } finally { cache.dispose(); }
  assert.equal(cache.Count, 0);
  traces++;
}
assert.equal(traces, 72, 'The pinned LFU matrix must not be truncated.');
assert.equal(observations, 147456);
console.log(`Matched ${traces} pinned foreground W-TinyLFU traces and ${observations} hit/count observations with matched UTF-16 hashes.`);
