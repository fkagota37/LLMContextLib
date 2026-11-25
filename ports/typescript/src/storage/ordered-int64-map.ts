// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { canonicalInt64, type Int64 } from '../domain/int64.js';
import { PersistentStringTree } from './persistent-string-tree.js';

export function nonnegativeInt64Key(value: Int64): string {
  return String(canonicalInt64(value)).padStart(19, '0');
}

export class OrderedInt64Map<T> implements ReadonlyMap<Int64, T> {
  constructor(private readonly tree = new PersistentStringTree<readonly [Int64, T]>()) {
    Object.freeze(this);
  }

  get size(): number { return this.tree.size; }
  get weight(): bigint { return this.tree.weight; }
  get(key: Int64): T | undefined { return this.tree.get(nonnegativeInt64Key(key))?.[1]; }
  has(key: Int64): boolean { return this.tree.has(nonnegativeInt64Key(key)); }

  add(key: Int64, value: T, weight: bigint): OrderedInt64Map<T> {
    return new OrderedInt64Map(this.tree.set(nonnegativeInt64Key(key), [canonicalInt64(key), value], weight));
  }

  remove(key: Int64): OrderedInt64Map<T> {
    const tree = this.tree.delete(nonnegativeInt64Key(key));
    return tree === this.tree ? this : new OrderedInt64Map(tree);
  }

  *entries(): Generator<[Int64, T], undefined> {
    for (const [key, value] of this.tree.from('')) yield [key, value] as [Int64, T];
    return undefined;
  }

  *keys(): Generator<Int64, undefined> {
    for (const [key] of this.tree.from('')) yield key;
    return undefined;
  }

  *values(): Generator<T, undefined> {
    for (const [, value] of this.tree.from('')) yield value;
    return undefined;
  }

  [Symbol.iterator]() { return this.entries(); }

  forEach(callback: (value: T, key: Int64, map: ReadonlyMap<Int64, T>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.tree.from('')) callback.call(thisArg, value, key, this);
  }
}
