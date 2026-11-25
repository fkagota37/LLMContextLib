// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextMutationResult, ContextMutationStatus, MemoryStatus, type ContextMemory, type MemorySource, type MemoryChangeSet, type Guid } from '../domain/session.js';
import { ValidateScope } from '../policies/context.js';
import { advanceInt64, checkedInt64, compareInt64, isInt64, type Int64 } from '../domain/int64.js';
import { timestampTicks } from '../domain/date-time-offset.js';
import { canonicalGuid } from '../domain/guid.js';

export interface PreparedMemoryChange {
  readonly PreviousRevision: Int64;
  readonly Delta: bigint;
  publish(): ContextMutationResult;
}

export class MemoryStore {
  private memory = new Map<Guid, ContextMemory>();
  private records: readonly ContextMemory[] = [];
  private revision: Int64 = 0;
  private bytes = 0n;

  public get Revision(): Int64 { return this.revision; }
  public get EstimatedBytes(): bigint { return this.bytes; }

  public clear(): void {
    this.memory = new Map();
    this.records = [];
    this.revision = 0;
    this.bytes = 0n;
  }

  public tryGet(memoryId: Guid): ContextMemory | undefined {
    return this.memory.get(canonicalGuid(memoryId));
  }

  public values(): readonly ContextMemory[] {
    return this.records;
  }

  public prepare(
    changes: MemoryChangeSet,
    validateProvenance: (memory: ContextMemory) => void,
  ): ContextMutationResult | PreparedMemoryChange {
    const previousRevision = this.revision;
    const result = (status: ContextMutationStatus, error?: string) =>
      new ContextMutationResult(status, previousRevision, error);
    if (!isInt64(changes.ExpectedRevision) || compareInt64(changes.ExpectedRevision, this.revision) !== 0) {
      return result(ContextMutationStatus.RevisionConflict);
    }

    let revision: Int64;
    const next = new Map(this.memory);
    let bytes = this.bytes;
    try {
      revision = advanceInt64(this.revision);
      if (!Array.isArray(changes.Upserts) || !Array.isArray(changes.Deletes) ||
          changes.Upserts.length + changes.Deletes.length === 0) {
        throw new RangeError('Invalid memory change.');
      }
      const seen = new Set<Guid>();
      for (const supplied of changes.Deletes) {
        const id = canonicalGuid(supplied);
        const old = next.get(id);
        if (!old) throw new TypeError('Unknown/duplicate memory.');
        next.delete(id);
        bytes = checkedInt64(bytes - memoryBytes(old));
        seen.add(id);
      }
      for (const item of changes.Upserts) {
        ValidateScope(item.Scope);
        const id = canonicalGuid(item.MemoryId);
        if (typeof id !== 'string' || !id || id === '00000000-0000-0000-0000-000000000000' ||
            seen.has(id) || typeof item.Content !== 'string' || !item.Content.trim() ||
            !Object.values(MemoryStatus).includes(item.Status) || !isInt64(item.Revision) || item.Revision < 0 ||
            !Array.isArray(item.Sources) || (item.Status === MemoryStatus.Confirmed && !item.Sources.length)) {
          throw new TypeError('Memory needs valid identity, content, status and provenance.');
        }
        if (item.ExpiresAt !== null) {
          if (typeof item.ExpiresAt !== 'string') throw new TypeError('Memory expiry must be a timestamp or null.');
          timestampTicks(item.ExpiresAt);
        }
        validateProvenance(item);
        seen.add(id);
        const old = next.get(id);
        if (old) bytes = checkedInt64(bytes - memoryBytes(old));
        bytes = checkedInt64(bytes + memoryBytes(item));
        const scope = item.Scope;
        next.set(id, Object.freeze({
          ...item,
          MemoryId: id,
          Scope: Object.freeze({ ...scope,
            ...(scope.UserId == null ? {} : { UserId: canonicalGuid(scope.UserId) }),
            ...(scope.RepositoryId == null ? {} : { RepositoryId: canonicalGuid(scope.RepositoryId) }),
            ...(scope.SessionId == null ? {} : { SessionId: canonicalGuid(scope.SessionId) }),
          }),
          Sources: Object.freeze(item.Sources.map((source: MemorySource) => Object.freeze({
            SessionId: canonicalGuid(source.SessionId), AnchorId: canonicalGuid(source.AnchorId),
          }))),
          Revision: revision,
        }));
      }
    } catch (error) {
      return result(ContextMutationStatus.InvalidOperation, (error as Error).message);
    }

    return {
      PreviousRevision: previousRevision,
      Delta: bytes - this.bytes,
      publish: () => {
        this.records = Object.freeze([...next.values()]);
        this.memory = next;
        this.bytes = bytes;
        this.revision = revision;
        return new ContextMutationResult(ContextMutationStatus.Applied, revision);
      },
    };
  }

}

const memoryBytes = (memory: ContextMemory) =>
  256n + 2n * BigInt(memory.Content.length) + 48n * BigInt(memory.Sources.length);
