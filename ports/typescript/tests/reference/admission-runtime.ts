// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { SessionStatus } from '../../src/domain/session.js';
import { LLMContextFactory } from '../../src/factory.js';

const sessionId = '00000000-0000-0000-0000-000000000001';
const owner = LLMContextFactory.Create({ MaximumRetainedReads: 1, AdmissionTimeoutMs: 200 }).Initialize([{
  SessionId: sessionId, UserId: '00000000-0000-0000-0000-000000000002', RepositoryId: null,
  Revision: 0, Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
}]);

const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
let released = false;
let worker: Worker | undefined;
let held: ReturnType<typeof owner.OpenRead> | undefined;
try {
  held = owner.OpenRead(sessionId);
  const release = new Promise<void>((resolve) => setImmediate(() => {
    held!.dispose();
    released = true;
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    resolve();
  }));
  let admission: string;
  try {
    const read = owner.OpenRead(sessionId);
    read.dispose();
    admission = 'admitted';
  } catch (error) {
    admission = (error as Error).message;
  }
  const sameIsolate = Atomics.wait(signal, 0, 0, 20);
  const releasedDuringWait = released;
  await release;

  Atomics.store(signal, 0, 0);
  worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const word = new Int32Array(workerData);
    parentPort.postMessage('ready');
    parentPort.once('message', () => {
      Atomics.store(word, 0, 1);
      Atomics.notify(word, 0);
    });
  `, { eval: true, workerData: signal.buffer });
  await once(worker, 'message');
  let closureTransferable = true;
  try { worker.postMessage(() => held!.dispose()); }
  catch { closureTransferable = false; }
  worker.postMessage('release signal');
  const workerWait = Atomics.wait(signal, 0, 0, 1000);
  console.log(JSON.stringify({ admission, sameIsolate, releasedDuringWait, workerWait, closureTransferable }));
  if (sameIsolate !== 'timed-out' || releasedDuringWait ||
      (workerWait !== 'ok' && workerWait !== 'not-equal') || closureTransferable) {
    throw new Error('Node admission assumptions changed; revisit the runtime design.');
  }
} finally {
  await worker?.terminate();
  held?.dispose();
  owner.dispose();
}
