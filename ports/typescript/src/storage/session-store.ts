// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import {
  type ContextChange,
  type ContextChangeSet,
  type ContextEntry,
  type Guid,
  type IContextMutationResult,
  type LLMSessionContext,
  type MemoryChangeSet,
  ContextMutationResult,
  ContextMutationStatus,
  SessionStatus,
} from '../domain/session.js';

type MutableSession = {
  SessionId: Guid;
  UserId: Guid;
  RepositoryId: Guid | null;
  Revision: number;
  Status: SessionStatus;
  Segments: Map<number, { SegmentId: number; Revision: number; Entries: ContextEntry[] }>;
  Anchors: Map<Guid, { readonly AnchorId: Guid; readonly StartEntryId: Guid; readonly EndEntryId: Guid; readonly Title: string; readonly Summary: string; readonly Topics: readonly string[]; readonly Kind: any; readonly SourceRevision: number; readonly PinnedRevision: number | null; readonly IndexKeys?: readonly string[] }>;
};

export class SessionStore {
  private readonly sessions = new Map<Guid, LLMSessionContext>();

  public tryFind(sessionId: Guid): LLMSessionContext | null {
    return this.sessions.get(sessionId) ?? null;
  }

  public touch(session: LLMSessionContext): void {
    this.sessions.set(session.SessionId, this.cloneSession(session));
  }

  public createSession(session: LLMSessionContext): IContextMutationResult {
    if (this.sessions.has(session.SessionId)) {
      return new ContextMutationResult(ContextMutationStatus.AdmissionRejected, session.Revision, 'Session already exists.', []);
    }
    this.touch(session);
    return new ContextMutationResult(ContextMutationStatus.Applied, session.Revision, null, []);
  }

  public removeSession(sessionId: Guid, expectedRevision: number): IContextMutationResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return new ContextMutationResult(ContextMutationStatus.NotFound, 0, 'Session not found.', []);
    }
    if (session.Revision !== expectedRevision) {
      return new ContextMutationResult(ContextMutationStatus.RevisionConflict, session.Revision, 'Expected revision mismatch.', []);
    }
    this.sessions.delete(sessionId);
    return new ContextMutationResult(ContextMutationStatus.Applied, expectedRevision, null, []);
  }

  public applySession(changes: ContextChangeSet): IContextMutationResult {
    const session = this.sessions.get(changes.SessionId);
    if (!session) {
      return new ContextMutationResult(ContextMutationStatus.NotFound, 0, 'Session not found.', []);
    }
    if (session.Revision !== changes.ExpectedRevision) {
      return new ContextMutationResult(ContextMutationStatus.RevisionConflict, session.Revision, 'Expected revision mismatch.', []);
    }

    const nextSession: MutableSession = this.cloneSession(session);
    const appended: Guid[] = [];
    for (const change of changes.Changes) {
      this.applyChange(nextSession, change, appended);
    }

    const published: LLMSessionContext = {
      ...nextSession,
      Revision: session.Revision + 1,
      Segments: new Map(nextSession.Segments),
      Anchors: new Map(nextSession.Anchors),
    };
    this.sessions.set(changes.SessionId, published);
    return new ContextMutationResult(ContextMutationStatus.Applied, published.Revision, null, appended);
  }

  public applyMemory(changes: MemoryChangeSet): IContextMutationResult {
    if (changes.ExpectedRevision < 0) {
      return new ContextMutationResult(ContextMutationStatus.InvalidOperation, 0, 'Expected revision must be non-negative.', []);
    }
    return new ContextMutationResult(ContextMutationStatus.Applied, changes.ExpectedRevision + 1, null, []);
  }

  public getStatus(): SessionStatus {
    return SessionStatus.Active;
  }

  private cloneSession(session: LLMSessionContext): MutableSession {
    return {
      SessionId: session.SessionId,
      UserId: session.UserId,
      RepositoryId: session.RepositoryId,
      Revision: session.Revision,
      Status: session.Status,
      Segments: new Map(Array.from(session.Segments.entries(), ([segmentId, segment]) => [segmentId, { ...segment, Entries: [...segment.Entries] }])),
      Anchors: new Map(Array.from(session.Anchors.entries(), ([anchorId, anchor]) => [anchorId, { ...anchor, Topics: [...anchor.Topics], IndexKeys: anchor.IndexKeys ? [...anchor.IndexKeys] : undefined }])),
    };
  }

  private applyChange(session: MutableSession, change: ContextChange, appendedEntryIds: Guid[]): void {
    switch (change.kind) {
      case 'AppendEntries': {
        let targetSegmentId = 0;
        let targetSegment = session.Segments.get(targetSegmentId);
        if (!targetSegment) {
          targetSegmentId = this.nextSegmentId(session);
          targetSegment = { SegmentId: targetSegmentId, Revision: session.Revision + 1, Entries: [] };
          session.Segments.set(targetSegmentId, targetSegment);
        }

        const entries = [...targetSegment.Entries];
        for (const entry of change.Entries) {
          const nextEntry: ContextEntry = {
            ...entry,
            Sequence: entries.length + 1,
          };
          appendedEntryIds.push(nextEntry.EntryId);
          entries.push(nextEntry);
        }

        session.Segments.set(targetSegmentId, {
          SegmentId: targetSegmentId,
          Revision: session.Revision + 1,
          Entries: entries,
        });
        break;
      }
      case 'ReplaceEntry': {
        const nextSegments = new Map(session.Segments);
        for (const [segmentId, segment] of nextSegments.entries()) {
          const replaced = segment.Entries.map((entry) => (entry.EntryId === change.EntryId ? { ...entry, Content: change.Content, IndexKeys: change.IndexKeys ?? entry.IndexKeys } : entry));
          if (replaced.length !== segment.Entries.length) {
            nextSegments.set(segmentId, { ...segment, Entries: replaced });
            session.Segments = nextSegments;
            return;
          }
        }
        break;
      }
      case 'DeleteEntry': {
        const nextSegments = new Map(session.Segments);
        for (const [segmentId, segment] of nextSegments.entries()) {
          const remaining = segment.Entries.filter((entry) => entry.EntryId !== change.EntryId);
          if (remaining.length !== segment.Entries.length) {
            nextSegments.set(segmentId, { ...segment, Entries: remaining });
            session.Segments = nextSegments;
            return;
          }
        }
        break;
      }
      case 'ReplaceSegment': {
        session.Segments.set(change.SegmentId, {
          SegmentId: change.SegmentId,
          Revision: session.Revision + 1,
          Entries: [...change.Entries],
        });
        break;
      }
      case 'PutAnchor': {
        session.Anchors.set(change.Anchor.AnchorId, change.Anchor);
        break;
      }
      case 'RemoveAnchor': {
        session.Anchors.delete(change.AnchorId);
        break;
      }
      case 'SetSessionStatus': {
        session.Status = change.Status;
        break;
      }
      default:
        break;
    }
  }

  private allEntries(session: LLMSessionContext): ContextEntry[] {
    const entries: ContextEntry[] = [];
    for (const segment of session.Segments.values()) {
      entries.push(...segment.Entries);
    }
    return entries;
  }

  private nextSegmentId(session: LLMSessionContext): number {
    let max = 0;
    for (const segment of session.Segments.keys()) {
      max = Math.max(max, segment);
    }
    return max + 1;
  }
}
