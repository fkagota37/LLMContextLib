// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextIndexingMode } from './domain/index-keys.js';

export enum ContextIndexingStrategy {
  Configured = 'Configured',
  Synchronous = 'Synchronous',
  AppendOptimized = 'AppendOptimized',
}

export enum ContextPreparationStrategy {
  Configured = 'Configured',
  Speculative = 'Speculative',
  Serialized = 'Serialized',
}

export interface ContextExecutionOptions {
  readonly Indexing: ContextIndexingStrategy;
  readonly Preparation: ContextPreparationStrategy;
  readonly MinimumDeferredCharacters: number;
}

export interface DeferredIndexingOptions {
  readonly MaximumPendingEntries: number;
  readonly MaximumPendingCharacters: number;
}

export interface PartitionedContextIndexOptions {
  readonly InfrastructureBytes: number;
  readonly RecoveryBytes: number;
}

/**
 * Runtime configuration for the port. The ordinary defaults remain separate from any explicit
 * WriteOptimized preset. This bootstrap slice preserves the default semantics while leaving the
 * deeper production tuning to the later parity implementation.
 */
export interface LLMContextOptions {
  readonly IndexingMode: ContextIndexingMode;
  readonly SerializeSessionPreparation: boolean;
  readonly DeferredIndexing: DeferredIndexingOptions | null;
  readonly PartitionedIndex: PartitionedContextIndexOptions | null;
  readonly EstimatedResidentByteBudget: number;
  readonly MaximumViewResults: number;
  readonly ProjectionSizeEstimator: (item: unknown) => number;
}

export const defaultLLMContextOptions: LLMContextOptions = {
  IndexingMode: ContextIndexingMode.Text,
  SerializeSessionPreparation: false,
  DeferredIndexing: null,
  PartitionedIndex: null,
  EstimatedResidentByteBudget: 1024 * 1024,
  MaximumViewResults: 64,
  ProjectionSizeEstimator: () => 1,
};

export function validateLLMContextOptions(options: LLMContextOptions): void {
  // Ordering and resource limits are part of the public contract; invalid configuration must fail
  // before any owner is constructed, rather than silently degrading behavior.
  if (options.MaximumViewResults < 0) {
    throw new RangeError('MaximumViewResults must be non-negative.');
  }
  if (options.EstimatedResidentByteBudget <= 0) {
    throw new RangeError('EstimatedResidentByteBudget must be positive.');
  }
  if (options.ProjectionSizeEstimator === undefined) {
    throw new TypeError('ProjectionSizeEstimator must be defined.');
  }
}
