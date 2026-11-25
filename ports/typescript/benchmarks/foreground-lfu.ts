// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.
//
// Adapted from BitFaster.Caching v2.6.1 (a71bec32a6b7f621af7a9d2b1d7c4edd0209b289):
// ConcurrentLfuCore, CmSketchCore and LfuCapacityPartition. Diagnostic only.
// Copyright (c) 2020 Alex Peck
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

interface Node {
  readonly key: string;
  readonly value: readonly string[];
  position: number;
  removed: boolean;
}

export function diagnosticTextHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return hash | 0;
}

class FrequencySketch {
  private readonly table: Uint8Array;
  private readonly mask: number;
  private size = 0;
  readonly sampleSize: number;
  get Size(): number { return this.size; }

  constructor(capacity: number, private readonly allCounterAging: boolean) {
    const words = Math.max(8, 2 ** Math.ceil(Math.log2(capacity)));
    this.table = new Uint8Array(words * 16);
    this.mask = words / 8 - 1;
    this.sampleSize = 10 * capacity;
  }

  private indexes(key: string): number[] {
    let hash = diagnosticTextHash(key);
    hash ^= hash >>> 17;
    hash = Math.imul(hash, 0xed5ad4bb);
    hash ^= hash >>> 11;
    hash = Math.imul(hash, 0xac4c1b51);
    hash ^= hash >>> 15;
    let counters = Math.imul(hash, 0x31848bab);
    counters ^= counters >>> 14;
    const block = (hash & this.mask) * 8;
    return [0, 1, 2, 3].map((row) => {
      const octet = counters >>> (row * 8);
      return (block + row * 2 + (octet & 1)) * 16 + ((octet >>> 1) & 15);
    });
  }

  frequency(key: string): number { return Math.min(...this.indexes(key).map((index) => this.table[index])); }

  increment(key: string): void {
    let advanced = 0;
    for (const index of this.indexes(key)) {
      if (this.table[index] < 15) { this.table[index]++; advanced++; }
    }
    const added = this.allCounterAging ? advanced === 4 : advanced > 0;
    if (!added || ++this.size !== this.sampleSize) return;
    let odd = 0;
    for (let index = 0; index < this.table.length; index++) {
      odd += this.table[index] & 1;
      this.table[index] >>>= 1;
    }
    this.size = (this.size - (odd >>> 2)) >>> 1;
  }

  clear(): void { this.table.fill(0); this.size = 0; }
}

/** Owner-isolate W-TinyLFU with bounded buffered reads and synchronous maintenance; not a production adapter. */
export class ForegroundLfu {
  readonly Name = 'BitFasterLfuForeground';
  readonly MaximumTextCharacters = 8192;
  private readonly cache = new Map<string, Node>();
  private readonly queues = [new Map<string, Node>(), new Map<string, Node>(), new Map<string, Node>()];
  private readonly sketch: FrequencySketch;
  private readonly reads: Node[] = [];
  private limits: readonly number[];
  private disposed = false;
  private hits = 0;
  private misses = 0;
  private previousHits = 0;
  private previousMisses = 0;
  private previousHitRate = 1;
  private mainRatio = .99;
  private stepSize = .0625;

  constructor(readonly Capacity = 64, readonly AllCounterAging = true) {
    if (!Number.isInteger(Capacity) || Capacity < 3 || Capacity > 0x7fff_ffff) throw new RangeError('Invalid LFU capacity.');
    this.sketch = new FrequencySketch(Capacity, AllCounterAging);
    this.limits = this.partition();
  }

  get Count(): number { return this.cache.size; }
  get Keys(): readonly string[] { return [...this.cache.keys()].sort(); }
  Diagnostics(keys: readonly string[]) {
    return { keys: this.Keys, queues: this.queues.map((queue) => [...queue.keys()]), limits: this.limits, sketchSize: this.sketch.Size,
      frequencies: keys.map((key) => this.sketch.frequency(key)) };
  }

  TryGet(text: string): readonly string[] | undefined {
    this.check();
    const entry = this.cache.get(text);
    if (!entry) { this.misses++; return undefined; }
    if (this.reads.length < 128) this.reads.push(entry);
    else this.Maintain();
    return entry.value;
  }

  TryAdd(text: string, value: readonly string[]): boolean {
    this.check();
    if (text.length > this.MaximumTextCharacters) return false;
    if (this.cache.has(text)) return true;
    const entry: Node = { key: text, value, position: 0, removed: false };
    this.cache.set(text, entry);
    this.maintain(entry);
    return true;
  }

  Maintain(): void { if (!this.disposed) this.maintain(); }

  private maintain(write?: Node): void {
    for (const node of this.reads) this.sketch.increment(node.key);
    for (const node of this.reads) {
      this.hits++;
      if (node.removed) continue;
      if (node.position === 1) this.promote(node);
      else this.move(node, node.position);
    }
    this.reads.length = 0;
    if (write) {
      this.sketch.increment(write.key);
      this.move(write, 0);
    }
    let candidate: Node | undefined;
    while (this.queues[0].size > this.limits[0]) {
      const node = this.first(0)!;
      candidate ??= node;
      this.move(node, 1);
    }
    if (candidate && this.cache.size > this.Capacity) {
      const victim = this.first(1)!;
      this.evict(this.sketch.frequency(candidate.key) > this.sketch.frequency(victim.key) ? victim : candidate);
    }
    while (this.cache.size > this.Capacity) {
      const [left, right] = this.queues[1].values();
      this.evict(this.sketch.frequency(left.key) > this.sketch.frequency(right.key) ? right : left);
    }
    const sampleHits = this.hits - this.previousHits;
    const sampleMisses = this.misses - this.previousMisses;
    if (sampleHits + sampleMisses >= this.sketch.sampleSize) {
      const rate = sampleHits / (sampleHits + sampleMisses);
      const delta = rate - this.previousHitRate;
      const amount = delta >= 0 ? this.stepSize : -this.stepSize;
      this.stepSize = Math.abs(delta) >= .05 ? .0625 * (amount >= 0 ? 1 : -1) : .98 * amount;
      this.previousHits = this.hits;
      this.previousMisses = this.misses;
      this.previousHitRate = rate;
      this.mainRatio = Math.max(.2, Math.min(.999, this.mainRatio - amount));
      this.limits = this.partition();
    }
    while (this.queues[2].size > this.limits[2]) this.move(this.first(2)!, 1);
  }

  private partition(): readonly number[] {
    const window = this.Capacity - Math.trunc(this.mainRatio * this.Capacity);
    const protectedSize = Math.trunc(.8 * (this.Capacity - window));
    return [window, this.Capacity - window - protectedSize, protectedSize];
  }

  private first(queue: number): Node | undefined { return this.queues[queue].values().next().value; }
  private move(node: Node, position: number): void {
    this.queues[node.position].delete(node.key);
    this.queues[position].set(node.key, node);
    node.position = position;
  }
  private promote(node: Node): void {
    this.move(node, 2);
    if (this.queues[2].size > this.limits[2]) this.move(this.first(2)!, 1);
  }
  private evict(node: Node): void {
    node.removed = true;
    this.cache.delete(node.key);
    this.queues[node.position].delete(node.key);
  }
  private check(): void { if (this.disposed) throw new Error('LFU diagnostic has been disposed.'); }

  dispose(): void {
    if (this.disposed) return;
    this.Maintain();
    this.disposed = true;
    this.cache.clear();
    this.reads.length = 0;
    this.sketch.clear();
    for (const queue of this.queues) queue.clear();
  }
}
