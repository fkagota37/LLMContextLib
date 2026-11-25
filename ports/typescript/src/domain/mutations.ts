// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { ContextContent, ContextRole, Guid, SessionStatus, ContextEntry, ConversationAnchor, ContextMemory } from './session.js';

export interface ContextEntryDraft {
  readonly EntryId: Guid;
  readonly Role: ContextRole;
  readonly CreatedAt: string;
  readonly Content: ContextContent;
  readonly IndexKeys?: readonly string[];
}

export type ContextChange =
  | { readonly kind: 'AppendEntries'; readonly Entries: readonly ContextEntryDraft[] }
  | { readonly kind: 'ReplaceEntry'; readonly EntryId: Guid; readonly Content: ContextContent; readonly IndexKeys?: readonly string[] }
  | { readonly kind: 'DeleteEntry'; readonly EntryId: Guid }
  | { readonly kind: 'ReplaceSegment'; readonly SegmentId: number; readonly Entries: readonly ContextEntry[] }
  | { readonly kind: 'PutAnchor'; readonly Anchor: ConversationAnchor }
  | { readonly kind: 'RemoveAnchor'; readonly AnchorId: Guid }
  | { readonly kind: 'SetSessionStatus'; readonly Status: SessionStatus };

export interface ContextChangeSet {
  readonly SessionId: Guid;
  readonly ExpectedRevision: number;
  readonly Changes: readonly ContextChange[];
}

export interface MemoryChangeSet {
  readonly ExpectedRevision: number;
  readonly Upserts: readonly ContextMemory[];
  readonly Deletes: readonly Guid[];
}
