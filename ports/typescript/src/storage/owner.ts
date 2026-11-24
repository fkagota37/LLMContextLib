// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextIndexingMode } from '../domain/index-keys.js';
import { ContextError } from '../domain/errors.js';
import { canonicalGuid } from '../domain/guid.js';
import { advanceInt64, canonicalInt64, checkedInt64, compareInt64, incrementCounter, isInt64, type Int64 } from '../domain/int64.js';
import type { LLMContextStatistics } from '../domain/reads.js';
import {
  type ContextChangeSet,
  type ContextMemory,
  type Guid,
  type IContextMutationResult,
  type LLMSessionContext,
  type MemoryChangeSet,
  ContextMutationResult,
  ContextMutationStatus,
} from '../domain/session.js';
import { defaultLLMContextOptions, deferredInfrastructureBytes, type LLMContextOptions } from '../options.js';
import { ContextExecution, ContextIndexingStrategy, indexRetentionReservation, indexWorkReservation,
  type ContextExecutionRecipe } from '../execution/strategy.js';
import { Matches } from '../policies/context.js';
import { ContextReadLease } from './lease.js';
import { MemoryStore, type PreparedMemoryChange } from './memory-store.js';
import type { MutationDiagnostics } from './mutation-diagnostics.js';
import { OwnerMailbox } from '../runtime/owner-mailbox.js';
import { IndexMaintenanceThread } from '../runtime/index-maintenance-thread.js';
import { EntryPreparationWorkers } from '../runtime/entry-preparation-workers.js';
import type { NativeIndexInput, NativeIndexOutput, PartitionIndexInput, PartitionIndexOutput } from '../runtime/index-maintenance-worker.js';
import { textParts } from '../policies/lexical.js';
import { attachWorkerContextPeer, type WorkerContextEndpoint } from '../runtime/worker-context-peer.js';
import { SessionStore, type EntryPreparationOutput, type SessionRoot } from './session-store.js';
import { estimateTermBytes, SessionIndex, type IndexJob, type PreparedSessionIndex } from './session-index.js';
import {
  ContextIndexPartition, ContextSynchronizationWriteBehavior, PartitionCapacityException, partitionInfrastructureBytes, partitionRecoveryBytes,
  type ContextIndexSynchronization,
} from './partitioned-index.js';

interface Synchronization {
  readonly SessionId: Guid;
  readonly Revision: Int64;
  readonly Epoch: Int64;
  readonly Promise: Promise<ContextIndexSynchronization>;
  readonly Resolve: (result: ContextIndexSynchronization) => void;
  PartitionsCompacted: number;
  After: Int64;
}

interface SessionReply {
  resolve(value: IContextMutationResult): void;
  reject(error: unknown): void;
}

function waitWithSignal<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void task.then((result) => {
      signal.removeEventListener('abort', abort);
      resolve(result);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

/**
 * The owner boundary holds the single writable publication lifetime for the port. It is not a
 * mutable conversation object and it does not expose a writable top-level session array.
 */
export class LLMContextOwner {
  private readonly indexingMode: ContextIndexingMode;
  private readonly options: LLMContextOptions;
  private readonly store: SessionStore;
  private readonly execution?: ContextExecution;
  private readonly memoryStore = new MemoryStore();
  private readonly indexes = new Map<Guid, SessionIndex>();
  private readonly indexJobs: IndexJob[] = [];
  private readonly indexWaiters = new Set<() => void>();
  private readonly jobsBySession = new Map<Guid, number>();
  private readonly sessionCommits = new Set<Guid>();
  private readonly partitionPreparations = new Map<Guid, number>();
  private memoryCommit = false;
  private mailbox?: OwnerMailbox;
  private indexWorker: ReturnType<typeof setImmediate> | undefined;
  private nativeIndexThread?: IndexMaintenanceThread<NativeIndexInput, NativeIndexOutput>;
  private nativeIndexJob?: IndexJob;
  private nativeIndexMemoKey?: string;
  private indexWorkerFailure: string | null = null;
  private readonly synchronizationEpochs = new Map<Guid, Int64>();
  private readonly synchronizations = new Map<Guid, Synchronization>();
  private partitionWorker: ReturnType<typeof setImmediate> | undefined;
  private partitionThread?: IndexMaintenanceThread<PartitionIndexInput, PartitionIndexOutput>;
  private entryPreparationWorkers?: EntryPreparationWorkers;
  private partitionInFlight?: { work: Synchronization; segmentId: Int64 };
  private disposed = false;
  constructor(indexingModeOrOptions: ContextIndexingMode | LLMContextOptions = defaultLLMContextOptions,
    private readonly selectSessionId = (session: LLMSessionContext) => session.SessionId,
    private readonly recipe?: ContextExecutionRecipe,
    private readonly beforePartitionCompaction?: (session: Guid, segment: Int64) => void) {
    const nextOptions = typeof indexingModeOrOptions === 'string'
      ? { ...defaultLLMContextOptions, IndexingMode: indexingModeOrOptions }
      : indexingModeOrOptions;
    this.options = nextOptions;
    this.store = new SessionStore(nextOptions);
    this.indexingMode = nextOptions.IndexingMode;
    this.estimatedSynchronizationReserveBytes = nextOptions.PartitionedIndex ? BigInt(partitionRecoveryBytes(nextOptions.PartitionedIndex)) : 0n;
    this.execution = recipe && new ContextExecution(recipe, nextOptions);
  }

  private readonly retainedRoots = new Map<object, { Count: number; Bytes: bigint }>();
  private retainedRootBytes = 0n;
  private publishedMutations: Int64 = 0;
  private retainedReads = 0;
  private estimateViewBytes = 0n;
  private estimatedIndexBytes = 0n;
  private estimatedIndexWorkBytes = 0n;
  private completedIndexJobs: Int64 = 0;
  private discardedIndexJobs: Int64 = 0;
  private estimatedSynchronizationReserveBytes = 0n;
  private estimatedPreparationBytes = 0n;

  public initialize(sessions: Iterable<LLMSessionContext>): void {
    this.ensureUsable();
    for (const session of sessions) {
      const result = this.createSession(session);
      if (result.Status !== ContextMutationStatus.Applied) {
        throw new TypeError(result.Error ?? 'Invalid initial session.');
      }
    }
  }

  public tryFindSession(sessionId: Guid): LLMSessionContext | null {
    this.ensureUsable();
    return this.store.tryFind(canonicalGuid(sessionId));
  }

  public createSession(session: LLMSessionContext): IContextMutationResult {
    this.ensureUsable();
    if (!session || canonicalGuid(this.selectSessionId(session)) !== canonicalGuid(session.SessionId)) {
      return new ContextMutationResult(ContextMutationStatus.InvalidOperation, 0, 'Session identity selector must preserve each canonical SessionId.');
    }
    const candidate = this.prepareIndex();
    let prepared: PreparedSessionIndex | undefined;
    const result = this.store.createSession(session, candidate.Edits, (delta, next, partitions) => {
      prepared = candidate.finish(next, partitions);
      const work = this.workBytes(prepared.Jobs);
      if (!this.canReserveJobs(prepared.Jobs.length, work)) return 'Deferred indexing backlog or work budget exhausted.';
      return this.waitForResidentBudget(delta + prepared.Index.EstimatedBytes + work) ? null : 'Resident budget exhausted.';
    }, () => this.canReserveJobs(prepared!.Jobs.length, this.workBytes(prepared!.Jobs)));
    if (result.Status === ContextMutationStatus.Applied) {
      this.publishIndex(canonicalGuid(session.SessionId), prepared!);
      this.publishedMutations = incrementCounter(this.publishedMutations);
    }
    return result;
  }

  public removeSession(sessionId: Guid, expectedRevision: Int64): IContextMutationResult {
    this.ensureUsable();
    sessionId = canonicalGuid(sessionId);
    const current = this.store.tryFind(sessionId);
    if (this.sessionCommits.has(sessionId)) {
      return new ContextMutationResult(ContextMutationStatus.AdmissionRejected, expectedRevision, 'Session commit gate is busy.');
    }
    if (current && isInt64(expectedRevision) && compareInt64(current.Revision, expectedRevision) === 0 && this.synchronizations.has(sessionId)) {
      return new ContextMutationResult(ContextMutationStatus.Synchronizing, current.Revision, 'Session index synchronization has closed write admission.');
    }
    const result = this.store.removeSession(sessionId, expectedRevision);
    if (result.Status === ContextMutationStatus.Applied) {
      this.estimatedIndexBytes -= this.indexes.get(sessionId)!.EstimatedBytes;
      this.indexes.delete(sessionId);
      this.synchronizationEpochs.delete(sessionId);
      this.pulseIndexWaiters();
      this.publishedMutations = incrementCounter(this.publishedMutations);
    }
    return result;
  }

  public removeSessionFromWorker(sessionId: Guid, expectedRevision: Int64): IContextMutationResult | Promise<IContextMutationResult> {
    this.ensureUsable();
    const id = canonicalGuid(sessionId);
    if (!this.sessionCommits.has(id) || this.options.AdmissionTimeoutMs === 0) {
      return this.removeSession(id, expectedRevision);
    }
    return this.resumeAfterGate(() => this.removeSession(id, expectedRevision),
      () => new ContextMutationResult(ContextMutationStatus.AdmissionRejected, expectedRevision, 'Session commit gate is busy.'));
  }

  private resumeAfterGate(commit: (deadline: number) => IContextMutationResult, timedOut: () => IContextMutationResult,
    timeout = this.options.AdmissionTimeoutMs): Promise<IContextMutationResult> {
    const deadline = performance.now() + timeout;
    return Promise.resolve().then(() => {
      this.ensureUsable();
      return performance.now() >= deadline ? timedOut() : commit(deadline);
    });
  }

  public applySession(changes: ContextChangeSet, diagnostics?: MutationDiagnostics): IContextMutationResult {
    if (!diagnostics) return this.applySessionCore(changes, false);
    const start = performance.now();
    try { return this.applySessionCore(changes, false, undefined, undefined, diagnostics); }
    finally { diagnostics.StorageMs = performance.now() - start; }
  }

  public applySessionFromWorker(changes: ContextChangeSet): IContextMutationResult | Promise<IContextMutationResult> {
    return this.applySessionCore(changes, true);
  }

  public replyToWorkerSession(changes: ContextChangeSet, resolve: (value: IContextMutationResult) => void, reject: (error: unknown) => void): boolean {
    try {
      const result = this.applySessionCore(changes, true, undefined, undefined, undefined, { resolve, reject });
      if (result === undefined) return true;
      if (result instanceof Promise) { void result.then(resolve, reject); return true; }
      resolve(result);
    } catch (error) { reject(error); }
    return false;
  }

  private applySessionCore(changes: ContextChangeSet, queue: false, selected?: boolean, gateDeadline?: number,
    diagnostics?: MutationDiagnostics): IContextMutationResult;
  private applySessionCore(changes: ContextChangeSet, queue: boolean): IContextMutationResult | Promise<IContextMutationResult>;
  private applySessionCore(changes: ContextChangeSet, queue: true, selected: undefined, gateDeadline: undefined, diagnostics: undefined,
    reply: SessionReply): IContextMutationResult | Promise<IContextMutationResult> | undefined;
  private applySessionCore(changes: ContextChangeSet, queue: boolean, selected?: boolean,
    gateDeadline?: number, diagnostics?: MutationDiagnostics, reply?: SessionReply): IContextMutationResult | Promise<IContextMutationResult> | undefined {
    this.ensureUsable();
    const limits = this.options.PartitionedIndex;
    const id = canonicalGuid(changes.SessionId);
    if (id !== changes.SessionId) changes = { ...changes, SessionId: id };
    if (limits && this.sessionCommits.has(id)) {
      if (diagnostics) diagnostics.Disposition = this.synchronizations.has(id) ? 'SynchronizationRejected' : 'GateRejected';
      const timeout = limits.WriteBehavior === ContextSynchronizationWriteBehavior.Wait
        ? limits.SynchronizationWaitTimeoutMs : this.options.AdmissionTimeoutMs;
      const rejected = () => this.synchronizations.has(id)
        ? new ContextMutationResult(ContextMutationStatus.Synchronizing, changes.ExpectedRevision, 'Session index synchronization has closed write admission.')
        : new ContextMutationResult(ContextMutationStatus.AdmissionRejected, changes.ExpectedRevision, 'Session commit gate is busy.');
      return queue && timeout > 0
        ? this.resumeAfterGate((deadline) => this.applySessionCore(changes, false, undefined, deadline), rejected, timeout)
        : rejected();
    }
    if (!this.store.tryFind(id)) {
      if (diagnostics) diagnostics.Disposition = 'NotFound';
      return new ContextMutationResult(ContextMutationStatus.NotFound, 0);
    }
    if (limits && this.synchronizations.has(id) && !this.waitForPartitionAdmission(id, gateDeadline)) {
      if (diagnostics) diagnostics.Disposition = 'SynchronizationRejected';
      return new ContextMutationResult(ContextMutationStatus.Synchronizing, changes.ExpectedRevision, 'Session index synchronization has closed write admission.');
    }
    const captured = this.store.capture(id);
    if (!captured) {
      if (diagnostics) diagnostics.Disposition = 'NotFound';
      return new ContextMutationResult(ContextMutationStatus.NotFound, 0);
    }
    const current = captured.Session;
    if (!isInt64(changes.ExpectedRevision) || compareInt64(current.Revision, changes.ExpectedRevision) !== 0) {
      if (diagnostics) diagnostics.Disposition = 'InitialRevisionConflict';
      return new ContextMutationResult(ContextMutationStatus.RevisionConflict, current.Revision);
    }
    let reservation = 0n;
    let ownsGate = false;
    let synchronizeAfter = false;
    let deferredCleanup = false;
    const epoch = this.synchronizationEpochs.get(id) ?? 0;
    const previousIndex = this.indexes.get(id)!;
    if (limits) this.partitionPreparations.set(id, (this.partitionPreparations.get(id) ?? 0) + 1);
    try {
      const serialized = selected ?? this.execution?.SelectSerializedPreparation() ?? this.options.SerializeSessionPreparation;
      const gateStart = diagnostics && serialized ? performance.now() : 0;
      if (diagnostics && serialized) diagnostics.GateAttempted = true;
      if (serialized && this.sessionCommits.has(id)) {
        if (diagnostics) {
          diagnostics.GateMs = performance.now() - gateStart;
          diagnostics.Disposition = 'GateRejected';
        }
        const rejected = () => new ContextMutationResult(ContextMutationStatus.AdmissionRejected, current.Revision, 'Session commit gate is busy.');
        return queue && !limits && this.options.AdmissionTimeoutMs > 0
          ? this.resumeAfterGate(() => this.applySessionCore(changes, false, serialized), rejected)
          : rejected();
      }
      if (serialized) {
        this.sessionCommits.add(id);
        ownsGate = true;
        if (diagnostics) diagnostics.GateMs = performance.now() - gateStart;
      }
      if (limits) {
        const bytes = this.preparationBytes(changes);
        if (bytes > limits.MaximumEstimatedPreparationBytes || !this.waitForResidentBudget(bytes)) {
          if (diagnostics) diagnostics.Disposition = 'ResourceRejected';
          return new ContextMutationResult(ContextMutationStatus.AdmissionRejected, current.Revision, 'Preconstruction reservation unavailable or oversized.');
        }
        reservation = bytes;
        this.estimatedPreparationBytes += bytes;
      }
      if (queue && !serialized) {
        const input = this.store.entryPreparationInput(changes, captured);
        if (input) {
          let complete = reply!;
          const response = reply ? undefined : new Promise<IContextMutationResult>((resolve, reject) => { complete = { resolve, reject }; });
          const release = () => this.releasePreparation(id, reservation, false, !!limits, synchronizeAfter);
          const finish = (entryPreparation?: EntryPreparationOutput) => {
            let result;
            try {
              this.ensureUsable();
              // Replay failures inline so earlier collector or memo calls retain their original ordering.
              const candidate = this.execution && entryPreparation && 'Error' in entryPreparation ? undefined : entryPreparation;
              result = this.commitSession(changes, captured, previousIndex, reservation, false, epoch, !limits, undefined, candidate);
            } catch (error) {
              if (this.disposed) { release(); complete.reject(error); return; }
              if (error instanceof PartitionCapacityException) {
                synchronizeAfter = error.CanSynchronize;
                result = new ContextMutationResult(error.CanSynchronize ? ContextMutationStatus.SynchronizationRequired :
                  ContextMutationStatus.AdmissionRejected, current.Revision, error.message);
              } else result = new ContextMutationResult(ContextMutationStatus.InvalidOperation, current.Revision, (error as Error).message);
            }
            if (result instanceof Promise) {
              void result.then((value) => { release(); complete.resolve(value); }, (error) => { release(); complete.reject(error); });
            } else {
              release();
              complete.resolve(result);
            }
          };
          try {
            this.entryPreparationWorkers ??= new EntryPreparationWorkers(this.mailbox ??= new OwnerMailbox());
            if (this.entryPreparationWorkers.trySubmit(input, { resolve: finish, reject: () => finish() })) {
              deferredCleanup = true;
              return response;
            }
          } catch { /* The same candidate can still be prepared locally. */ }
        }
      }
      return this.commitSession(changes, captured, previousIndex, reservation, ownsGate, epoch, queue && !limits, diagnostics);
    } catch (error) {
      if (error instanceof PartitionCapacityException) {
        if (diagnostics) diagnostics.Disposition = error.CanSynchronize ? 'SynchronizationRejected' : 'ResourceRejected';
        synchronizeAfter = error.CanSynchronize;
        return new ContextMutationResult(error.CanSynchronize ? ContextMutationStatus.SynchronizationRequired :
          ContextMutationStatus.AdmissionRejected, current.Revision, error.message);
      }
      return new ContextMutationResult(ContextMutationStatus.InvalidOperation, current.Revision, (error as Error).message);
    } finally {
      if (!deferredCleanup) this.releasePreparation(id, reservation, ownsGate, !!limits, synchronizeAfter);
    }
  }

  private releasePreparation(id: Guid, reservation: bigint, ownsGate: boolean, partitioned: boolean, synchronizeAfter: boolean): void {
    if (!this.disposed) this.estimatedPreparationBytes -= reservation;
    if (ownsGate) this.sessionCommits.delete(id);
    if (partitioned) {
      const remaining = this.partitionPreparations.get(id)! - 1;
      if (remaining === 0) {
        this.partitionPreparations.delete(id);
        this.schedulePartitionWork();
      } else this.partitionPreparations.set(id, remaining);
    }
    if (synchronizeAfter && !this.disposed && this.store.capture(id)) void this.synchronizeIndexAsync(id);
  }

  private preparationBytes(changes: ContextChangeSet): bigint {
    if (!Array.isArray(changes.Changes) || !changes.Changes.length) throw new TypeError('Empty session change.');
    let bytes = 4096n;
    const add = (keys: readonly string[] | undefined) => {
      if (keys == null) throw new TypeError('Producer-owned entries require keys.');
      bytes = checkedInt64(bytes + 8192n + 2n * BigInt(this.options.MaximumEstimatedBytesPerSegment) + 8n * BigInt(estimateTermBytes(keys)));
    };
    for (const change of changes.Changes as ContextChangeSet['Changes']) {
      bytes += 8192n + 16n * BigInt(this.options.MaximumEntriesPerSegment);
      switch (change.kind) {
        case 'AppendEntries':
        case 'ReplaceSegment':
          for (const entry of change.Entries) add(entry.IndexKeys);
          break;
        case 'ReplaceEntry':
          add(change.IndexKeys);
          break;
        case 'PutAnchor': {
          const anchor = change.Anchor;
          const length = anchor.Title.length + anchor.Summary.length + 2 + anchor.Topics.join(' ').length;
          bytes += 8n * BigInt(128 + 2 * length + (anchor.IndexKeys ? estimateTermBytes(anchor.IndexKeys) : 0));
          break;
        }
      }
    }
    return checkedInt64(bytes);
  }

  private commitSession(changes: ContextChangeSet, captured: SessionRoot, previous: SessionIndex, reservation: bigint,
    serialized: boolean, epoch: Int64, queue: boolean, diagnostics?: MutationDiagnostics,
    entryPreparation?: EntryPreparationOutput): IContextMutationResult | Promise<IContextMutationResult> {
    const id = changes.SessionId;
    const started = diagnostics ? performance.now() : 0;
    if (diagnostics) diagnostics.PreparationStarted = true;
    let change, prepared;
    try {
      const candidate = this.prepareIndex(previous);
      change = (entryPreparation && this.store.acceptEntryPreparation(captured, entryPreparation, candidate.Edits)) ??
        this.store.prepareSession(changes, captured, candidate.Edits);
      if (!('publish' in change)) {
        if (diagnostics) diagnostics.Disposition = 'InvalidPreparation';
        return change;
      }
      prepared = candidate.finish(change.Next.Session, change.Next.Partitions);
      if (diagnostics) diagnostics.Prepared = true;
    } finally {
      if (diagnostics) diagnostics.PreparationMs = performance.now() - started;
    }
    const candidateChange = change;
    const preparedIndex = prepared;
    const reject = (status: ContextMutationStatus, error?: string, revision = captured.Session.Revision) =>
      new ContextMutationResult(status, revision, error);
    const gateRejected = () => {
      if (diagnostics) diagnostics.Disposition = 'GateRejected';
      return reject(ContextMutationStatus.AdmissionRejected, 'Session commit gate is busy.');
    };
    const publish = () => {
      if (!serialized) {
        const gateStart = diagnostics ? performance.now() : 0;
        if (diagnostics) diagnostics.GateAttempted = true;
        if (this.sessionCommits.has(id)) {
          if (diagnostics) diagnostics.GateMs = performance.now() - gateStart;
          return gateRejected();
        }
        this.sessionCommits.add(id);
        if (diagnostics) diagnostics.GateMs = performance.now() - gateStart;
      }
      let resourceStart: number | undefined;
      try {
        const live = this.store.capture(id);
        if (!live) {
          if (diagnostics) diagnostics.Disposition = 'NotFound';
          return reject(ContextMutationStatus.NotFound);
        }
        if (this.options.PartitionedIndex && (this.synchronizations.has(id) || (this.synchronizationEpochs.get(id) ?? 0) !== epoch)) {
          if (diagnostics) diagnostics.Disposition = 'SynchronizationRejected';
          return reject(ContextMutationStatus.SynchronizationRequired, 'Preparation crossed an index synchronization fence.');
        }
        if (live.Session !== captured.Session) {
          if (diagnostics) diagnostics.Disposition = serialized ? 'GatedRevisionConflict' : 'PreparedRevisionConflict';
          return reject(ContextMutationStatus.RevisionConflict, undefined, live.Session.Revision);
        }
        if (diagnostics) resourceStart = performance.now();
        const liveIndex = this.indexes.get(id)!;
        const next = liveIndex === previous ? preparedIndex :
          { ...preparedIndex, Index: preparedIndex.Index.mergeDeferredProgress(previous, liveIndex) };
        const indexDelta = next.Index.EstimatedBytes - liveIndex.EstimatedBytes;
        if (reservation && candidateChange.Delta + indexDelta > reservation) {
          if (diagnostics) diagnostics.Disposition = 'ResourceRejected';
          return reject(ContextMutationStatus.AdmissionRejected, 'Candidate exceeded its preparation reservation.');
        }
        const work = this.workBytes(preparedIndex.Jobs);
        if (!this.canReserveJobs(preparedIndex.Jobs.length, work)) {
          if (diagnostics) diagnostics.Disposition = 'ResourceRejected';
          return reject(ContextMutationStatus.AdmissionRejected, 'Deferred indexing backlog or work budget exhausted.');
        }
        if (!this.waitForResidentBudget(candidateChange.Delta + indexDelta + work - reservation)) {
          if (diagnostics) diagnostics.Disposition = 'ResourceRejected';
          return reject(ContextMutationStatus.AdmissionRejected, 'Resident budget exhausted.');
        }
        if (!this.canReserveJobs(preparedIndex.Jobs.length, work)) {
          if (diagnostics) diagnostics.Disposition = 'ResourceRejected';
          return reject(ContextMutationStatus.AdmissionRejected, 'Deferred indexing backlog or work budget exhausted.');
        }
        const result = candidateChange.publish();
        this.publishIndex(id, next);
        this.publishedMutations = incrementCounter(this.publishedMutations);
        if (diagnostics) diagnostics.Disposition = 'Applied';
        return result;
      } catch (error) {
        return reject(ContextMutationStatus.InvalidOperation, (error as Error).message);
      } finally {
        if (diagnostics && resourceStart !== undefined) diagnostics.ResourceMs = performance.now() - resourceStart;
        if (!serialized) this.sessionCommits.delete(id);
      }
    };
    return !serialized && queue && this.sessionCommits.has(id) && this.options.AdmissionTimeoutMs > 0
      ? this.resumeAfterGate(publish, gateRejected)
      : publish();
  }

  private prepareIndex(previous?: SessionIndex) {
    return SessionIndex.prepare(this.options, previous, (characters) => {
      const work = BigInt(indexWorkReservation(characters));
      return this.canReserveJobs(1, work) && this.canAdmit(work + BigInt(indexRetentionReservation(characters)));
    }, this.execution);
  }

  private workBytes(jobs: readonly IndexJob[]): bigint {
    return jobs.reduce((sum, job) => sum + BigInt(job.Pending.WorkBytes), 0n);
  }

  private canReserveJobs(count: number, bytes: bigint): boolean {
    const limits = this.options.DeferredIndexing;
    return count === 0 || (!!limits && this.indexWorkerFailure === null && count <= limits.MaximumPendingEntries - this.indexJobs.length &&
      bytes + this.estimatedIndexWorkBytes <= limits.MaximumEstimatedWorkBytes);
  }

  private waitForResidentBudget(delta: bigint): boolean {
    const deadline = performance.now() + this.options.AdmissionTimeoutMs;
    while (!this.canAdmit(delta)) {
      if (this.options.PartitionedIndex && !this.partitionInFlight && performance.now() < deadline &&
          this.beginPartitionWork() && !this.partitionInFlight) continue;
      if (!this.mailbox?.wait(deadline)) return false;
      this.ensureUsable();
    }
    return true;
  }

  private publishIndex(id: Guid, next: PreparedSessionIndex): void {
    this.estimatedIndexBytes += next.Index.EstimatedBytes - (this.indexes.get(id)?.EstimatedBytes ?? 0n);
    this.indexes.set(id, next.Index);
    for (const job of next.Jobs) {
      this.indexJobs.push(job);
      this.estimatedIndexWorkBytes += BigInt(job.Pending.WorkBytes);
      this.jobsBySession.set(id, (this.jobsBySession.get(id) ?? 0) + 1);
    }
    this.scheduleIndexWork();
    this.pulseIndexWaiters();
  }

  private scheduleIndexWork(): void {
    if (this.disposed || this.indexWorkerFailure !== null || this.indexWorker !== undefined ||
        this.nativeIndexJob || !this.indexJobs.length) return;
    if (!this.execution || this.execution.CanCollectInWorker) {
      const job = this.indexJobs[0];
      if (!this.indexes.get(job.SessionId)?.isCurrent(job)) {
        this.indexWorker = setImmediate(() => {
          this.indexWorker = undefined;
          this.finishIndexJob(job);
        });
        return;
      }
      let prepared: ReturnType<ContextExecution['BeginBackgroundCollection']> | undefined;
      try {
        prepared = this.execution?.BeginBackgroundCollection(job.Pending.Content);
      } catch (error) {
        this.indexWorker = setImmediate(() => {
          this.indexWorker = undefined;
          this.finishIndexJob(job, { Error: this.indexError(error) });
        });
        return;
      }
      if (prepared?.Cached) {
        const terms = prepared.Cached;
        this.indexWorker = setImmediate(() => {
          this.indexWorker = undefined;
          this.finishIndexJob(job, { Terms: terms });
        });
        return;
      }
      try {
        this.nativeIndexThread ??= new IndexMaintenanceThread(this.mailbox ??= new OwnerMailbox(),
          (result) => this.finishNativeIndex(result), (error) => this.failIndexWorker(error));
        this.nativeIndexJob = job;
        this.nativeIndexMemoKey = prepared?.MemoKey;
        this.nativeIndexThread.submit({
          Kind: 'Terms', Parts: textParts(job.Pending.Content), Offset: job.Pending.Offset, Prefix: job.Pending.Prefix,
          Collector: prepared?.Collector,
        });
      } catch (error) {
        this.failIndexWorker(error);
      }
      return;
    }
    this.indexWorker = setImmediate(() => {
      this.indexWorker = undefined;
      this.finishIndexJob(this.indexJobs[0]);
    });
  }

  private finishNativeIndex(result: NativeIndexOutput): void {
    const job = this.nativeIndexJob;
    if (!job || this.disposed) return;
    if (this.sessionCommits.has(job.SessionId)) {
      this.indexWorker = setImmediate(() => {
        this.indexWorker = undefined;
        this.finishNativeIndex(result);
      });
      return;
    }
    this.nativeIndexJob = undefined;
    const memoKey = this.nativeIndexMemoKey;
    this.nativeIndexMemoKey = undefined;
    if ('Terms' in result && this.execution) {
      try {
        this.execution.FinishBackgroundCollection(memoKey, Object.freeze(result.Terms));
      } catch (error) {
        result = { Error: this.indexError(error) };
      }
    }
    this.finishIndexJob(job, result);
  }

  private finishIndexJob(job: IndexJob, collected?: NativeIndexOutput): void {
    try {
      const index = this.indexes.get(job.SessionId);
      if (!index?.isCurrent(job)) {
        this.discardedIndexJobs = incrementCounter(this.discardedIndexJobs);
        return;
      }
      let next: SessionIndex;
      try {
        if (collected && 'Error' in collected) throw new Error(collected.Error);
        const terms = collected && Object.freeze(collected.Terms);
        next = index.complete(job, undefined, this.execution, terms);
        if (next.EstimatedBytes > index.EstimatedBytes) throw new RangeError('Deferred index exceeded its reserved estimate.');
        this.completedIndexJobs = incrementCounter(this.completedIndexJobs);
      } catch (error) {
        next = index.complete(job, this.indexError(error));
      }
      this.estimatedIndexBytes += next.EstimatedBytes - index.EstimatedBytes;
      this.indexes.set(job.SessionId, next);
    } catch (error) {
      this.failIndexWorker(error);
    } finally {
      if (this.indexWorkerFailure === null) {
        this.indexJobs.shift();
        this.estimatedIndexWorkBytes -= BigInt(job.Pending.WorkBytes);
        const count = this.jobsBySession.get(job.SessionId)!;
        if (count === 1) this.jobsBySession.delete(job.SessionId);
        else this.jobsBySession.set(job.SessionId, count - 1);
        this.scheduleIndexWork();
        this.pulseIndexWaiters();
      }
    }
  }

  private failIndexWorker(error: unknown): void {
    if (this.disposed || this.indexWorkerFailure !== null) return;
    this.indexWorkerFailure = this.indexError(error);
    this.nativeIndexJob = undefined;
    this.nativeIndexMemoKey = undefined;
    this.indexJobs.length = 0;
    this.jobsBySession.clear();
    this.estimatedIndexWorkBytes = 0n;
    this.pulseIndexWaiters();
  }

  private indexError(error: unknown): string {
    try { return (error instanceof Error ? error.message : String(error)).slice(0, 160); }
    catch { return 'Indexing failed.'; }
  }

  private pulseIndexWaiters(): void {
    for (const notify of this.indexWaiters) notify();
    this.indexWaiters.clear();
  }

  public applyMemory(changes: MemoryChangeSet): IContextMutationResult {
    this.ensureUsable();
    const prepared = this.memoryStore.prepare(changes, (memory) => this.validateMemorySources(memory));
    return 'publish' in prepared ? this.commitMemory(prepared) : prepared;
  }

  public applyMemoryFromWorker(changes: MemoryChangeSet): IContextMutationResult | Promise<IContextMutationResult> {
    this.ensureUsable();
    const prepared = this.memoryStore.prepare(changes, (memory) => this.validateMemorySources(memory));
    if (!('publish' in prepared)) return prepared;
    if (!this.memoryCommit || this.options.AdmissionTimeoutMs === 0) return this.commitMemory(prepared);
    return this.resumeAfterGate(() => this.commitMemory(prepared), () => this.memoryGateRejected(prepared));
  }

  private memoryGateRejected(prepared: PreparedMemoryChange): IContextMutationResult {
    return new ContextMutationResult(ContextMutationStatus.AdmissionRejected, prepared.PreviousRevision, 'Memory commit gate is busy.');
  }

  private commitMemory(prepared: PreparedMemoryChange): IContextMutationResult {
    if (this.memoryCommit) return this.memoryGateRejected(prepared);
    this.memoryCommit = true;
    try {
      if (this.memoryStore.Revision !== prepared.PreviousRevision) {
        return new ContextMutationResult(ContextMutationStatus.RevisionConflict, this.memoryStore.Revision);
      }
      if (!this.waitForResidentBudget(prepared.Delta)) {
        return new ContextMutationResult(ContextMutationStatus.AdmissionRejected, prepared.PreviousRevision, 'Resident budget exhausted.');
      }
      const result = prepared.publish();
      this.publishedMutations = incrementCounter(this.publishedMutations);
      return result;
    } finally {
      this.memoryCommit = false;
    }
  }

  private validateMemorySources(memory: ContextMemory): void {
    if (memory.Scope.SessionId != null) {
      const scoped = this.store.tryFind(canonicalGuid(memory.Scope.SessionId));
      if (!scoped || !Matches(memory.Scope, scoped)) throw new TypeError('Memory scope does not match its session.');
    }
    for (const source of memory.Sources) {
      const session = source && this.store.tryFind(canonicalGuid(source.SessionId));
      const anchor = session?.Anchors.get(source.AnchorId);
      if (!session || !anchor || !Matches(memory.Scope, session)) {
        throw new TypeError('Memory provenance does not resolve in its scope.');
      }
      const entries = this.indexes.get(session.SessionId)!;
      if (!entries.find(anchor.StartEntryId) || !entries.find(anchor.EndEntryId) ||
          (anchor.PinnedRevision != null && anchor.PinnedRevision !== session.Revision)) {
        throw new TypeError('Memory provenance target is unavailable.');
      }
    }
  }

  public openRead(sessionId: Guid): ContextReadLease {
    this.ensureUsable();
    sessionId = canonicalGuid(sessionId);
    const current = this.store.tryFind(sessionId);
    if (!current) {
      throw new ContextError('NotFound', `Session ${sessionId} was not found.`);
    }
    if (current.Status === 'Expired') {
      throw new ContextError('InvalidOperation', 'Session expired.');
    }
    const index = this.indexes.get(sessionId)!;
    const memory = this.memoryStore.values();
    const memoryRevision = this.memoryStore.Revision;
    const memoryBytes = this.memoryStore.EstimatedBytes;
    const sessionBytes = this.store.estimate(sessionId) + index.EstimatedBytes;
    const now = this.options.TimeProvider.now();
    const deadline = performance.now() + this.options.AdmissionTimeoutMs;
    for (;;) {
      this.ensureUsable();
      const extra = (this.retainedRoots.has(index) ? 0n : sessionBytes) +
        (this.retainedRoots.has(memory) ? 0n : memoryBytes);
      const retained = this.retainedRootBytes + this.estimateViewBytes + extra;
      if (this.retainedReads < this.options.MaximumRetainedReads &&
          retained <= this.options.MaximumEstimatedRetainedBytes &&
          this.activeBytes() + retained <= this.options.EstimatedResidentByteBudget) break;
      if (!this.mailbox?.wait(deadline)) throw new ContextError('InvalidOperation', 'Read-retention budget exhausted.');
    }

    const lease = new ContextReadLease(current, memoryRevision, () => {
      this.retainedReads--;
      this.releaseRoot(index);
      this.releaseRoot(memory);
    }, this.indexingMode, memory, index, now);
    this.retainRoot(index, sessionBytes);
    this.retainRoot(memory, memoryBytes);
    this.retainedReads++;
    return lease;
  }

  attachAdmissionPeer(dispatch: (value: unknown) => void): ReturnType<OwnerMailbox['attach']> {
    this.ensureUsable();
    return (this.mailbox ??= new OwnerMailbox()).attach(dispatch);
  }

  connectWorker(allowWorkerProjectionEstimator = false): WorkerContextEndpoint {
    this.ensureUsable();
    return attachWorkerContextPeer(this.mailbox ??= new OwnerMailbox(), {
      defaultProjectionEstimator: this.options.ProjectionSizeEstimator === defaultLLMContextOptions.ProjectionSizeEstimator,
      allowWorkerProjectionEstimator,
      maximumViewResults: this.options.MaximumViewResults,
    }, this);
  }

  private retainRoot(root: object, bytes: bigint): void {
    const previous = this.retainedRoots.get(root);
    if (previous) previous.Count++;
    else {
      this.retainedRoots.set(root, { Count: 1, Bytes: bytes });
      this.retainedRootBytes += bytes;
    }
  }

  private releaseRoot(root: object): void {
    const retained = this.retainedRoots.get(root)!;
    if (--retained.Count === 0) {
      this.retainedRoots.delete(root);
      this.retainedRootBytes -= retained.Bytes;
    }
  }

  public retainOutput(bytes: bigint): () => void {
    const deadline = performance.now() + this.options.AdmissionTimeoutMs;
    for (;;) {
      this.ensureUsable();
      const retained = checkedInt64(this.retainedRootBytes + this.estimateViewBytes + bytes);
      if (retained <= this.options.MaximumEstimatedRetainedBytes &&
          checkedInt64(this.activeBytes() + retained) <= this.options.EstimatedResidentByteBudget) break;
      if (!this.mailbox?.wait(deadline)) throw new ContextError('InvalidOperation', 'Projected-view budget exhausted.');
    }
    this.estimateViewBytes += bytes;
    return () => { this.estimateViewBytes -= bytes; };
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

  public async waitForIndexingAsync(sessionId: Guid, expectedRevision: Int64, signal?: AbortSignal): Promise<void> {
    sessionId = canonicalGuid(sessionId);
    for (;;) {
      signal?.throwIfAborted();
      this.ensureUsable();
      const status = this.indexes.get(sessionId)?.Status;
      if (!status) throw new ContextError('NotFound', `Session ${sessionId} was not found.`);
      if (!isInt64(expectedRevision) || compareInt64(status.SessionRevision, expectedRevision) !== 0) {
        throw new ContextError('InvalidOperation', 'Session revision changed while waiting for indexing.');
      }
      if (this.indexWorkerFailure !== null) throw new ContextError('InvalidOperation', this.indexWorkerFailure);
      if (status.Error !== null) throw new ContextError('InvalidOperation', status.Error);
      if (status.IsComplete && !this.jobsBySession.has(sessionId)) return;
      await new Promise<void>((resolve, reject) => {
        const change = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          this.indexWaiters.delete(change);
          reject(signal!.reason);
        };
        this.indexWaiters.add(change);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }

  public async synchronizeIndexAsync(sessionId: Guid, signal?: AbortSignal): Promise<ContextIndexSynchronization> {
    sessionId = canonicalGuid(sessionId);
    signal?.throwIfAborted();
    this.ensureUsable();
    const limits = this.options.PartitionedIndex;
    if (!limits) throw new ContextError('NotSupported', 'Enable partitioned indexing through the factory.');
    if (this.sessionCommits.has(sessionId)) {
      await waitWithSignal(new Promise<void>((resolve) => setImmediate(resolve)), signal);
      return this.synchronizeIndexAsync(sessionId, signal);
    }
    const current = this.store.tryFind(sessionId);
    if (!current) throw new ContextError('NotFound', `Session ${sessionId} was not found.`);
    const outstanding = this.synchronizations.get(sessionId);
    if (outstanding) return waitWithSignal(outstanding.Promise, signal);
    const clean = {
      SessionId: sessionId, Generation: this.synchronizationEpochs.get(sessionId) ?? 0,
      ContentRevision: current.Revision, PartitionsCompacted: 0, Succeeded: true, Error: null,
    };
    if (![...this.store.partitions(sessionId).values()].some((partition) => partition.Overrides.size)) return clean;
    if (this.synchronizations.size >= limits.MaximumPendingSynchronizations) {
      return { ...clean, Succeeded: false, Error: 'Synchronization backlog is full.' };
    }
    let resolve!: Synchronization['Resolve'];
    const completion = new Promise<ContextIndexSynchronization>((done) => { resolve = done; });
    const epoch = advanceInt64(clean.Generation);
    this.synchronizationEpochs.set(sessionId, epoch);
    this.synchronizations.set(sessionId, {
      SessionId: sessionId, Revision: current.Revision, Epoch: epoch,
      Promise: completion, Resolve: resolve, PartitionsCompacted: 0, After: -1,
    });
    this.schedulePartitionWork();
    return waitWithSignal(completion, signal);
  }

  private schedulePartitionWork(): void {
    if (this.disposed || this.partitionWorker !== undefined || this.partitionInFlight || !this.synchronizations.size) return;
    this.partitionWorker = setImmediate(() => {
      this.partitionWorker = undefined;
      if (this.beginPartitionWork()) this.schedulePartitionWork();
    });
  }

  private beginPartitionWork(): boolean {
    if (this.partitionInFlight) return false;
    const work = this.synchronizations.values().next().value;
    if (!work || this.partitionPreparations.has(work.SessionId)) return false;
    try {
      let dirty: Int64 | undefined;
      for (const [id, partition] of this.store.partitions(work.SessionId)) {
        if (id > work.After && partition.Overrides.size && (dirty === undefined || id < dirty)) dirty = id;
      }
      if (dirty === undefined) {
        this.finishSynchronization(work);
        return true;
      }
      this.beforePartitionCompaction?.(work.SessionId, dirty);
      const { Contributions, Overrides } = this.store.partitions(work.SessionId).get(dirty)!;
      this.partitionThread ??= new IndexMaintenanceThread(this.mailbox ??= new OwnerMailbox(),
        (result) => this.finishPartitionWork(result), (error) => this.failPartitionThread(error));
      this.partitionInFlight = { work, segmentId: dirty };
      this.partitionThread.submit({ Kind: 'Partition', Contributions, Overrides });
    } catch (error) {
      this.partitionInFlight = undefined;
      this.finishSynchronization(work, this.indexError(error));
    }
    return true;
  }

  private finishPartitionWork(result: PartitionIndexOutput): void {
    const pending = this.partitionInFlight;
    if (!pending || this.disposed) return;
    this.partitionInFlight = undefined;
    const { work, segmentId } = pending;
    try {
      if ('Error' in result) throw new Error(result.Error);
      const { Contributions, Search, BaseBytes } = result.Partition;
      const replacement = new ContextIndexPartition(Contributions, Search, new Map(), BaseBytes, 0);
      const compaction = this.store.prepareCompaction(work.SessionId, segmentId, replacement);
      const next = this.indexes.get(work.SessionId)!.withPartitions(compaction.partitions);
      compaction.publish();
      this.indexes.set(work.SessionId, next);
      work.After = segmentId;
      work.PartitionsCompacted++;
    } catch (error) {
      this.finishSynchronization(work, this.indexError(error));
    }
    this.schedulePartitionWork();
  }

  private failPartitionThread(error: unknown): void {
    this.partitionThread?.dispose();
    this.partitionThread = undefined;
    this.partitionInFlight = undefined;
    for (const work of this.synchronizations.values()) this.finishSynchronization(work, this.indexError(error));
  }

  private finishSynchronization(work: Synchronization, error: string | null = null): void {
    this.synchronizations.delete(work.SessionId);
    work.Resolve({
      SessionId: work.SessionId, ContentRevision: work.Revision, Generation: work.Epoch,
      PartitionsCompacted: work.PartitionsCompacted, Succeeded: error === null, Error: error,
    });
  }

  private waitForPartitionAdmission(sessionId: Guid, gateDeadline?: number): boolean {
    const limits = this.options.PartitionedIndex!;
    if (limits.WriteBehavior === ContextSynchronizationWriteBehavior.Reject) return false;
    const deadline = gateDeadline ?? performance.now() + limits.SynchronizationWaitTimeoutMs;
    while (this.synchronizations.has(sessionId) && performance.now() < deadline) {
      if (this.partitionInFlight) {
        if (!this.mailbox?.wait(deadline)) break;
        this.ensureUsable();
      } else if (!this.beginPartitionWork()) break;
    }
    return !this.synchronizations.has(sessionId);
  }

  private activeBytes(): bigint {
    return this.store.ActiveBytes + this.estimatedPreparationBytes + this.memoryStore.EstimatedBytes +
      this.estimatedIndexBytes + this.estimatedIndexWorkBytes + this.estimatedSynchronizationReserveBytes +
      BigInt(this.options.PartitionedIndex ? partitionInfrastructureBytes(this.options.PartitionedIndex) : 0) +
      BigInt(this.options.DeferredIndexing && this.options.Execution.Indexing !== ContextIndexingStrategy.Synchronous ?
        deferredInfrastructureBytes(this.options.DeferredIndexing.MaximumPendingEntries) : 0) + BigInt(this.recipe?.ReservedBytes ?? 0);
  }

  public getStatistics(): LLMContextStatistics {
    this.ensureUsable();
    const estimatedRetainedBytes = this.retainedRootBytes + this.estimateViewBytes;
    return {
      Sessions: this.store.Count,
      EstimatedActiveBytes: canonicalInt64(this.activeBytes()),
      EstimatedRetainedBytes: canonicalInt64(estimatedRetainedBytes),
      RetainedReads: this.retainedReads,
      MemoryRevision: this.memoryStore.Revision,
      PublishedMutations: this.publishedMutations,
      SegmentsRewritten: this.store.SegmentsRewritten,
      EstimatedSegmentBytesRewritten: canonicalInt64(this.store.SegmentBytesRewritten),
      EstimatedViewBytes: canonicalInt64(this.estimateViewBytes),
      PendingIndexWork: this.indexJobs.length,
      EstimatedIndexWorkBytes: canonicalInt64(this.estimatedIndexWorkBytes),
      CompletedIndexJobs: this.completedIndexJobs,
      DiscardedIndexJobs: this.discardedIndexJobs,
      EstimatedSynchronizationReserveBytes: canonicalInt64(this.estimatedSynchronizationReserveBytes),
      EstimatedPreparationBytes: canonicalInt64(this.estimatedPreparationBytes),
      PendingSynchronizations: this.synchronizations.size,
      Execution: this.execution?.Statistics ?? null,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entryPreparationWorkers?.dispose();
    this.entryPreparationWorkers = undefined;
    this.nativeIndexThread?.dispose();
    this.nativeIndexThread = undefined;
    this.nativeIndexJob = undefined;
    this.nativeIndexMemoKey = undefined;
    this.partitionThread?.dispose();
    this.partitionThread = undefined;
    this.partitionInFlight = undefined;
    this.mailbox?.dispose();
    this.mailbox = undefined;
    if (this.indexWorker !== undefined) clearImmediate(this.indexWorker);
    this.indexWorker = undefined;
    this.indexJobs.length = 0;
    this.jobsBySession.clear();
    this.estimatedIndexBytes = 0n;
    this.estimatedIndexWorkBytes = 0n;
    this.completedIndexJobs = 0;
    this.discardedIndexJobs = 0;
    this.estimatedSynchronizationReserveBytes = 0n;
    this.estimatedPreparationBytes = 0n;
    if (this.partitionWorker !== undefined) clearImmediate(this.partitionWorker);
    this.partitionWorker = undefined;
    for (const work of this.synchronizations.values()) this.finishSynchronization(work, 'Context owner disposed during synchronization.');
    this.synchronizationEpochs.clear();
    this.store.clear();
    this.memoryStore.clear();
    this.indexes.clear();
    this.publishedMutations = 0;
    this.pulseIndexWaiters();
    this.execution?.dispose();
  }

  private ensureUsable(): void {
    if (this.disposed) throw new ContextError('Disposed', 'This context owner has been disposed.');
  }

  private canAdmit(delta: bigint): boolean {
    return checkedInt64(this.activeBytes() + this.retainedRootBytes + this.estimateViewBytes + delta) <=
      this.options.EstimatedResidentByteBudget;
  }

}
