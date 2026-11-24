// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { MessageChannel, MessagePort, receiveMessageOnPort, threadId } from 'node:worker_threads';
import { ContextError, type ContextErrorCode } from '../domain/errors.js';
import { canonicalGuid } from '../domain/guid.js';
import { ImmutableMap } from '../domain/immutable-map.js';
import { ContextIndexKeys, type ContextIndexingMode } from '../domain/index-keys.js';
import { canonicalInt64, checkedInt64, isInt64, isPositiveInt64, type Int64 } from '../domain/int64.js';
import type { ContextCursor, ContextPage, ILLMContextReadLease, ILLMContextView, ILLMContextViewDefinition, LLMContextStatistics } from '../domain/reads.js';
import {
  type ContextChangeSet, type ContextContent,
  type AnchorResolution, type ContextEntry, type ContextIndexedSearchResult, type ContextIndexStatus,
  type ContextMemory, type ContextSearchHit, type Guid, type IContextMutationResult, type LLMSessionContext,
  type MemoryChangeSet, type MemoryScope,
} from '../domain/session.js';
import type { ContextReadLease } from '../storage/lease.js';
import type { ContextIndexSynchronization } from '../storage/partitioned-index.js';
import { defaultLLMContextOptions } from '../options.js';
import type { OwnerMailbox } from './owner-mailbox.js';
import { withCurrentRead } from './current-read.js';
import { restoreWireContent } from './wire-content.js';

export type WorkerContextEndpoint = ReturnType<OwnerMailbox['attach']> & {
  readonly response: Int32Array;
  readonly ownerThreadId: number;
  readonly defaultProjectionEstimator: boolean;
  readonly allowWorkerProjectionEstimator?: boolean;
  readonly maximumViewResults: number;
};

export interface WorkerContextEndpointOptions {
  /** Authorizes the trusted peer to estimate its own view output instead of using the owner configuration. */
  readonly AllowWorkerProjectionEstimator?: boolean;
}

export interface WorkerContextPeerOptions {
  readonly ProjectionSizeEstimator?: (item: unknown) => Int64;
}

interface CapturedLease {
  readonly id: number;
  readonly revision: Int64;
  readonly memoryRevision: Int64;
  readonly indexingMode: ContextIndexingMode;
}

type Request =
  | { kind: 'statistics' }
  | { kind: 'findSession'; sessionId: Guid }
  | { kind: 'createSession'; session: LLMSessionContext }
  | { kind: 'open'; sessionId: Guid }
  | { kind: 'retainView'; id: number; count: number; bytes: Int64 }
  | { kind: 'session'; id: number }
  | { kind: 'indexStatus' | 'release'; id: number }
  | { kind: 'range'; id: number; from: Int64; count: number }
  | { kind: 'entry'; id: number; entryId: Guid }
  | { kind: 'page'; id: number; cursor: ContextCursor | null; count: number }
  | { kind: 'search' | 'searchIndexed'; id: number; query: string; limit: number }
  | { kind: 'searchKeys'; id: number; keys: readonly string[]; limit: number }
  | { kind: 'anchor'; id: number; anchorId: Guid }
  | { kind: 'memory'; id: number; scopes: readonly MemoryScope[] }
  | { kind: 'apply'; changes: ContextChangeSet }
  | { kind: 'applyMemory'; changes: MemoryChangeSet }
  | { kind: 'remove'; sessionId: Guid; expectedRevision: Int64 }
  | { kind: 'close' };

type MaintenanceOperation = { sessionId: Guid } & (
  { kind: 'waitForIndexing'; expectedRevision: Int64 } | { kind: 'synchronizeIndex' }
);
type MaintenanceRequest = { kind: 'maintenance'; operation: MaintenanceOperation; port: MessagePort };

type ReplyValue = CapturedLease | ContextIndexStatus | LLMContextStatistics | readonly ContextEntry[] |
  ContextEntry | ContextPage | readonly ContextSearchHit[] | ContextIndexedSearchResult | AnchorResolution |
  readonly ContextMemory[] | IContextMutationResult | LLMSessionContext | ContextIndexSynchronization | null | undefined;
type Reply =
  | { ok: true; value: ReplyValue }
  | { ok: false; message: string; code?: ContextErrorCode; name?: 'TypeError' | 'RangeError' };

const sequence = 0;
const closed = 1;

function pulse(word: Int32Array): void {
  Atomics.add(word, sequence, 1);
  Atomics.notify(word, sequence);
}

function failureReply(error: unknown): Reply {
  return {
    ok: false,
    message: error instanceof Error ? error.message : 'Worker context request failed.',
    ...(error instanceof ContextError ? { code: error.code } : {}),
    ...(error instanceof TypeError ? { name: 'TypeError' as const } : {}),
    ...(error instanceof RangeError ? { name: 'RangeError' as const } : {}),
  };
}

function unwrap(reply: Reply): ReplyValue {
  if (reply.ok) return reply.value;
  if (reply.code) throw new ContextError(reply.code, reply.message);
  if (reply.name === 'TypeError') throw new TypeError(reply.message);
  if (reply.name === 'RangeError') throw new RangeError(reply.message);
  throw new Error(reply.message);
}

function restoreEntry<T extends { readonly Content: ContextContent }>(entry: T): T {
  return entry && { ...entry, Content: restoreWireContent(entry.Content) };
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function immutableEntry(entry: ContextEntry): ContextEntry {
  return immutable(restoreEntry(entry));
}

function wireSession(session: LLMSessionContext): LLMSessionContext {
  return { ...session, Anchors: new Map(session.Anchors), Segments: new Map(session.Segments) };
}

function restoreSession(session: LLMSessionContext): LLMSessionContext {
  return Object.freeze({ ...session,
    Anchors: new ImmutableMap(new Map([...session.Anchors].map(([key, anchor]) => [key, immutable(anchor)])), canonicalGuid),
    Segments: new ImmutableMap(new Map([...session.Segments].map(([key, segment]) => [key,
      immutable({ ...segment, Entries: segment.Entries.map(immutableEntry) })])), canonicalInt64),
  });
}

function restoreChanges(changes: ContextChangeSet): ContextChangeSet {
  if (!Array.isArray(changes.Changes)) return changes;
  return { ...changes, Changes: changes.Changes.map((change: ContextChangeSet['Changes'][number]) => {
    switch (change?.kind) {
      case 'ReplaceEntry': return restoreEntry(change);
      case 'ReplaceSegment':
      case 'AppendEntries':
        return Array.isArray(change.Entries) ? { ...change, Entries: change.Entries.map(restoreEntry) } : change;
      default: return change;
    }
  }) };
}

export function attachWorkerContextPeer(mailbox: OwnerMailbox, configuration: {
  defaultProjectionEstimator: boolean; allowWorkerProjectionEstimator: boolean; maximumViewResults: number;
}, owner: {
  openRead(sessionId: Guid): ContextReadLease;
  retainOutput(bytes: bigint): () => void;
  tryFindSession(sessionId: Guid): LLMSessionContext | null;
  createSession(session: LLMSessionContext): IContextMutationResult;
  getStatistics(): LLMContextStatistics;
  replyToWorkerSession(changes: ContextChangeSet, resolve: (value: IContextMutationResult) => void, reject: (error: unknown) => void): void;
  applyMemoryFromWorker(changes: MemoryChangeSet): IContextMutationResult | Promise<IContextMutationResult>;
  removeSessionFromWorker(sessionId: Guid, expectedRevision: Int64): IContextMutationResult | Promise<IContextMutationResult>;
  waitForIndexingAsync(sessionId: Guid, expectedRevision: Int64, signal: AbortSignal): Promise<void>;
  synchronizeIndexAsync(sessionId: Guid, signal: AbortSignal): Promise<ContextIndexSynchronization>;
}): WorkerContextEndpoint {
  const response = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  const leases = new Map<number, ContextReadLease>();
  const views = new Map<number, () => void>();
  const maintenance = new Map<MessagePort, AbortController>();
  let nextId = 0;
  let closing = false;
  const release = (id: number) => {
    views.get(id)?.();
    views.delete(id);
    leases.get(id)?.dispose();
    leases.delete(id);
  };
  const releaseAll = () => {
    for (const id of leases.keys()) release(id);
    for (const [port, controller] of maintenance) {
      controller.abort();
      port.close();
    }
    maintenance.clear();
  };
  const requireLease = (id: number) => {
    const lease = leases.get(id);
    if (!lease) throw new ContextError('Disposed', 'This worker read lease has ended.');
    return lease;
  };
  const dispatch = (request: Exclude<Request, { kind: 'apply' }>): ReplyValue | Promise<ReplyValue> => {
    if (closing) throw new ContextError('Disposed', 'This worker peer has closed.');
    switch (request.kind) {
      case 'statistics':
        return owner.getStatistics();
      case 'findSession': {
        const session = owner.tryFindSession(request.sessionId);
        return session && wireSession(session);
      }
      case 'createSession':
        return owner.createSession(restoreSession(request.session));
      case 'open': {
        const lease = owner.openRead(request.sessionId);
        const id = ++nextId;
        leases.set(id, lease);
        return { id, revision: lease.Session.Revision, memoryRevision: lease.MemoryRevision, indexingMode: lease.IndexingMode };
      }
      case 'retainView': {
        const lease = requireLease(request.id);
        if (!configuration.defaultProjectionEstimator && !configuration.allowWorkerProjectionEstimator) {
          throw new ContextError('NotSupported', 'Worker views require the default projection estimator or an authorized worker-local estimator.');
        }
        if (!Number.isSafeInteger(request.count) || request.count < 0 || request.count > configuration.maximumViewResults ||
          !isInt64(request.bytes) || BigInt(request.bytes) < BigInt(request.count) || (request.count === 0 && request.bytes !== 0)) {
          throw new RangeError('Invalid worker projection estimate.');
        }
        if (views.has(request.id)) throw new ContextError('InvalidOperation', 'Worker read already holds a projection.');
        const free = owner.retainOutput(BigInt(request.bytes));
        if (closing || leases.get(request.id) !== lease || views.has(request.id)) {
          free();
          throw new ContextError('Disposed', 'This worker read lease has ended.');
        }
        views.set(request.id, free);
        return;
      }
      case 'session':
        return wireSession(requireLease(request.id).Session);
      case 'indexStatus':
        return requireLease(request.id).IndexStatus;
      case 'range':
        return requireLease(request.id).ReadRange(request.from, request.count);
      case 'entry':
        return requireLease(request.id).TryFindEntry(request.entryId);
      case 'page':
        return requireLease(request.id).ReadPage(request.cursor, request.count);
      case 'search':
        return requireLease(request.id).Search(request.query, request.limit);
      case 'searchIndexed':
        return requireLease(request.id).SearchIndexed(request.query, request.limit);
      case 'searchKeys':
        return requireLease(request.id).SearchKeys(request.keys, request.limit);
      case 'anchor':
        return requireLease(request.id).ResolveAnchor(request.anchorId);
      case 'memory':
        return requireLease(request.id).GetApplicableMemory(request.scopes);
      case 'applyMemory':
        return owner.applyMemoryFromWorker(request.changes);
      case 'remove':
        return owner.removeSessionFromWorker(request.sessionId, request.expectedRevision);
      case 'release':
        release(request.id);
        return;
      case 'close':
        closing = true;
        releaseAll();
        return;
      default:
        throw new ContextError('NotSupported', 'Unknown worker context request.');
    }
  };
  const dispatchMaintenance = ({ operation, port }: MaintenanceRequest) => {
    if (closing) {
      port.postMessage(failureReply(new ContextError('Disposed', 'This worker peer has closed.')));
      port.close();
      return;
    }
    const controller = new AbortController();
    maintenance.set(port, controller);
    port.once('close', () => {
      if (maintenance.delete(port)) controller.abort();
    });
    const finish = (reply: Reply) => {
      if (!maintenance.delete(port)) return;
      port.postMessage(reply);
      port.close();
    };
    try {
      if (operation?.kind !== 'waitForIndexing' && operation?.kind !== 'synchronizeIndex') {
        throw new ContextError('NotSupported', 'Unknown worker maintenance request.');
      }
      const result = operation.kind === 'waitForIndexing'
        ? owner.waitForIndexingAsync(operation.sessionId, operation.expectedRevision, controller.signal)
        : owner.synchronizeIndexAsync(operation.sessionId, controller.signal);
      void result.then((value) => finish({ ok: true, value: value ?? undefined }), (error) => finish(failureReply(error)));
    } catch (error) { finish(failureReply(error)); }
  };
  const { port, wake } = mailbox.attach((value, post) => {
    const request = value as Request | MaintenanceRequest;
    if (request?.kind === 'maintenance') {
      if (request.port instanceof MessagePort) dispatchMaintenance(request);
      return;
    }
    const send = (reply: Reply) => {
      if (Atomics.load(response, closed)) return;
      post(reply);
      pulse(response);
    };
    const success = (value: ReplyValue) => send({ ok: true, value });
    const failure = (error: unknown) => send(failureReply(error));
    try {
      if (request?.kind === 'apply') {
        if (closing) throw new ContextError('Disposed', 'This worker peer has closed.');
        owner.replyToWorkerSession(restoreChanges(request.changes), success, failure);
        return;
      }
      const result = dispatch(request);
      if (result instanceof Promise) void result.then(success, failure);
      else success(result);
    } catch (error) {
      failure(error);
    }
  }, () => {
    closing = true;
    releaseAll();
    Atomics.store(response, closed, 1);
    pulse(response);
  }, () => leases.size !== 0);
  return { port, wake, response, ownerThreadId: threadId, ...configuration };
}

export class WorkerContextPeer {
  private disposed = false;
  private readonly maintenancePorts = new Set<MessagePort>();
  private readonly projectionEstimator?: (item: unknown) => Int64;

  constructor(private readonly endpoint: WorkerContextEndpoint, options?: WorkerContextPeerOptions) {
    if (threadId === endpoint.ownerThreadId) {
      throw new ContextError('NotSupported', 'The synchronous context peer must run on a different thread from its owner.');
    }
    const estimate = options?.ProjectionSizeEstimator;
    if (estimate !== undefined && typeof estimate !== 'function') throw new TypeError('ProjectionSizeEstimator must be a function.');
    if (estimate && !endpoint.allowWorkerProjectionEstimator) {
      throw new ContextError('NotSupported', 'The owner did not authorize a worker-local projection estimator.');
    }
    this.projectionEstimator = estimate ?? (endpoint.defaultProjectionEstimator ? defaultLLMContextOptions.ProjectionSizeEstimator : undefined);
    endpoint.port.once('close', () => this.closeMaintenancePorts());
  }

  private closeMaintenancePorts(): void {
    for (const port of this.maintenancePorts) port.close();
    this.maintenancePorts.clear();
  }

  public getStatistics(): LLMContextStatistics {
    return this.request({ kind: 'statistics' }) as LLMContextStatistics;
  }

  public tryFindSession(sessionId: Guid): LLMSessionContext | null {
    const session = this.request({ kind: 'findSession', sessionId }) as LLMSessionContext | null;
    return session && restoreSession(session);
  }

  public createSession(session: LLMSessionContext): IContextMutationResult {
    return this.request({ kind: 'createSession', session: wireSession(session) }) as IContextMutationResult;
  }

  public openRead(sessionId: Guid): CapturedLease {
    return this.request({ kind: 'open', sessionId }) as CapturedLease;
  }

  public openReadLease(sessionId: Guid): ILLMContextReadLease {
    return this.wrapRead(this.openRead(sessionId));
  }

  private wrapRead(lease: CapturedLease): ILLMContextReadLease {
    const peer = this;
    const id = lease.id;
    let active = true;
    let cachedSession: LLMSessionContext | undefined;
    const check = () => {
      if (!active || peer.disposed || Atomics.load(peer.endpoint.response, closed)) {
        throw new ContextError('Disposed', 'This worker read lease has ended.');
      }
    };
    return {
      get Session() { check(); return cachedSession ??= peer.readSession(id); },
      get IndexingMode() { check(); return lease.indexingMode; },
      get MemoryRevision() { check(); return lease.memoryRevision; },
      get IndexStatus() { check(); return peer.indexStatus(id); },
      TryFindEntry(entryId) { check(); return peer.tryFindEntry(id, entryId); },
      ReadRange(from, count) { check(); return peer.readRange(id, from, count); },
      ReadPage(cursor, count) { check(); return peer.readPage(id, cursor, count); },
      Search(query, limit) { check(); return peer.search(id, query, limit); },
      SearchKeys(keys, limit) { check(); return peer.searchKeys(id, keys, limit); },
      SearchIndexed(query, limit) { check(); return peer.searchIndexed(id, query, limit); },
      ResolveAnchor(anchorId) { check(); return peer.resolveAnchor(id, anchorId); },
      GetApplicableMemory(scopes) { check(); return peer.getApplicableMemory(id, scopes); },
      dispose() {
        if (!active) return;
        active = false;
        cachedSession = undefined;
        if (!peer.disposed && !Atomics.load(peer.endpoint.response, closed)) peer.release(id);
      },
    };
  }

  public withCurrent<T>(sessionId: Guid, consume: (read: ILLMContextReadLease) => T): T {
    return withCurrentRead(() => this.openReadLease(sessionId), consume);
  }

  public openView<T>(definition: ILLMContextViewDefinition<T>): ILLMContextView<T> {
    const limit = definition.MaximumResults;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.endpoint.maximumViewResults) {
      throw new RangeError('Invalid maximum view results.');
    }
    const estimateItem = this.projectionEstimator;
    if (!estimateItem) {
      throw new ContextError('NotSupported', 'Worker views require the default projection estimator or an authorized worker-local estimator.');
    }
    const capture = this.openRead(definition.SessionId);
    const read = this.wrapRead(capture);
    let values: T[] | null = [];
    try {
      const evaluated = definition.Evaluate(read);
      if (evaluated == null || typeof evaluated[Symbol.iterator] !== 'function') {
        throw new TypeError('View evaluation must return an iterable.');
      }
      if (limit > 0) {
        for (const item of evaluated) {
          values.push(item);
          if (values.length === limit) break;
        }
      }
      let bytes = 0n;
      for (const item of values) {
        const estimate = estimateItem(item);
        if (!isPositiveInt64(estimate)) throw new RangeError('Invalid projection size estimate.');
        bytes = checkedInt64(bytes + BigInt(estimate));
      }
      this.request({ kind: 'retainView', id: capture.id, count: values.length, bytes: canonicalInt64(bytes) });
      const available = () => {
        if (!values || this.disposed || Atomics.load(this.endpoint.response, closed)) {
          throw new ContextError('Disposed', 'This context view has been disposed.');
        }
        return values;
      };
      return {
        get SessionRevision() { available(); return capture.revision; },
        get MemoryRevision() { available(); return capture.memoryRevision; },
        get length() { return available().length; },
        at(index: number) {
          const current = available();
          if (!Number.isInteger(index) || index < 0 || index >= current.length) throw new RangeError('Context view index is out of range.');
          return current[index];
        },
        *[Symbol.iterator]() {
          for (let index = 0; index < this.length; index++) yield this.at(index);
        },
        dispose() {
          if (!values) return;
          values = null;
          read.dispose();
        },
      };
    } catch (error) {
      read.dispose();
      throw error;
    }
  }

  public async waitForIndexingAsync(sessionId: Guid, expectedRevision: Int64, signal?: AbortSignal): Promise<void> {
    await this.requestMaintenance({ kind: 'waitForIndexing', sessionId, expectedRevision }, signal);
  }

  public async synchronizeIndexAsync(sessionId: Guid, signal?: AbortSignal): Promise<ContextIndexSynchronization> {
    const result = await this.requestMaintenance({ kind: 'synchronizeIndex', sessionId }, signal);
    return immutable(result as ContextIndexSynchronization);
  }

  private requestMaintenance(operation: MaintenanceOperation, signal?: AbortSignal): Promise<ReplyValue> {
    signal?.throwIfAborted();
    const { port, wake, response } = this.endpoint;
    if (this.disposed || Atomics.load(response, closed)) throw new ContextError('Disposed', 'This worker peer has closed.');
    const { port1, port2 } = new MessageChannel();
    this.maintenancePorts.add(port1);
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.maintenancePorts.delete(port1);
        signal?.removeEventListener('abort', abort);
        port1.close();
      };
      const abort = () => { reject(signal!.reason); finish(); };
      signal?.addEventListener('abort', abort, { once: true });
      port1.once('message', (reply: Reply) => {
        try { resolve(unwrap(reply)); }
        catch (error) { reject(error); }
        finally { finish(); }
      });
      port1.once('close', () => {
        this.maintenancePorts.delete(port1);
        signal?.removeEventListener('abort', abort);
        reject(new ContextError('Disposed', 'This worker maintenance request has ended.'));
      });
      try {
        port.postMessage({ kind: 'maintenance', operation, port: port2 } satisfies MaintenanceRequest, [port2]);
        pulse(wake);
      } catch (error) { reject(error); port2.close(); finish(); }
    });
  }

  private readSession(id: number): LLMSessionContext {
    return restoreSession(this.request({ kind: 'session', id }) as LLMSessionContext);
  }

  public indexStatus(id: number): ContextIndexStatus {
    return immutable(this.request({ kind: 'indexStatus', id }) as ContextIndexStatus);
  }

  public readRange(id: number, from: Int64, count: number): readonly ContextEntry[] {
    const entries = this.request({ kind: 'range', id, from, count }) as readonly ContextEntry[];
    return Object.freeze(entries.map(immutableEntry));
  }

  public tryFindEntry(id: number, entryId: Guid): ContextEntry | null {
    const entry = this.request({ kind: 'entry', id, entryId }) as ContextEntry | null;
    return entry && immutableEntry(entry);
  }

  public readPage(id: number, cursor: ContextCursor | null, count: number): ContextPage {
    const page = this.request({ kind: 'page', id, cursor, count }) as ContextPage;
    return immutable({ ...page, Entries: page.Entries.map(immutableEntry) });
  }

  public search(id: number, query: string, limit: number): readonly ContextSearchHit[] {
    return immutable(this.request({ kind: 'search', id, query, limit }) as readonly ContextSearchHit[]);
  }

  public searchKeys(id: number, keys: ContextIndexKeys | readonly string[], limit: number): readonly ContextSearchHit[] {
    return immutable(this.request({ kind: 'searchKeys', id, keys: keys instanceof ContextIndexKeys ? keys.Keys : keys, limit }) as readonly ContextSearchHit[]);
  }

  public searchIndexed(id: number, query: string, limit: number): ContextIndexedSearchResult {
    return immutable(this.request({ kind: 'searchIndexed', id, query, limit }) as ContextIndexedSearchResult);
  }

  public resolveAnchor(id: number, anchorId: Guid): AnchorResolution {
    const result = this.request({ kind: 'anchor', id, anchorId }) as AnchorResolution;
    return immutable({ ...result, Start: result.Start && immutableEntry(result.Start), End: result.End && immutableEntry(result.End) });
  }

  public getApplicableMemory(id: number, scopes: readonly MemoryScope[]): readonly ContextMemory[] {
    return immutable(this.request({ kind: 'memory', id, scopes }) as readonly ContextMemory[]);
  }

  public apply(changes: ContextChangeSet): IContextMutationResult {
    return this.request({ kind: 'apply', changes }) as IContextMutationResult;
  }

  public applyMemory(changes: MemoryChangeSet): IContextMutationResult {
    return this.request({ kind: 'applyMemory', changes }) as IContextMutationResult;
  }

  public removeSession(sessionId: Guid, expectedRevision: Int64): IContextMutationResult {
    return this.request({ kind: 'remove', sessionId, expectedRevision }) as IContextMutationResult;
  }

  public release(id: number): void {
    this.request({ kind: 'release', id });
  }

  public dispose(): void {
    if (this.disposed) return;
    try {
      if (!Atomics.load(this.endpoint.response, closed)) this.request({ kind: 'close' });
    } finally {
      this.disposed = true;
      this.closeMaintenancePorts();
      this.endpoint.port.close();
    }
  }

  private request(request: Request): ReplyValue {
    const { port, wake, response } = this.endpoint;
    if (this.disposed || Atomics.load(response, closed)) throw new ContextError('Disposed', 'This worker peer has closed.');
    port.postMessage(request);
    pulse(wake);
    for (;;) {
      const observed = Atomics.load(response, sequence);
      const message = receiveMessageOnPort(port);
      if (message) return unwrap(message.message as Reply);
      if (Atomics.load(response, closed)) throw new ContextError('Disposed', 'This worker peer has closed.');
      Atomics.wait(response, sequence, observed);
    }
  }
}
