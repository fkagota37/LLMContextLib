// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export type Guid = string;

export enum AnchorKind {
  Manual = 'Manual',
  Topic = 'Topic',
  Decision = 'Decision',
  Question = 'Question',
  Artifact = 'Artifact',
}

export enum MemoryStatus {
  Proposed = 'Proposed',
  Confirmed = 'Confirmed',
  Superseded = 'Superseded',
  Retracted = 'Retracted',
}

export interface MemoryScope {
  readonly UserId?: Guid | null;
  readonly RepositoryId?: Guid | null;
  readonly SessionId?: Guid | null;
}

export interface MemorySource {
  readonly SessionId: Guid;
  readonly AnchorId: Guid;
}

export interface ContextMemory {
  readonly MemoryId: Guid;
  readonly Scope: MemoryScope;
  readonly Content: string;
  readonly Revision: number;
  readonly Status: MemoryStatus;
  readonly ExpiresAt: string | null;
  readonly Sources: readonly MemorySource[];
}

export interface ConversationAnchor {
  readonly AnchorId: Guid;
  readonly StartEntryId: Guid;
  readonly EndEntryId: Guid;
  readonly Title: string;
  readonly Summary: string;
  readonly Topics: readonly string[];
  readonly Kind: AnchorKind;
  readonly SourceRevision: number;
  readonly PinnedRevision: number | null;
  readonly IndexKeys?: readonly string[];
}
