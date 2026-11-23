// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import {
  type ContextChangeSet,
  type ContextEntry,
  type Guid,
  type IContextMutationResult,
  type LLMSessionContext,
  type MemoryChangeSet,
  ContextMutationResult,
  ContextMutationStatus,
} from '../domain/session.js';
import { ContextReadLease } from './lease.js';
import { SessionStore } from './session-store.js';

/**
 * The owner boundary holds the single writable publication lifetime for the port. It is not a
 * mutable conversation object and it does not expose a writable top-level session array.
 */
export class LLMContextOwner {
  private readonly store = new SessionStore();
  private readonly sessions = new Map<Guid, LLMSessionContext>();
  private memoryRevision = 0;

  public initialize(sessions: readonly LLMSessionContext[]): void {
    this.sessions.clear();
    for (const session of sessions) {
      this.sessions.set(session.SessionId, this.cloneSession(session));
    }
  }

  public tryFindSession(sessionId: Guid): LLMSessionContext | null {
    const session = this.sessions.get(sessionId);
    return session ? this.cloneSession(session) : null;
  }

  public createSession(session: LLMSessionContext): IContextMutationResult {
    const existing = this.sessions.get(session.SessionId);
    if (existing) {
      return new ContextMutationResult(ContextMutationStatus.AdmissionRejected, existing.Revision, 'Session already exists.', []);
    }

    const next = this.cloneSession(session);
    this.sessions.set(next.SessionId, next);
    this.store.touch(next);
    return new ContextMutationResult(ContextMutationStatus.Applied, next.Revision, null, []);
  }

  public removeSession(sessionId: Guid, expectedRevision: number): IContextMutationResult {
    const current = this.sessions.get(sessionId);
    if (!current) {
      return new ContextMutationResult(ContextMutationStatus.NotFound, 0, 'Session not found.', []);
    }
    if (current.Revision !== expectedRevision) {
      return new ContextMutationResult(ContextMutationStatus.RevisionConflict, current.Revision, 'Expected revision mismatch.', []);
    }

    this.sessions.delete(sessionId);
    return new ContextMutationResult(ContextMutationStatus.Applied, current.Revision, null, []);
  }

  public applySession(changes: ContextChangeSet): IContextMutationResult {
    const current = this.sessions.get(changes.SessionId);
    if (!current) {
      return new ContextMutationResult(ContextMutationStatus.NotFound, 0, 'Session not found.', []);
    }
    if (current.Revision !== changes.ExpectedRevision) {
      return new ContextMutationResult(ContextMutationStatus.RevisionConflict, current.Revision, 'Expected revision mismatch.', []);
    }

    const nextRevision = current.Revision + 1;
    this.sessions.set(changes.SessionId, { ...current, Revision: nextRevision });
    return new ContextMutationResult(ContextMutationStatus.Applied, nextRevision, null, []);
  }

  public applyMemory(changes: MemoryChangeSet): IContextMutationResult {
    if (changes.ExpectedRevision < 0) {
      return new ContextMutationResult(ContextMutationStatus.InvalidOperation, 0, 'Expected revision must be non-negative.', []);
    }

    this.memoryRevision = Math.max(this.memoryRevision, changes.ExpectedRevision + 1);
    return new ContextMutationResult(ContextMutationStatus.Applied, this.memoryRevision, null, []);
  }

  public openRead(sessionId: Guid): ContextReadLease {
    const current = this.sessions.get(sessionId);
    if (!current) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    return new ContextReadLease(this.cloneSession(current), this.memoryRevision);
  }

  public getStatistics(): {
    readonly Sessions: number;
    readonly EstimatedActiveBytes: number;
    readonly EstimatedRetainedBytes: number;
    readonly RetainedReads: number;
    readonly MemoryRevision: number;
    readonly PublishedMutations: number;
    readonly SegmentsRewritten: number;
    readonly EstimatedSegmentBytesRewritten: number;
  } {
    return {
      Sessions: this.sessions.size,
      EstimatedActiveBytes: this.sessions.size * 1024,
      EstimatedRetainedBytes: this.sessions.size * 512,
      RetainedReads: 0,
      MemoryRevision: this.memoryRevision,
      PublishedMutations: this.memoryRevision,
      SegmentsRewritten: 0,
      EstimatedSegmentBytesRewritten: 0,
    };
  }

  public dispose(): void {
    this.sessions.clear();
    this.memoryRevision = 0;
  }

  public getStore(): SessionStore {
    return this.store;
  }

  private cloneSession(session: LLMSessionContext): LLMSessionContext {
    const segments = new Map<number, { readonly SegmentId: number; readonly Revision: number; readonly Entries: readonly ContextEntry[] }>();
    for (const [segmentId, segment] of session.Segments) {
      segments.set(segmentId, {
        ...segment,
        Entries: [...segment.Entries],
      });
    }

    const anchors = new Map(session.Anchors);
    return {
      ...session,
      Segments: segments,
      Anchors: anchors,
    };
  }
}
