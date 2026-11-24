// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { Guid } from '../domain/session.js';

export enum DeferredIndexLifecycleStatus {
  Idle = 'Idle',
  Pending = 'Pending',
  Reindexing = 'Reindexing',
  Ready = 'Ready',
}

export interface DeferredIndexingState {
  readonly SessionId: Guid;
  readonly Status: DeferredIndexLifecycleStatus;
  readonly PendingEntryCount: number;
  readonly PendingCharacterCount: number;
  readonly FailedEntries: number;
  readonly Error: string | null;
  readonly IsComplete: boolean;
  readonly Generation: number;
}

export class DeferredIndexLifecycle {
  private readonly states = new Map<Guid, DeferredIndexingState>();

  public get(sessionId: Guid): DeferredIndexingState | undefined {
    return this.states.get(sessionId);
  }

  public markPending(sessionId: Guid, pendingEntries = 0, pendingCharacters = 0): DeferredIndexingState {
    const nextEntries = this.clampCount(pendingEntries);
    const nextCharacters = this.clampCount(pendingCharacters);
    const current = this.states.get(sessionId) ?? this.emptyState(sessionId);
    const next: DeferredIndexingState = {
      SessionId: sessionId,
      Status: DeferredIndexLifecycleStatus.Pending,
      PendingEntryCount: nextEntries,
      PendingCharacterCount: nextCharacters,
      FailedEntries: 0,
      Error: null,
      IsComplete: false,
      Generation: current.Generation + 1,
    };
    this.states.set(sessionId, next);
    return next;
  }

  public markReindexing(sessionId: Guid): DeferredIndexingState {
    const current = this.states.get(sessionId) ?? this.emptyState(sessionId);
    const next: DeferredIndexingState = {
      ...current,
      Status: DeferredIndexLifecycleStatus.Reindexing,
      FailedEntries: current.FailedEntries,
      Error: current.Error,
      IsComplete: false,
      Generation: current.Generation + 1,
    };
    this.states.set(sessionId, next);
    return next;
  }

  public markFailed(sessionId: Guid, failedEntries = 1, reason: string | null = null): DeferredIndexingState {
    const current = this.states.get(sessionId) ?? this.emptyState(sessionId);
    const next: DeferredIndexingState = {
      ...current,
      Status: DeferredIndexLifecycleStatus.Pending,
      FailedEntries: this.clampCount(failedEntries),
      Error: reason ?? current.Error ?? 'Deferred indexing failed.',
      IsComplete: false,
      Generation: current.Generation + 1,
    };
    this.states.set(sessionId, next);
    return next;
  }

  public complete(sessionId: Guid): DeferredIndexingState {
    const current = this.states.get(sessionId) ?? this.emptyState(sessionId);
    const next: DeferredIndexingState = {
      ...current,
      Status: DeferredIndexLifecycleStatus.Ready,
      PendingEntryCount: 0,
      PendingCharacterCount: 0,
      FailedEntries: 0,
      Error: null,
      IsComplete: true,
      Generation: current.Generation + 1,
    };
    this.states.set(sessionId, next);
    return next;
  }

  public validateThreshold(sessionId: Guid, minimumCharacters: number): boolean {
    const state = this.states.get(sessionId);
    if (!state) {
      return false;
    }
    return state.PendingCharacterCount >= this.clampCount(minimumCharacters);
  }

  public clear(sessionId: Guid): void {
    this.states.delete(sessionId);
  }

  public clearAll(): void {
    this.states.clear();
  }

  private emptyState(sessionId: Guid): DeferredIndexingState {
    return {
      SessionId: sessionId,
      Status: DeferredIndexLifecycleStatus.Idle,
      PendingEntryCount: 0,
      PendingCharacterCount: 0,
      FailedEntries: 0,
      Error: null,
      IsComplete: true,
      Generation: 0,
    };
  }

  private clampCount(value: number): number {
    if (!Number.isFinite(value)) {
      throw new TypeError('Deferred index counters must be finite numbers.');
    }
    return Math.max(0, Math.trunc(value));
  }
}
