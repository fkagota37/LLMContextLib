// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

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

export interface ContextExecutionStatistics {
  readonly IndexedEntries: number;
  readonly PreparedSessions: number;
  readonly DeferredCharacters: number;
}

export const defaultContextExecutionOptions: ContextExecutionOptions = {
  Indexing: ContextIndexingStrategy.Configured,
  Preparation: ContextPreparationStrategy.Speculative,
  MinimumDeferredCharacters: 4096,
};
