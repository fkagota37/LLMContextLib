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
  private readonly activeReads = new Set<ContextReadLease>();
  private memoryRevision = 0;
  private publishedMutations = 0;
  private retainedReads = 0;

  public initialize(sessions: readonly LLMSessionContext[]): void {
    this.sessions.clear();
    this.activeReads.clear();
    this.publishedMutations = 0;
    this.retainedReads = 0;
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
    this.publishedMutations += 1;
    return result;
  }

  public applyMemory(changes: MemoryChangeSet): IContextMutationResult {
    const result = this.memoryStore.apply(changes);
    if (result.Status !== ContextMutationStatus.Applied) {
      return new ContextMutationResult(result.Status, result.Revision, result.Error ?? null, []);
    }

    this.memoryRevision = Math.max(this.memoryRevision, changes.ExpectedRevision + 1);
    this.publishedMutations += 1;
    return new ContextMutationResult(ContextMutationStatus.Applied, this.memoryRevision, null, []);
  }

  public openRead(sessionId: Guid): ContextReadLease {
    const current = this.sessions.get(sessionId);
    if (!current) {
      throw new Error(`Session ${sessionId} was not found.`);
    }

    const lease = new ContextReadLease(this.cloneSession(current), this.memoryRevision, () => {
      this.activeReads.delete(lease);
      this.retainedReads = this.activeReads.size;
    });
    this.activeReads.add(lease);
    this.retainedReads = this.activeReads.size;
    return lease;
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
    const estimatedActiveBytes = Array.from(this.sessions.values()).reduce((total, session) => total + this.estimateSessionBytes(session), 0);
    const estimatedRetainedBytes = this.retainedReads * 512;
    return {
      Sessions: this.sessions.size,
      EstimatedActiveBytes: estimatedActiveBytes,
      EstimatedRetainedBytes: estimatedRetainedBytes,
      RetainedReads: this.retainedReads,
      MemoryRevision: this.memoryRevision,
      PublishedMutations: this.publishedMutations,
      SegmentsRewritten: 0,
      EstimatedSegmentBytesRewritten: 0,
    };
  }

  public dispose(): void {
    this.activeReads.clear();
    this.retainedReads = 0;
    this.sessions.clear();
    this.memoryRevision = 0;
    this.publishedMutations = 0;
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

  private estimateSessionBytes(session: LLMSessionContext): number {
    let total = 128;
    for (const segment of session.Segments.values()) {
      total += 64;
      for (const entry of segment.Entries) {
        total += 64;
        total += this.estimateContentBytes(entry);
      }
    }
    for (const anchor of session.Anchors.values()) {
      total += 64 + anchor.Title.length + anchor.Summary.length;
    }
    return total;
  }

  private estimateContentBytes(entry: ContextEntry): number {
    const kind = 'kind' in entry.Content ? String(entry.Content.kind) : '';
    const base = entry.EntryId.length + entry.CreatedAt.length + kind.length;
    if ('text' in entry.Content && typeof entry.Content.text === 'string') {
      return base + entry.Content.text.length * 2;
    }
    if ('argumentsJson' in entry.Content && typeof entry.Content.argumentsJson === 'string') {
      return base + entry.Content.argumentsJson.length * 2;
    }
    if ('resultJson' in entry.Content && typeof entry.Content.resultJson === 'string') {
      return base + entry.Content.resultJson.length * 2;
    }
    return base;
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
