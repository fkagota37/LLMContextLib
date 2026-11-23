// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { Guid, LLMSessionContext, ContextMemory, ContextChangeSet, MemoryChangeSet, IContextMutationResult } from '../domain/session.js';
import type { ILLMContextReadLease, ILLMContextViewDefinition, ILLMContextView } from '../domain/reads.js';

export interface ILLMContextStorage {
  TryFind(sessionId: Guid): LLMSessionContext | null;
  Create(session: LLMSessionContext): IContextMutationResult;
  Remove(sessionId: Guid, expectedRevision: number): IContextMutationResult;
  Apply(changes: ContextChangeSet): IContextMutationResult;
  ApplyMemory(changes: MemoryChangeSet): IContextMutationResult;
  OpenRead(sessionId: Guid): ILLMContextReadLease;
  OpenView<T>(definition: ILLMContextViewDefinition<T>): ILLMContextView<T>;
  GetStatistics(): { readonly Sessions: number; readonly EstimatedActiveBytes: number; readonly EstimatedRetainedBytes: number; readonly RetainedReads: number; readonly MemoryRevision: number; readonly PublishedMutations: number; readonly SegmentsRewritten: number; readonly EstimatedSegmentBytesRewritten: number };
  dispose(): void;
}
