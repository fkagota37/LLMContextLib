// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: ReadonlyMap<K, V>;
  readonly #normalize: (key: K) => K;
  constructor(map: ReadonlyMap<K, V>, normalize = (key: K) => key) {
    this.#map = map;
    this.#normalize = normalize;
    Object.freeze(this);
  }
  get size() { return this.#map.size; }
  get(key: K) { return this.#map.get(this.#normalize(key)); }
  has(key: K) { return this.#map.has(this.#normalize(key)); }
  entries() { return this.#map.entries(); }
  keys() { return this.#map.keys(); }
  values() { return this.#map.values(); }
  [Symbol.iterator]() { return this.entries(); }
  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#map) callback.call(thisArg, value, key, this);
  }
}
