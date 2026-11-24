// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { openArrivals } from '../benchmarks/bounded-arrivals.js';

it('keeps offering at open-loop deadlines while service is held and accounts for every overflow', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered: number[] = [];
  const run = openArrivals({ rates: [500, 1000], stageMs: 50, workers: 1, capacity: 1 }, async (work) => {
    entered.push(work.id);
    await held;
    return work.id;
  });

  try {
    const boundaries = await run.offered;
    expect(boundaries.map(({ stage }) => stage)).toEqual([0, 1]);
    expect(boundaries[1].terminals).toBeGreaterThanOrEqual(73);
    expect(entered).toEqual([0]);
  } finally { release(); }
  const terminals = await run.drained;
  expect(terminals.map((terminal) => terminal.id)).toEqual(Array.from({ length: 75 }, (_, id) => id));
  const completed = terminals.filter((terminal) => terminal.kind === 'Completed');
  expect(completed.map((terminal) => terminal.result)).toEqual(entered);
  expect(completed.length).toBeLessThanOrEqual(2);
  expect(terminals[25]).toMatchObject({ stage: 1, dueMs: 50, kind: 'QueueRejected' });
});

it('stops future arrivals and cancels queued work without cancelling work in service', async () => {
  const stop = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let serviceStarted!: () => void;
  const entered = new Promise<void>((resolve) => { serviceStarted = resolve; });
  const run = openArrivals({ rates: [1000], stageMs: 2000, workers: 1, capacity: 1 }, async (work) => {
    serviceStarted();
    await held;
    return work.id;
  }, stop.signal);
  try {
    await entered;
    await delay(50);
    stop.abort();
    await run.offered;
  } finally { release(); }
  const terminals = await run.drained;
  expect(terminals.length).toBeLessThan(2000);
  expect(terminals[0]).toMatchObject({ kind: 'Completed', result: 0 });
  expect(terminals[1]).toMatchObject({ kind: 'Cancelled' });
  expect(terminals.slice(2).every(({ kind }) => kind === 'QueueRejected')).toBe(true);
});
