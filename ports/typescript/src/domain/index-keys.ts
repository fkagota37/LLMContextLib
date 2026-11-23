// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

/**
 * Producer-owned index keys are exact opaque labels, not inferred text tokens. The port keeps
 * their sorting and deduplication deterministic and leaves all application semantics to the host.
 */
export class ContextIndexKeys {
  public static readonly Empty = new ContextIndexKeys([]);

  public readonly Keys: readonly string[];

  constructor(keys: Iterable<string>) {
    const unique = new Set<string>();
    for (const key of keys) {
      if (key === null || key === undefined) {
        throw new TypeError('Index keys cannot be null or undefined.');
      }
      unique.add(key);
    }
    this.Keys = [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

export enum ContextIndexingMode {
  Text = 'Text',
  ProducerOwned = 'ProducerOwned',
}
