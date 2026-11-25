// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { setEnvironmentData } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { IndexMaintenanceThread } from '../src/runtime/index-maintenance-thread.js';
import type { NativeIndexInput, NativeIndexOutput } from '../src/runtime/index-maintenance-worker.js';
import { OwnerMailbox } from '../src/runtime/owner-mailbox.js';

it.each([false, true])('joins running collector work on disposal (worker exits: %s)', async (exitWorker) => {
  const key = `index-maintenance-join-${exitWorker}`;
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  setEnvironmentData(key, state);
  const mailbox = new OwnerMailbox();
  const complete = vi.fn();
  const failure = vi.fn();
  const thread = new IndexMaintenanceThread<NativeIndexInput, NativeIndexOutput>(mailbox, complete, failure);
  const source = `
    import { getEnvironmentData } from 'node:worker_threads';
    const state = getEnvironmentData(${JSON.stringify(key)});
    export function collect(text, checkCancellation) {
      Atomics.store(state, 0, 1);
      try {
        while (true) {
          checkCancellation();
          Atomics.wait(state, 0, 1, 5);
        }
      } finally {
        Atomics.store(state, 0, 2);
        if (${exitWorker}) process.exit(7);
      }
    }`;
  try {
    thread.submit({ Kind: 'Terms', Parts: ['pending'], Offset: 0, Prefix: [],
      Collector: { Module: `data:text/javascript,${encodeURIComponent(source)}`, Export: 'collect' } });
    await vi.waitFor(() => expect(Atomics.load(state, 0)).toBe(1));
    const started = performance.now();
    thread.dispose();
    expect(Atomics.load(state, 0)).toBe(2);
    expect(performance.now() - started).toBeLessThan(4000);
    expect(complete).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  } finally { thread.dispose(); mailbox.dispose(); setEnvironmentData(key, undefined); }
});

it('can dispose from the worker transport failure handler without waiting for its own exit callback', async () => {
  const failures: Error[] = [];
  let resolve!: () => void;
  const notified = new Promise<void>((complete) => { resolve = complete; });
  const thread = new IndexMaintenanceThread<NativeIndexInput, NativeIndexOutput>(new OwnerMailbox(),
    () => { throw new Error('Uncloneable worker output must not complete a request.'); },
    (error) => {
      failures.push(error);
      thread.dispose();
      resolve();
    });
  try {
    const start = performance.now();
    thread.submit({ Kind: 'Terms', Parts: ['pending'], Offset: 0, Prefix: [],
      Collector: { Module: 'data:text/javascript,export const collect = () => Symbol()', Export: 'collect' } });
    await notified;
    expect(performance.now() - start).toBeLessThan(4000);
    expect(failures).toHaveLength(1);
  } finally { thread.dispose(); }
});
