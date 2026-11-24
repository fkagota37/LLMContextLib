// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { MessagePort } from 'node:worker_threads';
import type { Guid } from '../domain/session.js';
import { scanTerms } from '../policies/lexical.js';
import { ContextIndexPartition, type PartitionContribution } from '../storage/partitioned-index.js';
import { SessionStore, type EntryPreparationInput, type EntryPreparationOutput } from '../storage/session-store.js';

export interface NativeIndexInput {
  readonly Kind: 'Terms';
  readonly Parts: readonly string[];
  readonly Prefix: readonly string[];
  readonly Offset: number;
  readonly Collector?: { readonly Module: string; readonly Export: string };
}

export type NativeIndexOutput = { readonly Terms: readonly string[] } | { readonly Error: string };

export interface PartitionIndexInput {
  readonly Kind: 'Partition';
  readonly Contributions: ReadonlyMap<Guid, PartitionContribution>;
  readonly Overrides: ReadonlyMap<Guid, PartitionContribution | null>;
}

export type PartitionIndexOutput = { readonly Partition: Pick<ContextIndexPartition, 'Contributions' | 'Search' | 'BaseBytes'> } |
  { readonly Error: string };

export const stopRequested = 1;
export const stopped = 2;

export function runIndexMaintenanceWorker({ port, wake, stop }: { port: MessagePort; wake: Int32Array; stop: Int32Array },
  load: (url: string) => Promise<Record<string, unknown>>): void {
  let running = false;
  const acknowledge = () => {
    port.close();
    Atomics.store(stop, 0, stopped);
    Atomics.notify(stop, 0);
  };
  const checkCancellation = () => {
    if (Atomics.load(stop, 0) === stopRequested) throw new Error('Index maintenance stopped.');
  };
  port.on('message', async (input: NativeIndexInput | PartitionIndexInput | EntryPreparationInput | null) => {
    if (input === null) {
      if (!running) acknowledge();
      return;
    }
    if (Atomics.load(stop, 0) === stopRequested) return;

    let output: NativeIndexOutput | PartitionIndexOutput | EntryPreparationOutput;
    running = true;
    try {
      if (input.Kind === 'Terms') {
        if (input.Collector) {
          const module = await load(input.Collector.Module);
          checkCancellation();
          const collect = module[input.Collector.Export];
          if (typeof collect !== 'function') throw new TypeError('Invalid worker term collector export.');
          output = { Terms: collect(input.Parts.join(''), checkCancellation) as readonly string[] };
        } else {
          output = { Terms: scanTerms(input.Parts, Infinity, Infinity, input.Offset, input.Prefix, checkCancellation).Terms };
        }
      } else if (input.Kind === 'Partition') {
        const { Contributions, Search, BaseBytes } =
          ContextIndexPartition.Compact(input.Contributions, input.Overrides, checkCancellation);
        output = { Partition: { Contributions, Search, BaseBytes } };
      } else output = SessionStore.collectEntryPreparation(input, checkCancellation);
    } catch (error) {
      output = { Error: (error instanceof Error ? error.message : 'Index maintenance failed.').slice(0, 160) };
    } finally {
      running = false;
    }
    if (Atomics.load(stop, 0) === stopRequested) {
      acknowledge();
      return;
    }
    port.postMessage(output);
    Atomics.add(wake, 0, 1);
    Atomics.notify(wake, 0);
  });
}
