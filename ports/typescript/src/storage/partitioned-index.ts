// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { Guid } from '../domain/session.js';
import { canonicalInt64, checkedInt64, isPositiveInt64, type Int64 } from '../domain/int64.js';

export enum ContextSynchronizationWriteBehavior {
  Reject = 'Reject',
  Wait = 'Wait',
}

export interface PartitionedContextIndexOptions {
  readonly MaximumEstimatedPartitionBytes: Int64;
  readonly MaximumWorkingSetEntries: number;
  readonly MaximumEstimatedWorkingSetBytes: Int64;
  readonly MaximumPendingSynchronizations: number;
  readonly MaximumEstimatedPreparationBytes: Int64;
  readonly WriteBehavior: ContextSynchronizationWriteBehavior;
  readonly SynchronizationWaitTimeoutMs: number;
  readonly InfrastructureBytes: number;
  readonly RecoveryBytes: Int64;
}

export function freezePartitionedContextIndexOptions(options: Omit<PartitionedContextIndexOptions, 'InfrastructureBytes' | 'RecoveryBytes'>): PartitionedContextIndexOptions {
  const snapshot: PartitionedContextIndexOptions = {
    ...options,
    get InfrastructureBytes() { return partitionInfrastructureBytes(this); },
    get RecoveryBytes() { return partitionRecoveryBytes(this); },
  };
  return Object.freeze(snapshot);
}

export const defaultPartitionedContextIndexOptions = freezePartitionedContextIndexOptions({
  MaximumEstimatedPartitionBytes: 2 * 1024 * 1024,
  MaximumWorkingSetEntries: 64,
  MaximumEstimatedWorkingSetBytes: 512 * 1024,
  MaximumPendingSynchronizations: 32,
  MaximumEstimatedPreparationBytes: 8 * 1024 * 1024,
  WriteBehavior: ContextSynchronizationWriteBehavior.Reject,
  SynchronizationWaitTimeoutMs: 1000,
});

export const partitionInfrastructureBytes = (options: PartitionedContextIndexOptions) =>
  4096 + 512 * options.MaximumPendingSynchronizations;
export const partitionRecoveryBytes = (options: PartitionedContextIndexOptions) =>
  canonicalInt64(checkedInt64(2n * BigInt(options.MaximumEstimatedPartitionBytes)));

export function validatePartitionedContextIndexOptions(options: PartitionedContextIndexOptions): void {
  if (![options.MaximumEstimatedPartitionBytes, options.MaximumEstimatedWorkingSetBytes, options.MaximumEstimatedPreparationBytes]
      .every(isPositiveInt64) ||
      [options.MaximumWorkingSetEntries, options.MaximumPendingSynchronizations]
        .some((value) => !Number.isInteger(value) || value <= 0 || value > 0x7fff_ffff)) {
    throw new RangeError('PartitionedContextIndexOptions limits must be positive.');
  }
  if (!Object.values(ContextSynchronizationWriteBehavior).includes(options.WriteBehavior)) {
    throw new RangeError('PartitionedContextIndexOptions.WriteBehavior is invalid.');
  }
  if (options.SynchronizationWaitTimeoutMs < 0 || options.SynchronizationWaitTimeoutMs > 2147483647 ||
      !Number.isFinite(options.SynchronizationWaitTimeoutMs)) {
    throw new RangeError('SynchronizationWaitTimeoutMs must be non-negative and finite.');
  }
  checkedInt64(BigInt(partitionInfrastructureBytes(options)) + BigInt(partitionRecoveryBytes(options)));
}

export interface ContextIndexSynchronization {
  readonly SessionId: Guid;
  readonly Generation: Int64;
  readonly ContentRevision: Int64;
  readonly PartitionsCompacted: number;
  readonly Succeeded: boolean;
  readonly Error: string | null;
}

export class PartitionCapacityException extends Error {
  public readonly CanSynchronize: boolean;
  public readonly SegmentId: Int64 | null;

  constructor(canSynchronize: boolean, message: string, segmentId: Int64 | null = null) {
    super(message);
    this.name = 'PartitionCapacityException';
    this.CanSynchronize = canSynchronize;
    this.SegmentId = segmentId;
  }
}

export interface PartitionContribution {
  readonly Terms: readonly string[];
  readonly Bytes: number;
  readonly IndexBytes: number;
}

export class ContextIndexPartition {
  public static readonly Empty = new ContextIndexPartition(new Map(), new Map(), new Map(), 256, 0);

  constructor(
    public readonly Contributions: ReadonlyMap<Guid, PartitionContribution>,
    public readonly Search: ReadonlyMap<string, readonly Guid[]>,
    public readonly Overrides: ReadonlyMap<Guid, PartitionContribution | null>,
    public readonly BaseBytes: number,
    public readonly WorkingSetBytes: number,
  ) {}

  public get EstimatedBytes(): number {
    return this.BaseBytes + this.WorkingSetBytes;
  }

  public Override(id: Guid, value: PartitionContribution | null, options: PartitionedContextIndexOptions): ContextIndexPartition {
    const oldBytes = this.Overrides.has(id) ? ContextIndexPartition.OverrideBytes(this.Overrides.get(id) ?? null) : 0;
    const nextBytes = this.WorkingSetBytes - oldBytes + ContextIndexPartition.OverrideBytes(value);
    const count = this.Overrides.size + (this.Overrides.has(id) ? 0 : 1);
    if (value === null && !this.Contributions.has(id)) {
      const overrides = new Map(this.Overrides);
      overrides.delete(id);
      return new ContextIndexPartition(this.Contributions, this.Search, overrides, this.BaseBytes, Math.max(0, this.WorkingSetBytes - oldBytes));
    }
    if (count > options.MaximumWorkingSetEntries || nextBytes > options.MaximumEstimatedWorkingSetBytes || this.BaseBytes + nextBytes > options.MaximumEstimatedPartitionBytes) {
      throw new PartitionCapacityException(this.Overrides.size > 0, 'Partition working set is full; synchronize before retrying, or reduce the atomic contribution.');
    }
    const overrides = new Map(this.Overrides);
    overrides.set(id, value);
    return new ContextIndexPartition(this.Contributions, this.Search, overrides, this.BaseBytes, nextBytes);
  }

  public Compact(): ContextIndexPartition {
    return ContextIndexPartition.Compact(this.Contributions, this.Overrides);
  }

  public static Compact(base: ReadonlyMap<Guid, PartitionContribution>, overrides: ReadonlyMap<Guid, PartitionContribution | null>,
    checkCancellation?: () => void): ContextIndexPartition {
    const contributions = new Map(base);
    for (const [id, value] of overrides) {
      checkCancellation?.();
      if (value === null) {
        contributions.delete(id);
      } else {
        contributions.set(id, value);
      }
    }
    return ContextIndexPartition.Build(contributions, checkCancellation);
  }

  public static Build(contributions: ReadonlyMap<Guid, PartitionContribution>, checkCancellation?: () => void): ContextIndexPartition {
    const search = new Map<string, Set<Guid>>();
    let bytes = 256;
    for (const [id, value] of contributions.entries()) {
      checkCancellation?.();
      bytes += value.IndexBytes;
      for (const term of value.Terms) {
        const postings = search.get(term) ?? new Set<Guid>();
        postings.add(id);
        search.set(term, postings);
      }
    }
    return new ContextIndexPartition(
      contributions,
      new Map([...search.entries()].map(([term, ids]) => [term, [...ids].sort()])),
      new Map(),
      bytes,
      0,
    );
  }

  public static OverrideBytes(contribution: PartitionContribution | null): number {
    return 128 + (contribution?.IndexBytes ?? 0);
  }
}

export class PartitionedContextIndex {
  private readonly partitions = new Map<Guid, ContextIndexPartition>();

  public constructor(private readonly options: PartitionedContextIndexOptions) {
    validatePartitionedContextIndexOptions(options);
  }

  public get(sessionId: Guid): ContextIndexPartition {
    return this.partitions.get(sessionId) ?? ContextIndexPartition.Empty;
  }

  public set(sessionId: Guid, partition: ContextIndexPartition): void {
    this.partitions.set(sessionId, partition);
  }

  public override(sessionId: Guid, id: Guid, terms: readonly string[], bytes: number, options: PartitionedContextIndexOptions = this.options): ContextIndexPartition {
    const next = this.get(sessionId).Override(id, {
      Terms: [...new Set(terms)].sort(),
      Bytes: Math.max(0, Math.trunc(bytes)),
      IndexBytes: 128 + 6 * Math.max(0, Math.trunc(bytes)),
    }, options);
    this.partitions.set(sessionId, next);
    return next;
  }

  public compact(sessionId: Guid): ContextIndexPartition {
    const compacted = this.get(sessionId).Compact();
    this.partitions.set(sessionId, compacted);
    return compacted;
  }

}
