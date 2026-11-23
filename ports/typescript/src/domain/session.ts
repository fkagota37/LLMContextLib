// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export type Guid = string;

export enum ContextRole {
  System = 'System',
  User = 'User',
  Assistant = 'Assistant',
  Tool = 'Tool',
  Internal = 'Internal',
}

export enum SessionStatus {
  Active = 'Active',
  Suspended = 'Suspended',
  Closed = 'Closed',
  Expired = 'Expired',
}

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

export enum ContextMutationStatus {
  Applied = 'Applied',
  RevisionConflict = 'RevisionConflict',
  InvalidOperation = 'InvalidOperation',
  AdmissionRejected = 'AdmissionRejected',
  NotFound = 'NotFound',
  Synchronizing = 'Synchronizing',
  SynchronizationRequired = 'SynchronizationRequired',
}

export enum AnchorTargetStatus {
  Current = 'Current',
  Edited = 'Edited',
  Partial = 'Partial',
  Missing = 'Missing',
  HistoryUnavailable = 'HistoryUnavailable',
}

/**
 * Immutable transcript payloads; the port preserves the C# restriction that only the built-in
 * content variants are accepted, and each instance must carry an explicit, non-null payload.
 */
export abstract class ContextContent {}

export class TextContent extends ContextContent {
  public readonly kind = 'TextContent';
  constructor(public readonly text: string) {
    super();
    if (text === null || text === undefined) {
      throw new TypeError('TextContent.text cannot be null or undefined.');
    }
  }
}

export class ToolCallContent extends ContextContent {
  public readonly kind = 'ToolCallContent';
  constructor(
    public readonly callId: string,
    public readonly toolName: string,
    public readonly argumentsJson: string,
  ) {
    super();
    if (callId === null || callId === undefined || toolName === null || toolName === undefined || argumentsJson === null || argumentsJson === undefined) {
      throw new TypeError('ToolCallContent fields cannot be null or undefined.');
    }
  }
}

export class ToolResultContent extends ContextContent {
  public readonly kind = 'ToolResultContent';
  constructor(
    public readonly callId: string,
    public readonly resultJson: string,
    public readonly isError: boolean,
  ) {
    super();
    if (callId === null || callId === undefined || resultJson === null || resultJson === undefined) {
      throw new TypeError('ToolResultContent fields cannot be null or undefined.');
    }
  }
}

export class SummaryContent extends ContextContent {
  public readonly kind = 'SummaryContent';
  constructor(
    public readonly text: string,
    public readonly throughSequence: number,
  ) {
    super();
    if (text === null || text === undefined) {
      throw new TypeError('SummaryContent.text cannot be null or undefined.');
    }
  }
}

export interface LLMSessionContext {
  readonly SessionId: Guid;
  readonly UserId: Guid;
  readonly RepositoryId: Guid | null;
  readonly Revision: number;
  readonly Status: SessionStatus;
  readonly Segments: ReadonlyMap<number, ContextSegment>;
  readonly Anchors: ReadonlyMap<Guid, ConversationAnchor>;
}

export interface ContextSegment {
  readonly SegmentId: number;
  readonly Revision: number;
  readonly Entries: readonly ContextEntry[];
}

export interface ContextEntry {
  readonly EntryId: Guid;
  readonly Sequence: number;
  readonly Role: ContextRole;
  readonly CreatedAt: string;
  readonly Content: ContextContent;
  readonly IndexKeys?: readonly string[];
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

export interface IContextMutationResult {
  readonly Status: ContextMutationStatus;
  readonly Revision: number;
  readonly Error?: string | null;
  readonly AppendedEntryIds: readonly Guid[];
}

export class ContextMutationResult implements IContextMutationResult {
  constructor(
    public readonly Status: ContextMutationStatus,
    public readonly Revision: number,
    public readonly Error: string | null = null,
    public readonly AppendedEntryIds: readonly Guid[] = [],
  ) {}
}

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

export interface ContextCursor {
  readonly SessionId: Guid;
  readonly Revision: number;
  readonly AfterSequence: number;
}

export interface ContextPage {
  readonly Entries: readonly ContextEntry[];
  readonly Next: ContextCursor | null;
}

export interface ContextSearchHit {
  readonly EntryId: Guid;
  readonly AnchorId: Guid | null;
  readonly Snippet: string;
  readonly Sequence: number;
  readonly SessionRevision: number;
}

export interface AnchorResolution {
  readonly Anchor: ConversationAnchor;
  readonly Status: AnchorTargetStatus;
  readonly Start: ContextEntry | null;
  readonly End: ContextEntry | null;
  readonly SessionRevision: number;
}

export interface ModelContextItem {
  readonly EntryId: Guid | null;
  readonly MemoryId: Guid | null;
  readonly Role: ContextRole;
  readonly Text: string;
}
