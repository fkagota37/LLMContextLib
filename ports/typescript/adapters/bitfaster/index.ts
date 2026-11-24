// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import {
  canonicalInt64, configureExecutionProviders, ContextExecutionRecipe, estimateTermBytes, isPositiveInt64, scalarRecord,
  type Int64, type LLMContextFactoryBuilder, type TermMemo,
} from 'llmcontextlib-port-typescript/adapter-support';

export interface BitFasterTermMemoOptions {
  readonly Capacity: number;
  readonly MaximumTextCharacters: number;
  readonly MaximumEstimatedBytes: Int64;
}

export const defaultBitFasterTermMemoOptions: BitFasterTermMemoOptions = Object.freeze({
  Capacity: 64, MaximumTextCharacters: 8192, MaximumEstimatedBytes: 1024 * 1024,
});

const memoRecord = scalarRecord<BitFasterTermMemoOptions>('BitFasterTermMemoOptions')(
  ['Capacity'], ['MaximumTextCharacters'], ['MaximumEstimatedBytes', canonicalInt64]);

export const BitFasterTermMemoOptionRecords = Object.freeze({
  equals: memoRecord.equals, hash: memoRecord.hash, format: memoRecord.format, clone: memoRecord.clone,
});

export function WithBitFasterTermMemoization(builder: LLMContextFactoryBuilder, options: BitFasterTermMemoOptions | null = null): LLMContextFactoryBuilder {
  if (!builder) throw new TypeError('Builder is required.');
  const selected = Object.freeze({ ...(options ?? defaultBitFasterTermMemoOptions) });
  const { Capacity: capacity, MaximumTextCharacters: maximumText, MaximumEstimatedBytes: bytes } = selected;
  if (!Number.isInteger(capacity) || capacity < 3 || capacity > 0x7fff_ffff ||
      !Number.isInteger(maximumText) || maximumText <= 0 || maximumText > 0x7fff_ffff || !isPositiveInt64(bytes)) {
    throw new RangeError('Invalid memo limits.');
  }
  const slots = BigInt(capacity) + 1n;
  const allowance = (BigInt(bytes) - 4096n - 512n * slots) / slots;
  if (allowance < 160n) {
    throw new RangeError('Memo bounds must allow infrastructure and at least 160 payload bytes per slot.');
  }
  return builder[configureExecutionProviders]((recipe) => new ContextExecutionRecipe(
    recipe.Collector, recipe.HasCustomCollector, () => new BoundedTermMemo(selected, allowance), bytes,
  ));
}

interface MemoEntry {
  readonly text: string;
  readonly terms: readonly string[];
  accessed: boolean;
}

class BoundedTermMemo implements TermMemo {
  public readonly Name = 'BitFasterConcurrentLru';
  private cache: Map<string, MemoEntry> | null = new Map();
  private readonly queues = [new Map<string, MemoEntry>(), new Map<string, MemoEntry>(), new Map<string, MemoEntry>()] as const;
  private readonly limits: readonly [number, number, number];
  private warmed = false;

  constructor(private readonly options: BitFasterTermMemoOptions, private readonly allowance: bigint) {
    const edge = Math.max(1, Math.floor((options.Capacity - Math.trunc(0.8 * options.Capacity)) / 2));
    this.limits = [edge, options.Capacity - 2 * edge, edge];
  }

  get MaximumTextCharacters(): number { return this.options.MaximumTextCharacters; }
  get Count(): number { return this.cache?.size ?? 0; }
  TryGet(text: string): readonly string[] | undefined {
    const entry = this.cache?.get(text);
    if (entry) entry.accessed = true;
    return entry?.terms;
  }

  TryAdd(text: string, terms: readonly string[]): boolean {
    const cache = this.cache;
    if (!cache || text.length > this.MaximumTextCharacters ||
        BigInt(32 + 2 * text.length + estimateTermBytes(terms)) > this.allowance) return false;
    if (this.TryGet(text) !== undefined) return true;
    const entry = { text, terms, accessed: false };
    cache.set(text, entry);
    this.queues[0].set(text, entry);
    if (this.queues[0].size > this.limits[0]) this.rotate();
    return true;
  }

  private take(queue: 0 | 1 | 2): MemoEntry {
    const first = this.queues[queue].values().next().value!;
    this.queues[queue].delete(first.text);
    return first;
  }

  private move(entry: MemoEntry, queue: 1 | 2): void {
    entry.accessed = false;
    this.queues[queue].set(entry.text, entry);
  }

  private rotate(): void {
    const oldestHot = this.take(0);
    if (!this.warmed) {
      this.move(oldestHot, 1);
      if (this.queues[1].size > this.limits[1]) {
        this.warmed = true;
        this.move(this.take(1), 2);
      }
    } else {
      let destination: 1 | 2 = oldestHot.accessed ? 1 : 2;
      this.move(oldestHot, destination);
      // The reference grants at most three second chances before forcing an eviction.
      for (let attempts = 0; attempts < 3; attempts++) {
        if (this.queues[destination].size <= this.limits[destination]) return;
        const oldest = this.take(destination);
        if (!oldest.accessed || this.queues[1].size > this.limits[1]) {
          if (destination === 2) {
            this.cache!.delete(oldest.text);
            return;
          }
          destination = 2;
        } else {
          destination = 1;
        }
        this.move(oldest, destination);
      }
      if (destination === 1) {
        if (this.queues[1].size > this.limits[1]) {
          this.move(this.take(1), 2);
        } else {
          if (this.queues[1].size > this.limits[2] && this.queues[2].size) this.cache!.delete(this.take(2).text);
          return;
        }
      }
    }
    if (this.queues[2].size > this.limits[2]) this.cache!.delete(this.take(2).text);
  }

  dispose(): void {
    this.cache = null;
    for (const queue of this.queues) queue.clear();
  }
}
