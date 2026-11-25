// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { Worker } from 'node:worker_threads';

export interface ArrivalPlan {
  readonly rates: readonly number[];
  readonly stageMs: number;
  readonly workers: number;
  readonly capacity: number;
}

export interface Arrival {
  readonly id: number;
  readonly stage: number;
  readonly dueMs: number;
  readonly offeredMs: number;
}

export interface StageBoundary {
  readonly stage: number;
  readonly elapsedMs: number;
  readonly queued: number;
  readonly inFlight: number;
  readonly terminals: number;
}

export type ArrivalTerminal<T> = Arrival & (
  | { readonly kind: 'QueueRejected' }
  | { readonly kind: 'Cancelled'; readonly queueMs: number }
  | { readonly kind: 'Completed'; readonly queueMs: number; readonly executionMs: number; readonly result: T }
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function openArrivals<T>(plan: ArrivalPlan, service: (work: Arrival) => T | Promise<T>, signal?: AbortSignal): {
  started: Promise<bigint>;
  offered: Promise<readonly StageBoundary[]>;
  drained: Promise<readonly ArrivalTerminal<T>[]>;
} {
  const { rates, stageMs, workers, capacity } = plan;
  const within = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!within(rates.length, 1, 5) || !rates.every((rate, index) => within(rate, 1, 10000) && (!index || rate > rates[index - 1])) ||
      !within(stageMs, 50, 5000) || !within(workers, 1, 8) || !within(capacity, 1, 1024)) {
    throw new RangeError('Invalid open-arrival plan.');
  }
  const count = rates.reduce((sum, rate) => sum + Math.ceil(rate * stageMs / 1000), 0);
  if (count > 20000) throw new RangeError('Open-arrival request cap exceeded.');
  const [queued, inFlight, terminal] = [0, 1, 2];
  const activity = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  const stop = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const cancel = () => { Atomics.store(stop, 0, 1); Atomics.notify(stop, 0); };
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const producer = new Worker(`
    const { parentPort, workerData: { rates, stageMs, capacity, activity, stop, queued, inFlight, terminal } } = require('node:worker_threads');
    const origin = process.hrtime.bigint();
    const now = () => Number(process.hrtime.bigint() - origin) / 1e6;
    parentPort.postMessage({ origin });
    const rejected = [];
    const boundaries = [];
    let id = 0;
    for (let stage = 0; stage < rates.length && !Atomics.load(stop, 0); stage++) {
      const offered = Math.ceil(rates[stage] * stageMs / 1000);
      for (let index = 0; index < offered; index++) {
        const dueMs = stage * stageMs + index * 1000 / rates[stage];
        const remaining = dueMs - now();
        if (remaining > 0) Atomics.wait(stop, 0, 0, remaining);
        if (Atomics.load(stop, 0)) break;
        const work = { id: id++, stage, dueMs, offeredMs: now() };
        for (;;) {
          const before = Atomics.load(activity, queued);
          if (before >= capacity) {
            rejected.push({ ...work, kind: 'QueueRejected' });
            Atomics.add(activity, terminal, 1);
            break;
          }
          if (Atomics.compareExchange(activity, queued, before, before + 1) === before) {
            parentPort.postMessage({ work });
            break;
          }
        }
      }
      const remaining = (stage + 1) * stageMs - now();
      if (remaining > 0) Atomics.wait(stop, 0, 0, remaining);
      boundaries.push({ stage, elapsedMs: now(), queued: Atomics.load(activity, queued),
        inFlight: Atomics.load(activity, inFlight), terminals: Atomics.load(activity, terminal) });
    }
    parentPort.postMessage({ rejected, offeredCount: id, boundaries });
  `, { eval: true, workerData: { rates, stageMs, capacity, activity, stop, queued, inFlight, terminal } });

  const queue = new Map<number, Arrival>();
  let head = 0;
  let tail = 0;
  const terminals: ArrivalTerminal<T>[] = [];
  let origin = 0n;
  let running = 0;
  let complete = false;
  let offeredCount = 0;
  let failure: unknown;
  let done = false;
  const offered = deferred<readonly StageBoundary[]>();
  const started = deferred<bigint>();
  const drained = deferred<readonly ArrivalTerminal<T>[]>();
  void started.promise.catch(() => {});
  void offered.promise.catch(() => {});
  void drained.promise.catch(() => {});
  const now = () => Number(process.hrtime.bigint() - origin) / 1e6;
  const finish = () => {
    if (done || !complete || running || queue.size) return;
    done = true;
    signal?.removeEventListener('abort', cancel);
    if (failure !== undefined) drained.reject(failure);
    else if (terminals.length !== offeredCount || (!Atomics.load(stop, 0) && offeredCount !== count) ||
        Atomics.load(activity, queued) !== 0 || Atomics.load(activity, inFlight) !== 0 ||
        Atomics.load(activity, terminal) !== offeredCount) {
      drained.reject(new Error('Open-arrival accounting did not reconcile.'));
    } else {
      terminals.sort((a, b) => a.id - b.id);
      if (terminals.some((terminal, id) => terminal.id !== id)) drained.reject(new Error('Duplicate or missing terminal.'));
      else drained.resolve(terminals);
    }
  };
  const schedule = () => {
    while (running < workers && queue.size) {
      const work = queue.get(head)!;
      queue.delete(head++);
      Atomics.sub(activity, queued, 1);
      const entered = now();
      if (Atomics.load(stop, 0)) {
        terminals.push({ ...work, kind: 'Cancelled', queueMs: Math.max(0, entered - work.offeredMs) });
        Atomics.add(activity, terminal, 1);
        continue;
      }
      running++;
      Atomics.add(activity, inFlight, 1);
      void Promise.resolve().then(() => service(work)).then((result) => {
        terminals.push({ ...work, kind: 'Completed', queueMs: Math.max(0, entered - work.offeredMs), executionMs: now() - entered, result });
        Atomics.add(activity, terminal, 1);
      }, (error) => { failure ??= error ?? new Error('Open-arrival service failed.'); }).finally(() => {
        running--;
        Atomics.sub(activity, inFlight, 1);
        schedule();
      });
    }
    finish();
  };
  const fail = (error: Error) => {
    failure ??= error;
    complete = true;
    started.reject(error);
    offered.reject(error);
    finish();
  };
  producer.on('message', (message: { origin: bigint } | { work: Arrival } | {
    rejected: ArrivalTerminal<T>[]; offeredCount: number; boundaries: readonly StageBoundary[];
  }) => {
    if ('origin' in message) {
      origin = message.origin;
      started.resolve(origin);
    }
    else if ('work' in message) {
      queue.set(tail++, message.work);
      schedule();
    } else {
      for (const rejection of message.rejected) terminals.push(rejection);
      offeredCount = message.offeredCount;
      complete = true;
      offered.resolve(message.boundaries);
      finish();
    }
  });
  producer.on('error', fail);
  producer.on('exit', (code) => {
    if (!complete || code !== 0) fail(new Error(`Open-arrival producer exited unexpectedly (${code}).`));
  });
  return { started: started.promise, offered: offered.promise, drained: drained.promise };
}
