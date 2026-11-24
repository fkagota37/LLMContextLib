// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextIndexingMode } from './domain/index-keys.js';
import { isPositiveInt64, type Int64 } from './domain/int64.js';
import { SummaryContent, TextContent, ToolCallContent, ToolResultContent, type ContextEntry } from './domain/session.js';
import { EstimateEntryBytes } from './policies/context.js';
import {
  type ContextExecutionOptions,
  defaultContextExecutionOptions,
  validateContextExecutionOptions,
} from './execution/strategy.js';
import {
  ContextSynchronizationWriteBehavior,
  defaultPartitionedContextIndexOptions,
  freezePartitionedContextIndexOptions,
  partitionInfrastructureBytes,
  partitionRecoveryBytes,
  validatePartitionedContextIndexOptions,
  type PartitionedContextIndexOptions,
} from './storage/partitioned-index.js';

export interface DeferredIndexingOptions {
  readonly ForegroundWords: number;
  readonly ForegroundCharacters: number;
  readonly MaximumPendingEntries: number;
  readonly MaximumEstimatedWorkBytes: Int64;
}

export const defaultDeferredIndexingOptions: DeferredIndexingOptions = Object.freeze({
  ForegroundWords: 128,
  ForegroundCharacters: 8192,
  MaximumPendingEntries: 64,
  MaximumEstimatedWorkBytes: 8 * 1024 * 1024,
});

export type { PartitionedContextIndexOptions };

/**
 * Runtime configuration for the port. The ordinary defaults remain separate from any explicit
 * WriteOptimized preset.
 */
export interface TimeProviderLike {
  readonly now: () => number | string;
}

export interface LLMContextOptions {
  readonly IndexingMode: ContextIndexingMode;
  readonly SerializeSessionPreparation: boolean;
  readonly DeferredIndexing: DeferredIndexingOptions | null;
  readonly PartitionedIndex: PartitionedContextIndexOptions | null;
  readonly MaximumEntriesPerSegment: number;
  readonly MaximumEstimatedBytesPerSegment: Int64;
  readonly EstimatedResidentByteBudget: Int64;
  readonly MaximumEstimatedRetainedBytes: Int64;
  readonly MaximumRetainedReads: number;
  readonly MaximumViewResults: number;
  readonly AdmissionTimeoutMs: number;
  readonly TimeProvider: TimeProviderLike;
  readonly EntrySizeEstimator: (entry: ContextEntry) => Int64;
  readonly ProjectionSizeEstimator: (item: unknown) => Int64;
  readonly Execution: ContextExecutionOptions;
}

export const defaultLLMContextOptions: LLMContextOptions = Object.freeze({
  IndexingMode: ContextIndexingMode.Text,
  SerializeSessionPreparation: false,
  DeferredIndexing: null,
  PartitionedIndex: null,
  MaximumEntriesPerSegment: 128,
  MaximumEstimatedBytesPerSegment: 256 * 1024,
  EstimatedResidentByteBudget: 64 * 1024 * 1024,
  MaximumEstimatedRetainedBytes: 64 * 1024 * 1024,
  MaximumRetainedReads: 128,
  MaximumViewResults: 4096,
  AdmissionTimeoutMs: 0,
  TimeProvider: Object.freeze({ now: () => Date.now() }),
  EntrySizeEstimator: EstimateEntryBytes,
  ProjectionSizeEstimator: (item: unknown) => {
    if (typeof item === 'string') return 32 + 2 * item.length;
    if (typeof item === 'object' && item !== null) {
      if ('EntryId' in item && 'Sequence' in item && 'CreatedAt' in item && 'Content' in item) {
        const content = item.Content;
        if (content instanceof TextContent || content instanceof SummaryContent ||
          content instanceof ToolCallContent || content instanceof ToolResultContent) {
          return EstimateEntryBytes(item as ContextEntry);
        }
      }
      if ('MemoryId' in item && 'Scope' in item && 'Content' in item && typeof item.Content === 'string') {
        return 128 + 2 * item.Content.length;
      }
      if ('EntryId' in item && 'SessionRevision' in item && 'Snippet' in item && typeof item.Snippet === 'string') {
        return 96 + 2 * item.Snippet.length;
      }
      if ('EntryId' in item && 'MemoryId' in item && 'Text' in item && typeof item.Text === 'string') {
        return 96 + 2 * item.Text.length;
      }
    }
    return 128;
  },
  Execution: defaultContextExecutionOptions,
});

export const WriteOptimized: LLMContextOptions = Object.freeze({
  ...defaultLLMContextOptions,
  IndexingMode: ContextIndexingMode.ProducerOwned,
  MaximumEntriesPerSegment: 8,
  MaximumEstimatedBytesPerSegment: 32 * 1024,
  EstimatedResidentByteBudget: 512 * 1024 * 1024,
  MaximumEstimatedRetainedBytes: 256 * 1024 * 1024,
  MaximumRetainedReads: 2048,
  MaximumViewResults: 4096,
  AdmissionTimeoutMs: 5,
  PartitionedIndex: freezePartitionedContextIndexOptions({
    ...defaultPartitionedContextIndexOptions,
    MaximumEstimatedPartitionBytes: 8 * 1024 * 1024,
    MaximumWorkingSetEntries: 64,
    MaximumEstimatedWorkingSetBytes: 4 * 1024 * 1024,
    MaximumPendingSynchronizations: 32,
    MaximumEstimatedPreparationBytes: 8 * 1024 * 1024,
    WriteBehavior: ContextSynchronizationWriteBehavior.Reject,
    SynchronizationWaitTimeoutMs: 1000,
  }),
});

export const LLMContextOptions = Object.freeze({
  Default: defaultLLMContextOptions,
  WriteOptimized,
});

const maxInt32 = 0x7fff_ffff;
const positiveInt32 = (value: number) => Number.isInteger(value) && value > 0 && value <= maxInt32;
export const deferredInfrastructureBytes = (capacity: number) => 1024 + 128 * capacity;

export function validateLLMContextOptions(options: LLMContextOptions): void {
  if (![options.MaximumEntriesPerSegment, options.MaximumRetainedReads, options.MaximumViewResults].every(positiveInt32) ||
      ![options.MaximumEstimatedBytesPerSegment, options.EstimatedResidentByteBudget, options.MaximumEstimatedRetainedBytes].every(isPositiveInt64)) {
    throw new RangeError('All LLMContextOptions resource limits must be positive.');
  }
  if (!Number.isFinite(options.AdmissionTimeoutMs) || options.AdmissionTimeoutMs < 0 || options.AdmissionTimeoutMs > maxInt32) {
    throw new RangeError('AdmissionTimeoutMs must be between zero and Int32.MaxValue.');
  }
  if (typeof options.ProjectionSizeEstimator !== 'function' || typeof options.EntrySizeEstimator !== 'function') {
    throw new TypeError('EntrySizeEstimator and ProjectionSizeEstimator must be functions.');
  }
  if (!options.TimeProvider || typeof options.TimeProvider.now !== 'function') {
    throw new TypeError('TimeProvider must provide a now() function.');
  }
  if (options.IndexingMode !== ContextIndexingMode.Text && options.IndexingMode !== ContextIndexingMode.ProducerOwned) {
    throw new RangeError('Unknown indexing mode.');
  }
  if (options.PartitionedIndex) {
    validatePartitionedContextIndexOptions(options.PartitionedIndex);
    if (options.IndexingMode !== ContextIndexingMode.ProducerOwned) {
      throw new TypeError('Partitioned working sets require producer-owned indexing without deferred text work.');
    }
    if (options.DeferredIndexing !== null && options.DeferredIndexing !== undefined) {
      throw new TypeError('Partitioned working sets require producer-owned indexing without deferred text work.');
    }
    if (BigInt(partitionInfrastructureBytes(options.PartitionedIndex)) + BigInt(partitionRecoveryBytes(options.PartitionedIndex)) >= options.EstimatedResidentByteBudget) {
      throw new RangeError('Recovery headroom exceeds the resident budget.');
    }
  }
  if (options.IndexingMode === ContextIndexingMode.ProducerOwned && options.DeferredIndexing !== null && options.DeferredIndexing !== undefined) {
    throw new TypeError('Producer-owned indexes and deferred text indexing are incompatible.');
  }
  const deferred = options.DeferredIndexing;
  if (deferred) {
    if (![deferred.ForegroundWords, deferred.ForegroundCharacters, deferred.MaximumPendingEntries].every(positiveInt32) ||
        !isPositiveInt64(deferred.MaximumEstimatedWorkBytes)) {
      throw new RangeError('Deferred indexing limits must be positive integers.');
    }
    if (deferredInfrastructureBytes(deferred.MaximumPendingEntries) > options.EstimatedResidentByteBudget) {
      throw new RangeError('Index worker infrastructure exceeds the resident budget.');
    }
  }
  if (options.Execution.Indexing === 'AppendOptimized' && options.DeferredIndexing === null) {
    throw new TypeError('AppendOptimized requires DeferredIndexing limits.');
  }
  validateContextExecutionOptions(options.Execution);
}
