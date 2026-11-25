// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { Guid, LLMSessionContext, ContextChangeSet, MemoryChangeSet, IContextMutationResult } from '../domain/session.js';
import type { Int64 } from '../domain/int64.js';
import type { ILLMContextReadLease, ILLMContextViewDefinition, ILLMContextView, LLMContextStatistics } from '../domain/reads.js';

export interface ILLMContextStorage {
  TryFind(sessionId: Guid): LLMSessionContext | null;
  Create(session: LLMSessionContext): IContextMutationResult;
  Remove(sessionId: Guid, expectedRevision: Int64): IContextMutationResult;
  Apply(changes: ContextChangeSet): IContextMutationResult;
  ApplyMemory(changes: MemoryChangeSet): IContextMutationResult;
  OpenRead(sessionId: Guid): ILLMContextReadLease;
  OpenView<T>(definition: ILLMContextViewDefinition<T>): ILLMContextView<T>;
  GetStatistics(): LLMContextStatistics;
  dispose(): void;
}
