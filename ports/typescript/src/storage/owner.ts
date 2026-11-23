// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextIndexingMode } from '../domain/index-keys.js';
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
import { IndexStore } from './index-store.js';
import { MemoryStore } from './memory-store.js';
import { SessionStore } from './session-store.js';

/**
 * The owner boundary holds the single writable publication lifetime for the port. It is not a
 * mutable conversation object and it does not expose a writable top-level session array.
 */
export class LLMContextOwner {
  private readonly store = new SessionStore();
  private readonly memoryStore = new MemoryStore();
  private readonly indexStore = new IndexStore();
  private readonly sessions = new Map<Guid, LLMSessionContext>();
  private memoryRevision = 0;

  public initialize(sessions: readonly LLMSessionContext[]): void {
    this.sessions.clear();
    this.indexStore.clear();
    for (const session of sessions) {
      const clone = this.cloneSession(session);
      this.sessions.set(session.SessionId, clone);
      this.store.touch(clone);
      this.reindexSession(clone);
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
    this.reindexSession(next);
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
    this.indexStore.clear();
    for (const session of this.sessions.values()) {
      this.reindexSession(session);
    }
    return this.store.removeSession(sessionId, expectedRevision);
  }

  public applySession(changes: ContextChangeSet): IContextMutationResult {
    const result = this.store.applySession(changes);
    if (result.Status !== ContextMutationStatus.Applied) {
      return result;
    }

    const session = this.store.tryFind(changes.SessionId);
    if (!session) {
      return new ContextMutationResult(ContextMutationStatus.NotFound, 0, 'Session not found after mutation.', []);
    }

    this.sessions.set(changes.SessionId, this.cloneSession(session));
    this.reindexSession(this.sessions.get(changes.SessionId) ?? session);
    return result;
  }

  public applyMemory(changes: MemoryChangeSet): IContextMutationResult {
    const result = this.memoryStore.apply(changes);
    if (result.Status !== ContextMutationStatus.Applied) {
      return new ContextMutationResult(result.Status, result.Revision, result.Error ?? null, []);
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

  public openView<T>(definition: { readonly SessionId: Guid; readonly MaximumResults: number; Evaluate(context: ContextReadLease): Iterable<T> }): Iterable<T> {
    const lease = this.openRead(definition.SessionId);
    const values: T[] = [];
    for (const item of definition.Evaluate(lease)) {
      values.push(item);
      if (values.length >= definition.MaximumResults) {
        break;
      }
    }
    lease.dispose();
    return values;
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

  public getMemoryStore(): MemoryStore {
    return this.memoryStore;
  }

  public getIndexStore(): IndexStore {
    return this.indexStore;
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

  private reindexSession(session: LLMSessionContext): void {
    for (const segment of session.Segments.values()) {
      for (const entry of segment.Entries) {
        const keys = entry.IndexKeys ?? [];
        if (keys.length) {
          this.indexStore.setEntry(entry.EntryId, { Keys: keys }, ContextIndexingMode.ProducerOwned);
        }
      }
    }

    for (const anchor of session.Anchors.values()) {
      const keys = anchor.IndexKeys ?? [];
      if (keys.length) {
        this.indexStore.setAnchor(anchor.AnchorId, { Keys: keys }, ContextIndexingMode.ProducerOwned);
      }
    }
  }
}
