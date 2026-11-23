// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import {
  type ContextChangeSet,
  type Guid,
  type IContextMutationResult,
  type LLMSessionContext,
  type MemoryChangeSet,
  ContextMutationResult,
  ContextMutationStatus,
  SessionStatus,
} from '../domain/session.js';

export class SessionStore {
  private readonly sessions = new Map<Guid, LLMSessionContext>();

  public tryFind(sessionId: Guid): LLMSessionContext | null {
    return this.sessions.get(sessionId) ?? null;
  }

  public touch(session: LLMSessionContext): void {
    this.sessions.set(session.SessionId, { ...session, Segments: new Map(session.Segments), Anchors: new Map(session.Anchors) });
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

    const nextRevision = session.Revision + 1;
    this.sessions.set(changes.SessionId, { ...session, Revision: nextRevision });
    return new ContextMutationResult(ContextMutationStatus.Applied, nextRevision, null, []);
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
}
