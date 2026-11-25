// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { sealPayload } from './payload-identity.js';

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
      if (typeof key !== 'string') {
        throw new TypeError('Index keys must be strings.');
      }
      unique.add(key);
    }
    this.Keys = [...unique].sort();
    sealPayload(this.Keys);
    Object.freeze(this);
  }
}

export enum ContextIndexingMode {
  Text = 'Text',
  ProducerOwned = 'ProducerOwned',
}
