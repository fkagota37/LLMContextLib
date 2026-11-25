// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { Worker } from 'node:worker_threads';
import type { OwnerMailbox } from './owner-mailbox.js';
import { stopped, stopRequested } from './index-maintenance-worker.js';

export class IndexMaintenanceThread<Input, Output> {
  private readonly stop = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  private readonly worker: Worker;
  private readonly channel: ReturnType<OwnerMailbox['attachDuplex']>;
  private disposed = false;

  constructor(mailbox: OwnerMailbox, complete: (result: Output) => void, failure: (error: Error) => void) {
    this.channel = mailbox.attachDuplex((result) => {
      this.worker.unref();
      complete(result as Output);
    });
    const source = import.meta.url.endsWith('.ts');
    const url = new URL(source ? './index-maintenance-worker.ts' : './index-maintenance-worker.js', import.meta.url).href;
    const { port, wake } = this.channel.endpoint;
    try {
      this.worker = new Worker(`
        const { workerData } = require('node:worker_threads');
        const signalStopped = () => {
          Atomics.store(workerData.stop, 0, workerData.stopped);
          Atomics.notify(workerData.stop, 0);
        };
        process.once('exit', signalStopped);
        process.once('uncaughtExceptionMonitor', signalStopped);
        const load = (url) => workerData.source && url.endsWith('.ts')
          ? require('tsx/esm/api').tsImport(url, workerData.parent)
          : import(url);
        load(workerData.url).then((module) => module.runIndexMaintenanceWorker(workerData, load)).catch((error) => {
          signalStopped();
          throw error;
        });
      `, {
        eval: true, execArgv: [], workerData: { port, wake, stop: this.stop, source, url, parent: import.meta.url, stopped },
        transferList: [port],
      });
    } catch (error) {
      this.channel.close();
      port.close();
      throw error;
    }
    this.worker.unref();
    let failed = false;
    const reportFailure = (error: Error) => {
      Atomics.store(this.stop, 0, stopped);
      Atomics.notify(this.stop, 0);
      if (this.disposed || failed) return;
      failed = true;
      this.channel.close();
      failure(error);
    };
    this.worker.on('error', reportFailure);
    this.worker.on('exit', (code) => reportFailure(new Error(`Index maintenance worker stopped unexpectedly (${code}).`)));
  }

  submit(input: Input): void {
    this.worker.ref();
    this.channel.post(input);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (Atomics.compareExchange(this.stop, 0, 0, stopRequested) === 0) {
      this.channel.post(null);
      if (Atomics.wait(this.stop, 0, stopRequested, 5000) === 'timed-out') void this.worker.terminate();
    }
    this.channel.close();
  }
}
