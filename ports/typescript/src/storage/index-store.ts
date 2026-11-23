// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextIndexingMode, type ContextIndexKeys } from '../domain/index-keys.js';
import { type Guid } from '../domain/session.js';

export class IndexStore {
  private readonly entries = new Map<Guid, readonly string[]>();
  private readonly anchors = new Map<Guid, readonly string[]>();

  public clear(): void {
    this.entries.clear();
    this.anchors.clear();
  }

  public setEntry(entryId: Guid, keys: ContextIndexKeys, mode: ContextIndexingMode): void {
    if (mode === ContextIndexingMode.ProducerOwned) {
      this.entries.set(entryId, [...keys.Keys]);
      return;
    }
    this.entries.set(entryId, []);
  }

  public setAnchor(anchorId: Guid, keys: ContextIndexKeys, mode: ContextIndexingMode): void {
    if (mode === ContextIndexingMode.ProducerOwned) {
      this.anchors.set(anchorId, [...keys.Keys]);
      return;
    }
    this.anchors.set(anchorId, []);
  }

  public removeEntry(entryId: Guid): void {
    this.entries.delete(entryId);
  }

  public removeAnchor(anchorId: Guid): void {
    this.anchors.delete(anchorId);
  }

  public searchKeys(keys: readonly string[]): readonly Guid[] {
    const matches: Guid[] = [];
    const keySet = new Set(keys);
    for (const [entryId, entryKeys] of this.entries.entries()) {
      if (entryKeys.some((value) => keySet.has(value))) {
        matches.push(entryId);
      }
    }
    return matches;
  }

  public getEntryKeys(entryId: Guid): readonly string[] {
    return this.entries.get(entryId) ?? [];
  }

  public getAnchorKeys(anchorId: Guid): readonly string[] {
    return this.anchors.get(anchorId) ?? [];
  }
}
