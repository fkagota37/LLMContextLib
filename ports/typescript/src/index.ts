// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export * from './domain/session.js';
export { ContextContentRecords } from './domain/content-records.js';
export { ContextScalarRecords } from './domain/scalar-records.js';
export { ContextEntryRecords } from './domain/entry-records.js';
export { ContextCompoundRecords } from './domain/compound-records.js';
export { ContextChangeRecords } from './domain/change-records.js';
export * from './domain/index-keys.js';
export { ContextError, type ContextErrorCode } from './domain/errors.js';
export type { Int64 } from './domain/int64.js';
export type {
  ContextCursor, ContextPage, ILLMContextPolymorphicArray, ILLMContextReadLease, ILLMContextView,
  ILLMContextViewDefinition, LLMContextStatistics,
} from './domain/reads.js';
export { LLMContextFactory, LLMContextFactoryBuilder } from './factory.js';
export { WorkerContextPeer, type WorkerContextEndpoint, type WorkerContextEndpointOptions, type WorkerContextPeerOptions } from './runtime/worker-context-peer.js';
export { ContextIndexingStrategy, ContextPreparationStrategy, type ContextExecutionOptions, type ContextExecutionStatistics } from './execution/strategy.js';
export * from './options.js';
export * from './execution/collectors.js';
export * from './runtime/compatibility.js';
export * from './policies/text.js';
export * from './policies/search.js';
export * from './policies/context.js';
export * from './policies/estimation.js';
export {
  ContextSynchronizationWriteBehavior, defaultPartitionedContextIndexOptions, type ContextIndexSynchronization,
} from './storage/partitioned-index.js';
export * from './views.js';
