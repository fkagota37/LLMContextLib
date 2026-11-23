// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { AnchorResolution as AnchorResolutionModel, ContextEntry, ContextMemory, ContextSearchHit as ContextSearchHitModel, ContextRole, ConversationAnchor, Guid } from './session.js';

export interface ContextCursor {
  readonly SessionId: Guid;
  readonly Revision: number;
  readonly AfterSequence: number;
}

export interface ContextPage {
  readonly Entries: readonly ContextEntry[];
  readonly Next: ContextCursor | null;
}

export interface ILLMContextReadLease {
  readonly Session: { readonly Revision: number };
  readonly MemoryRevision: number;
  TryFindEntry(entryId: Guid): boolean;
  ReadRange(fromSequence: number, count: number): readonly ContextEntry[];
  ReadPage(cursor: ContextCursor | null, count: number): ContextPage;
  Search(query: string, limit: number): readonly ContextSearchHitModel[];
  SearchKeys(keys: readonly string[], limit: number): readonly ContextSearchHitModel[];
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
  readonly SessionRevision: number;
  readonly MemoryRevision: number;
  readonly length: number;
  at(index: number): T;
  dispose(): void;
}

export interface ILLMContextPolymorphicArray {
  TryFind(sessionId: Guid): { readonly SessionId: Guid; readonly Revision: number } | null;
  CreateSession(session: { readonly SessionId: Guid; readonly Revision: number }): { readonly Status: string; readonly Revision: number };
  RemoveSession(sessionId: Guid, expectedRevision: number): { readonly Status: string; readonly Revision: number };
  Apply(changes: { readonly SessionId: Guid; readonly ExpectedRevision: number; readonly Changes: readonly unknown[] }): { readonly Status: string; readonly Revision: number };
  ApplyMemory(changes: { readonly ExpectedRevision: number; readonly Upserts: readonly ContextMemory[]; readonly Deletes: readonly Guid[] }): { readonly Status: string; readonly Revision: number };
  OpenRead(sessionId: Guid): ILLMContextReadLease;
  OpenView<T>(definition: ILLMContextViewDefinition<T>): ILLMContextView<T>;
  GetStatistics(): { readonly Sessions: number; readonly EstimatedActiveBytes: number; readonly EstimatedRetainedBytes: number; readonly RetainedReads: number; readonly MemoryRevision: number; readonly PublishedMutations: number; readonly SegmentsRewritten: number; readonly EstimatedSegmentBytesRewritten: number };
  dispose(): void;
}

export interface LLMContextStatistics {
  readonly Sessions: number;
  readonly EstimatedActiveBytes: number;
  readonly EstimatedRetainedBytes: number;
  readonly RetainedReads: number;
  readonly MemoryRevision: number;
  readonly PublishedMutations: number;
  readonly SegmentsRewritten: number;
  readonly EstimatedSegmentBytesRewritten: number;
}
