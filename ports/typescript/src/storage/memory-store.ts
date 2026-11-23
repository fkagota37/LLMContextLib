// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextMutationStatus, type ContextMemory, type MemoryChangeSet, type Guid } from '../domain/session.js';

export class MemoryStore {
  private readonly memory = new Map<Guid, ContextMemory>();

  public tryGet(memoryId: Guid): ContextMemory | undefined {
    return this.memory.get(memoryId);
  }

  public apply(changes: MemoryChangeSet): { readonly Status: ContextMutationStatus; readonly Revision: number; readonly Error?: string | null } {
    for (const item of changes.Deletes) {
      if (!this.memory.has(item)) {
        return { Status: ContextMutationStatus.NotFound, Revision: changes.ExpectedRevision, Error: 'Memory item not found.' };
      }
    }
    for (const item of changes.Upserts) {
      this.memory.set(item.MemoryId, item);
    }
    for (const item of changes.Deletes) {
      this.memory.delete(item);
    }
    return { Status: ContextMutationStatus.Applied, Revision: changes.ExpectedRevision + 1 };
  }
}
