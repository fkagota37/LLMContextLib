// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { AnchorResolution as AnchorResolutionModel, ContextChangeSet, ContextEntry, ContextMemory, ContextSearchHit as ContextSearchHitModel, Guid, IContextMutationResult, LLMSessionContext, MemoryChangeSet } from './session.js';
import type { ContextIndexKeys } from './index-keys.js';
import type { Int64 } from './int64.js';

export interface ContextCursor {
  readonly SessionId: Guid;
  readonly Revision: Int64;
  readonly AfterSequence: Int64;
}

export interface ContextPage {
  readonly Entries: readonly ContextEntry[];
  readonly Next: ContextCursor | null;
}

export interface ILLMContextReadLease {
  readonly IndexingMode: import('./index-keys.js').ContextIndexingMode;
  readonly Session: LLMSessionContext;
  readonly MemoryRevision: Int64;
  readonly IndexStatus: import('./session.js').ContextIndexStatus;
  TryFindEntry(entryId: Guid): ContextEntry | null;
  ReadRange(fromSequence: Int64, count: number): readonly ContextEntry[];
  ReadPage(cursor: ContextCursor | null, count: number): ContextPage;
  Search(query: string, limit: number): readonly ContextSearchHitModel[];
  SearchKeys(keys: ContextIndexKeys | readonly string[], limit: number): readonly ContextSearchHitModel[];
  SearchIndexed(query: string, limit: number): import('./session.js').ContextIndexedSearchResult;
  ResolveAnchor(anchorId: Guid): AnchorResolutionModel;
  GetApplicableMemory(scopes: readonly { readonly UserId?: Guid | null; readonly RepositoryId?: Guid | null; readonly SessionId?: Guid | null }[]): readonly ContextMemory[];
  dispose(): void;
}

export interface ILLMContextViewDefinition<T> {
  readonly SessionId: Guid;
  readonly MaximumResults: number;
  Evaluate(context: ILLMContextReadLease): Iterable<T>;
}

export interface ILLMContextView<T> extends Iterable<T> {
  readonly SessionRevision: Int64;
  readonly MemoryRevision: Int64;
  readonly length: number;
  at(index: number): T;
  dispose(): void;
}

export interface ILLMContextPolymorphicArray {
  TryFind(sessionId: Guid): LLMSessionContext | null;
  CreateSession(session: LLMSessionContext): IContextMutationResult;
  RemoveSession(sessionId: Guid, expectedRevision: Int64): IContextMutationResult;
  Apply(changes: ContextChangeSet): IContextMutationResult;
  ApplyMemory(changes: MemoryChangeSet): IContextMutationResult;
  OpenRead(sessionId: Guid): ILLMContextReadLease;
  WithCurrent<T>(sessionId: Guid, consume: (read: ILLMContextReadLease) => T): T;
  OpenView<T>(definition: ILLMContextViewDefinition<T>): ILLMContextView<T>;
  WaitForIndexingAsync(sessionId: Guid, expectedRevision: Int64, signal?: AbortSignal): Promise<void>;
  SynchronizeIndexAsync(sessionId: Guid, signal?: AbortSignal): Promise<import('../storage/partitioned-index.js').ContextIndexSynchronization>;
  GetStatistics(): LLMContextStatistics;
  dispose(): void;
}

export interface LLMContextStatistics {
  readonly Sessions: number;
  readonly EstimatedActiveBytes: Int64;
  readonly EstimatedRetainedBytes: Int64;
  readonly RetainedReads: number;
  readonly MemoryRevision: Int64;
  readonly PublishedMutations: Int64;
  readonly SegmentsRewritten: Int64;
  readonly EstimatedSegmentBytesRewritten: Int64;
  readonly EstimatedViewBytes: Int64;
  readonly PendingIndexWork: number;
  readonly EstimatedIndexWorkBytes: Int64;
  readonly CompletedIndexJobs: Int64;
  readonly DiscardedIndexJobs: Int64;
  readonly EstimatedSynchronizationReserveBytes: Int64;
  readonly EstimatedPreparationBytes: Int64;
  readonly PendingSynchronizations: number;
  readonly Execution: import('../execution/strategy.js').ContextExecutionStatistics | null;
}
