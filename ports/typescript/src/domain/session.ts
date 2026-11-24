// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { Int64 } from './int64.js';
import { sealPayload } from './payload-identity.js';

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

export interface ContextIndexStatus {
  readonly SessionRevision: Int64;
  readonly IndexGeneration: Int64;
  readonly PendingEntries: number;
  readonly FailedEntries: number;
  readonly Error: string | null;
  readonly IsComplete: boolean;
}

export interface ContextIndexedSearchResult {
  readonly Hits: readonly ContextSearchHit[];
  readonly IndexStatus: ContextIndexStatus;
}

/**
 * Immutable transcript payloads; the port preserves the C# restriction that only the built-in
 * content variants are accepted, and each instance must carry an explicit, non-null payload.
 */
export abstract class ContextContent {}

export class TextContent extends ContextContent {
  public readonly kind = 'TextContent';
  public readonly Text: string;

  constructor(text: string) {
    super();
    if (text === null || text === undefined) {
      throw new TypeError('TextContent.text cannot be null or undefined.');
    }
    this.Text = text;
    if (new.target === TextContent) sealPayload(this);
  }

  public get text(): string {
    return this.Text;
  }
}

export class ToolCallContent extends ContextContent {
  public readonly kind = 'ToolCallContent';
  public readonly CallId: string;
  public readonly ToolName: string;
  public readonly ArgumentsJson: string;

  constructor(callId: string, toolName: string, argumentsJson: string) {
    super();
    if (callId === null || callId === undefined || toolName === null || toolName === undefined || argumentsJson === null || argumentsJson === undefined) {
      throw new TypeError('ToolCallContent fields cannot be null or undefined.');
    }
    this.CallId = callId;
    this.ToolName = toolName;
    this.ArgumentsJson = argumentsJson;
    if (new.target === ToolCallContent) sealPayload(this);
  }

  public get callId(): string { return this.CallId; }
  public get toolName(): string { return this.ToolName; }
  public get argumentsJson(): string { return this.ArgumentsJson; }
}

export class ToolResultContent extends ContextContent {
  public readonly kind = 'ToolResultContent';
  public readonly CallId: string;
  public readonly ResultJson: string;
  public readonly IsError: boolean;

  constructor(callId: string, resultJson: string, isError: boolean) {
    super();
    if (callId === null || callId === undefined || resultJson === null || resultJson === undefined) {
      throw new TypeError('ToolResultContent fields cannot be null or undefined.');
    }
    this.CallId = callId;
    this.ResultJson = resultJson;
    this.IsError = isError;
    if (new.target === ToolResultContent) sealPayload(this);
  }

  public get callId(): string { return this.CallId; }
  public get resultJson(): string { return this.ResultJson; }
  public get isError(): boolean { return this.IsError; }
}

export class SummaryContent extends ContextContent {
  public readonly kind = 'SummaryContent';
  public readonly Text: string;
  public readonly ThroughSequence: Int64;

  constructor(text: string, throughSequence: Int64) {
    super();
    if (text === null || text === undefined) {
      throw new TypeError('SummaryContent.text cannot be null or undefined.');
    }
    this.Text = text;
    this.ThroughSequence = throughSequence;
    if (new.target === SummaryContent) sealPayload(this);
  }

  public get text(): string { return this.Text; }
  public get throughSequence(): Int64 { return this.ThroughSequence; }
}

export interface LLMSessionContext {
  readonly SessionId: Guid;
  readonly UserId: Guid;
  readonly RepositoryId: Guid | null;
  readonly Revision: Int64;
  readonly Status: SessionStatus;
  readonly Segments: ReadonlyMap<Int64, ContextSegment>;
  readonly Anchors: ReadonlyMap<Guid, ConversationAnchor>;
}

export interface ContextSegment {
  readonly SegmentId: Int64;
  readonly Revision: Int64;
  readonly Entries: readonly ContextEntry[];
}

export interface ContextEntry {
  readonly EntryId: Guid;
  readonly Sequence: Int64;
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
  readonly SourceRevision: Int64;
  readonly PinnedRevision: Int64 | null;
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
  readonly Revision: Int64;
  readonly Status: MemoryStatus;
  readonly ExpiresAt: string | null;
  readonly Sources: readonly MemorySource[];
}

export interface IContextMutationResult {
  readonly Status: ContextMutationStatus;
  readonly Revision: Int64;
  readonly Error?: string | null;
  readonly AppendedEntryIds: readonly Guid[];
}

export class ContextMutationResult implements IContextMutationResult {
  constructor(
    public readonly Status: ContextMutationStatus,
    public readonly Revision: Int64,
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
  | { readonly kind: 'ReplaceSegment'; readonly SegmentId: Int64; readonly Entries: readonly ContextEntry[] }
  | { readonly kind: 'PutAnchor'; readonly Anchor: ConversationAnchor }
  | { readonly kind: 'RemoveAnchor'; readonly AnchorId: Guid }
  | { readonly kind: 'SetSessionStatus'; readonly Status: SessionStatus };

export interface ContextChangeSet {
  readonly SessionId: Guid;
  readonly ExpectedRevision: Int64;
  readonly Changes: readonly ContextChange[];
}

export interface MemoryChangeSet {
  readonly ExpectedRevision: Int64;
  readonly Upserts: readonly ContextMemory[];
  readonly Deletes: readonly Guid[];
}

export interface ContextCursor {
  readonly SessionId: Guid;
  readonly Revision: Int64;
  readonly AfterSequence: Int64;
}

export interface ContextPage {
  readonly Entries: readonly ContextEntry[];
  readonly Next: ContextCursor | null;
}

export interface ContextSearchHit {
  readonly EntryId: Guid;
  readonly AnchorId: Guid | null;
  readonly Snippet: string;
  readonly Sequence: Int64;
  readonly SessionRevision: Int64;
}

export interface AnchorResolution {
  readonly Anchor: ConversationAnchor;
  readonly Status: AnchorTargetStatus;
  readonly Start: ContextEntry | null;
  readonly End: ContextEntry | null;
  readonly SessionRevision: Int64;
}

export interface ModelContextItem {
  readonly EntryId: Guid | null;
  readonly MemoryId: Guid | null;
  readonly Role: ContextRole;
  readonly Text: string;
}
