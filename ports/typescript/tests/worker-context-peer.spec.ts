// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { ContextIndexingMode } from '../src/domain/index-keys.js';
import { AnchorKind, ContextMutationStatus, ContextRole, MemoryStatus, SessionStatus, TextContent, type ContextChangeSet, type IContextMutationResult, type MemoryChangeSet } from '../src/domain/session.js';
import type { Int64 } from '../src/domain/int64.js';
import { defaultLLMContextOptions } from '../src/options.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { defaultPartitionedContextIndexOptions } from '../src/storage/partitioned-index.js';

it('replies to an offloaded write while synchronous admission waits for that peer to release its read', async () => {
  const SessionId = '00000000-0000-0000-0000-000000000001';
  const EntryId = '00000000-0000-0000-0000-000000000003';
  const start = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let captures = 0;
  const owner = new LLMContextOwner({
    ...defaultLLMContextOptions, AdmissionTimeoutMs: 2000, MaximumRetainedReads: 1,
    TimeProvider: { now() {
      if (++captures === 2) { Atomics.store(start, 0, 1); Atomics.notify(start, 0); }
      return 0;
    } },
  });
  expect(owner.createSession({
    SessionId, UserId: '00000000-0000-0000-0000-000000000002', RepositoryId: null,
    Revision: 0, Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
  }).Status).toBe(ContextMutationStatus.Applied);
  const endpoint = owner.connectWorker();
  const worker = new Worker(`
    const { parentPort, workerData: { endpoint, parent, SessionId, EntryId, start } } = require('node:worker_threads');
    const assert = require('node:assert/strict');
    const { tsImport } = require('tsx/esm/api');
    (async () => {
      const { WorkerContextPeer } = await tsImport('../src/runtime/worker-context-peer.ts', parent);
      const { TextContent } = await tsImport('../src/domain/session.ts', parent);
      const peer = new WorkerContextPeer(endpoint);
      const held = peer.openRead(SessionId);
      parentPort.postMessage('ready');
      try {
        assert.notEqual(Atomics.wait(start, 0, 0, 3000), 'timed-out');
        const result = peer.apply({ SessionId, ExpectedRevision: 0, Changes: [
          { kind: 'AppendEntries', Entries: [{ EntryId, Role: 'User', CreatedAt: '1970-01-01T00:00:00Z',
            Content: new TextContent('concurrent update') }] },
        ] });
        assert.equal(result.Status, 'Applied');
      } finally { peer.release(held.id); peer.dispose(); }
      parentPort.postMessage('done');
    })().catch((error) => { throw error; });
  `, { eval: true, execArgv: [], workerData: { endpoint, parent: import.meta.url, SessionId, EntryId, start },
    transferList: [endpoint.port] });
  try {
    expect(await once(worker, 'message')).toEqual(['ready']);
    const done = once(worker, 'message');
    const admitted = owner.openRead(SessionId);
    try {
      expect(admitted.Session.Revision).toBe(0);
      expect(admitted.ReadRange(0, 1)).toEqual([]);
      expect(owner.tryFindSession(SessionId)?.Revision).toBe(1);
    } finally { admitted.dispose(); }
    expect(await done).toEqual(['done']);
    expect(owner.getStatistics().RetainedReads).toBe(0);
  } finally { owner.dispose(); await worker.terminate(); }
});

it('reconstructs segment replacement payloads and preserves old worker captures', async () => {
  const SessionId = '00000000-0000-0000-0000-000000000001';
  const EntryId = '00000000-0000-0000-0000-000000000003';
  const AnchorId = '00000000-0000-0000-0000-000000000004';
  let observedCancellation!: () => void;
  const cancelled = new Promise<void>((resolve) => { observedCancellation = resolve; });
  class WaitOwner extends LLMContextOwner {
    override async waitForIndexingAsync(sessionId: string, revision: Int64, signal?: AbortSignal) {
      if (revision !== 123) return super.waitForIndexingAsync(sessionId, revision, signal);
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => {
        observedCancellation();
        resolve();
      }, { once: true }));
    }
  }
  const owner = new WaitOwner();
  const entry = {
    EntryId, Sequence: 0, Role: ContextRole.User,
    CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('before'),
  };
  expect(owner.createSession({
    SessionId, UserId: '00000000-0000-0000-0000-000000000002', RepositoryId: null,
    Revision: 0, Status: SessionStatus.Active, Anchors: new Map([[AnchorId, {
      AnchorId, StartEntryId: EntryId, EndEntryId: EntryId, Kind: AnchorKind.Topic,
      Title: 'Topic', Summary: 'One entry', Topics: ['topic'], SourceRevision: 0, PinnedRevision: null,
    }]]),
    Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [entry] }]]),
  }).Status).toBe(ContextMutationStatus.Applied);
  const endpoint = owner.connectWorker();
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { tsImport } = require('tsx/esm/api');
    const assert = require('node:assert/strict');
    (async () => {
      const { WorkerContextPeer } = await tsImport('../src/runtime/worker-context-peer.ts', workerData.parent);
      const { SessionId, AnchorId, endpoint } = workerData;
      const peer = new WorkerContextPeer(endpoint);
      try {
        const before = peer.openRead(SessionId);
        const [entry] = peer.readRange(before.id, 0, 1);
        const TextContent = entry.Content.constructor;
        assert.equal(TextContent.name, 'TextContent');
        assert(Object.isFrozen(entry.Content));
        const change = { SessionId, ExpectedRevision: before.revision, Changes: [
          { kind: 'ReplaceSegment', SegmentId: 0, Entries: [{ ...entry, Content: new TextContent('after') }] },
        ] };
        assert.equal(peer.apply(change).Status, 'Applied');
        assert.equal(peer.apply(change).Status, 'RevisionConflict');
        const after = peer.openRead(SessionId);
        assert.equal(after.revision, 1);
        const [replaced] = peer.readRange(after.id, 0, 1);
        assert(replaced.Content instanceof TextContent);
        assert.equal(replaced.Content.Text, 'after');
        assert.equal(peer.readRange(before.id, 0, 1)[0].Content.Text, 'before');
        const page = peer.readPage(after.id, null, 1);
        assert.deepEqual(page, { Entries: [replaced], Next: null });
        assert(Object.isFrozen(page.Entries));
        assert.throws(() => peer.readPage(after.id, { SessionId, Revision: before.revision, AfterSequence: 0 }, 1), TypeError);
        assert.deepEqual(peer.tryFindEntry(after.id, entry.EntryId), replaced);
        assert.equal(peer.tryFindEntry(after.id, SessionId), null);
        const hit = peer.search(after.id, 'after', 1);
        assert.equal(hit[0].SessionRevision, 1);
        assert.deepEqual(peer.searchIndexed(after.id, 'after', 1).Hits, hit);
        assert.deepEqual(peer.searchKeys(after.id, ['after'], 1), hit);
        assert.equal(peer.search(before.id, 'before', 1)[0].SessionRevision, 0);
        const target = peer.resolveAnchor(after.id, AnchorId);
        assert.deepEqual(target.Start, replaced);
        assert(Object.isFrozen(target.Anchor.Topics));
        assert.equal(peer.applyMemory({ ExpectedRevision: 0, Deletes: [], Upserts: [{
          MemoryId: AnchorId, Scope: { SessionId }, Content: 'confirmed', Revision: 0,
          Status: 'Confirmed', ExpiresAt: null, Sources: [{ SessionId, AnchorId }],
        }] }).Status, 'Applied');
        assert.deepEqual(peer.getApplicableMemory(after.id, [{ SessionId }]), []);
        const latest = peer.openRead(SessionId);
        const [memory] = peer.getApplicableMemory(latest.id, [{ SessionId }]);
        assert.equal(memory.Content, 'confirmed');
        assert(Object.isFrozen(memory.Sources[0]));
        peer.release(latest.id);
        assert.throws(() => peer.search(latest.id, 'after', 1), /lease has ended/);
        const lease = peer.openReadLease(SessionId);
        const session = lease.Session;
        assert.strictEqual(lease.Session, session);
        assert.equal(lease.MemoryRevision, 1);
        assert.equal(lease.IndexingMode, 'Text');
        assert.equal(session.Revision, 1);
        const cancel = new AbortController();
        const pending = peer.waitForIndexingAsync(SessionId, 123, cancel.signal);
        assert.equal(peer.getStatistics().Sessions, 1);
        const complete = peer.waitForIndexingAsync(SessionId, 1);
        cancel.abort(new Error('cancelled locally'));
        await assert.rejects(pending, /cancelled locally/);
        await complete;
        await assert.rejects(peer.waitForIndexingAsync(SessionId, 0), { code: 'InvalidOperation' });
        await assert.rejects(peer.synchronizeIndexAsync(SessionId), { code: 'NotSupported' });
        assert.equal(session.Segments.get(0n).Entries[0].Content.Text, 'after');
        assert.equal(session.Anchors.get(AnchorId).Topics[0], 'topic');
        assert.equal(session.Segments.set, undefined);
        assert(Object.isFrozen(session.Segments.get(0).Entries));
        assert.deepEqual(lease.Search('after', 1), hit);
        lease.dispose();
        lease.dispose();
        assert.throws(() => lease.Session, /lease has ended/);
        assert.equal(session.Revision, 1);
      } finally { peer.dispose(); }
      parentPort.postMessage('verified');
    })().catch((error) => { throw error; });
  `, { eval: true, workerData: { endpoint, parent: import.meta.url, SessionId, AnchorId }, transferList: [endpoint.port] });
  try {
    await expect(once(worker, 'message')).resolves.toEqual(['verified']);
    await cancelled;
    expect(owner.getStatistics().RetainedReads).toBe(0);
    const capture = owner.openRead(SessionId);
    try {
      expect(capture.Search('before', 1)).toEqual([]);
      expect(capture.Search('after', 1)).toMatchObject([{ EntryId, SessionRevision: 1 }]);
    } finally { capture.dispose(); }
  } finally {
    owner.dispose();
    await worker.terminate();
  }
});

it.each(['remove', 'memory', 'speculative', 'serialized', 'partitioned'])('queues a worker %s behind a resident-blocked writer and checks the new revision', async (action) => {
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let estimates = 0;
  let preparedWhileBusy = false;
  const notifyGate = () => {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
  };
  class ObservableOwner extends LLMContextOwner {
    override removeSessionFromWorker(id: string, expectedRevision: Int64) {
      const result = super.removeSessionFromWorker(id, expectedRevision);
      if (result instanceof Promise) notifyGate();
      return result;
    }

    override applyMemoryFromWorker(changes: MemoryChangeSet) {
      const result = super.applyMemoryFromWorker(changes);
      if (result instanceof Promise) notifyGate();
      return result;
    }

    override replyToWorkerSession(changes: ContextChangeSet, resolve: (value: IContextMutationResult) => void, reject: (error: unknown) => void) {
      const before = estimates;
      const queued = super.replyToWorkerSession(changes, resolve, reject);
      preparedWhileBusy = estimates > before;
      if (queued) notifyGate();
      return queued;
    }
  }
  const partitioned = action === 'partitioned';
  const budget = partitioned ? 16 * 1024 * 1024 : 8192;
  const owner = new ObservableOwner({
    ...defaultLLMContextOptions, AdmissionTimeoutMs: 2000, EstimatedResidentByteBudget: budget,
    SerializeSessionPreparation: action === 'serialized' || partitioned,
    ...(partitioned ? {
      IndexingMode: ContextIndexingMode.ProducerOwned, PartitionedIndex: defaultPartitionedContextIndexOptions,
    } : {}),
    EntrySizeEstimator: (entry) => {
      estimates++;
      return defaultLLMContextOptions.EntrySizeEstimator(entry);
    },
  });
  const SessionId = '00000000-0000-0000-0000-000000000001';
  const UserId = '00000000-0000-0000-0000-000000000002';
  expect(owner.createSession({
    SessionId, UserId, RepositoryId: null,
    Revision: 0, Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
  }).Status).toBe(ContextMutationStatus.Applied);
  const release = owner.retainOutput(BigInt(budget) - BigInt(owner.getStatistics().EstimatedActiveBytes));
  let released = false;
  const { port, wake } = owner.attachAdmissionPeer(() => { release(); released = true; });
  const releasingWorker = new Worker(`
    const { parentPort, workerData: { port, wake, gate } } = require('node:worker_threads');
    parentPort.postMessage('ready');
    if (Atomics.wait(gate, 0, 0, 4000) === 'timed-out') throw new Error('Request did not queue at the held gate.');
    port.postMessage('release');
    Atomics.add(wake, 0, 1);
    Atomics.notify(wake, 0);
    port.close();
  `, { eval: true, workerData: { port, wake, gate }, transferList: [port] });
  const endpoint = owner.connectWorker();
  const removingWorker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { tsImport } = require('tsx/esm/api');
    (async () => {
      const { WorkerContextPeer } = await tsImport('../src/runtime/worker-context-peer.ts', workerData.parent);
      const { TextContent } = await tsImport('../src/domain/session.ts', workerData.parent);
      const peer = new WorkerContextPeer(workerData.endpoint);
      parentPort.postMessage('ready');
      parentPort.once('message', (action) => {
        const result = action === 'remove' ? peer.removeSession(workerData.session, 0)
          : action === 'memory' ? peer.applyMemory({ ExpectedRevision: 0, Deletes: [], Upserts: [{
            MemoryId: '00000000-0000-0000-0000-000000000004',
            Scope: { UserId: workerData.user }, Content: 'queued', Revision: 0, Status: 'Proposed', ExpiresAt: null, Sources: [],
          }] }) : peer.apply({ SessionId: workerData.session, ExpectedRevision: 0, Changes: [{ kind: 'AppendEntries', Entries: [{
            EntryId: '00000000-0000-0000-0000-000000000004',
            Role: 'User', CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('queued'),
            ...(action === 'partitioned' ? { IndexKeys: ['queued'] } : {}),
          }] }] });
        peer.dispose();
        parentPort.postMessage(result);
      });
    })().catch((error) => { throw error; });
  `, {
    eval: true, workerData: { endpoint, parent: import.meta.url, session: SessionId, user: UserId },
    transferList: [endpoint.port],
  });
  try {
    await Promise.all([once(releasingWorker, 'message'), once(removingWorker, 'message')]);
    const removal = once(removingWorker, 'message');
    removingWorker.postMessage(action);
    const write = action !== 'memory' ? owner.applySession({ SessionId, ExpectedRevision: 0, Changes: [{ kind: 'AppendEntries', Entries: [{
      EntryId: '00000000-0000-0000-0000-000000000003', Role: ContextRole.User,
      CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('committed first'),
      ...(partitioned ? { IndexKeys: ['committed'] } : {}),
    }] }] }) : owner.applyMemory({ ExpectedRevision: 0, Deletes: [], Upserts: [{
      MemoryId: '00000000-0000-0000-0000-000000000003', Scope: { UserId }, Content: 'committed first',
      Revision: 0, Status: MemoryStatus.Proposed, ExpiresAt: null, Sources: [],
    }] });
    expect(write).toMatchObject({ Status: ContextMutationStatus.Applied, Revision: 1 });
    expect(released).toBe(true);
    await expect(removal).resolves.toEqual([expect.objectContaining({ Status: ContextMutationStatus.RevisionConflict, Revision: 1 })]);
    expect(preparedWhileBusy).toBe(action === 'speculative');
  } finally {
    if (!released) release();
    owner.dispose();
    await Promise.all([releasingWorker.terminate(), removingWorker.terminate()]);
  }
});

it('allows exactly one of two worker writes against the same captured revision', async () => {
  const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const owner = new LLMContextOwner({ ...defaultLLMContextOptions, AdmissionTimeoutMs: 2000, MaximumRetainedReads: 2 });
  const sessionId = id(1);
  expect(owner.createSession({
    SessionId: sessionId, UserId: id(2), RepositoryId: null, Revision: 0,
    Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
  }).Status).toBe(ContextMutationStatus.Applied);
  const start = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const workers = [id(3), id(4)].map((entryId) => {
    const endpoint = owner.connectWorker();
    return new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { tsImport } = require('tsx/esm/api');
      (async () => {
        const { WorkerContextPeer } = await tsImport('../src/runtime/worker-context-peer.ts', workerData.parent);
        const { TextContent } = await tsImport('../src/domain/session.ts', workerData.parent);
        const { endpoint, sessionId, entryId, start } = workerData;
        const peer = new WorkerContextPeer(endpoint);
        const read = peer.openRead(sessionId);
        parentPort.postMessage(read.revision);
        try {
          if (Atomics.wait(start, 0, 0, 4000) === 'timed-out') throw new Error('Workers did not reach the race.');
          const result = peer.apply({ SessionId: sessionId, ExpectedRevision: read.revision,
            Changes: [{ kind: 'AppendEntries', Entries: [{
              EntryId: entryId, Role: 'User', CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent(entryId),
            }] }] });
          const oldCount = peer.readRange(read.id, 0, 2).length;
          peer.dispose();
          parentPort.postMessage({ status: result.Status, revision: result.Revision, oldCount });
        } finally { peer.dispose(); }
      })().catch((error) => { throw error; });
    `, { eval: true, workerData: { endpoint, parent: import.meta.url, sessionId, entryId, start }, transferList: [endpoint.port] });
  });
  try {
    expect(await Promise.all(workers.map((worker) => once(worker, 'message')))).toEqual([[0], [0]]);
    const done = Promise.all(workers.map((worker) => once(worker, 'message')));
    Atomics.store(start, 0, 1);
    Atomics.notify(start, 0);
    const results = (await done).map(([result]) => result);
    expect(results).toEqual(expect.arrayContaining([
      { status: ContextMutationStatus.Applied, revision: 1, oldCount: 0 },
      { status: ContextMutationStatus.RevisionConflict, revision: 1, oldCount: 0 },
    ]));
    const latest = owner.openRead(sessionId);
    try { expect(latest.ReadRange(0, 2)).toHaveLength(1); }
    finally { latest.dispose(); }
    expect(owner.getStatistics()).toMatchObject({ RetainedReads: 0, PublishedMutations: 2 });
  } finally {
    owner.dispose();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

it.each(['release', 'dispose-owner', 'disconnect', 'write'])('uses a worker-owned read handle across admission (%s)', async (action) => {
  const SessionId = '00000000-0000-0000-0000-000000000001';
  const owner = new LLMContextOwner({
    ...defaultLLMContextOptions, AdmissionTimeoutMs: 2000, MaximumRetainedReads: 1,
  });
  expect(owner.createSession({
    SessionId, UserId: '00000000-0000-0000-0000-000000000002', RepositoryId: null,
    Revision: 0, Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
  }).Status).toBe(ContextMutationStatus.Applied);
  const endpoint = owner.connectWorker();
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { tsImport } = require('tsx/esm/api');
    (async () => {
      const { WorkerContextPeer } = await tsImport('../src/runtime/worker-context-peer.ts', workerData.parent);
      const peer = new WorkerContextPeer(workerData.endpoint);
      const lease = peer.openRead(workerData.session);
      parentPort.postMessage({ revision: lease.revision, retained: peer.getStatistics().RetainedReads });
      parentPort.once('message', async (action) => {
        let lastStatus;
        if (action === 'dispose-owner') {
          lastStatus = peer.indexStatus(lease.id);
          try { peer.openRead(workerData.session); }
          catch (error) { lastStatus = { ...lastStatus, error: error.code }; }
        } else if (action === 'write') {
          const { TextContent } = await tsImport('../src/domain/session.ts', workerData.parent);
          const changes = {
            SessionId: workerData.session, ExpectedRevision: lease.revision,
            Changes: [{ kind: 'AppendEntries', Entries: [{
              EntryId: '00000000-0000-0000-0000-000000000003', Role: 'User',
              CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('written across isolates'),
            }] }],
          };
          const applied = peer.apply(changes);
          const stale = peer.apply(changes);
          const memory = peer.applyMemory({ ExpectedRevision: 0, Deletes: [], Upserts: [{
            MemoryId: '00000000-0000-0000-0000-000000000004',
            Scope: { UserId: '00000000-0000-0000-0000-000000000002' },
            Content: 'worker memory', Revision: 0, Status: 'Proposed', ExpiresAt: null, Sources: [],
          }] });
          const oldCount = peer.readRange(lease.id, 0, 1).length;
          peer.release(lease.id);
          const current = peer.openRead(workerData.session);
          const content = peer.readRange(current.id, 0, 1)[0].Content;
          lastStatus = { applied: applied.Status, stale: stale.Status, memory: memory.Status, oldCount,
            revision: current.revision, text: content.text, immutable: Object.isFrozen(content) };
        } else {
          peer.release(lease.id);
        }
        peer.dispose();
        parentPort.postMessage(lastStatus ?? 'released');
      });
    })().catch((error) => { throw error; });
  `, {
    eval: true, workerData: { endpoint, parent: import.meta.url, session: SessionId },
    transferList: [endpoint.port],
  });
  try {
    const [opened] = await once(worker, 'message');
    expect(opened).toEqual({ revision: 0, retained: 1 });
    if (action === 'disconnect') {
      await worker.terminate();
      await expect.poll(() => owner.getStatistics().RetainedReads).toBe(0);
    } else if (action === 'dispose-owner') {
      const completed = once(worker, 'message');
      owner.dispose();
      worker.postMessage(action);
      await expect(completed).resolves.toEqual([expect.objectContaining({ SessionRevision: 0, error: 'Disposed' })]);
    } else if (action === 'release') {
      const completed = once(worker, 'message');
      worker.postMessage(action);
      const local = owner.openRead(SessionId);
      try { expect(local.Session.Revision).toBe(0); }
      finally { local.dispose(); }
      await expect(completed).resolves.toEqual(['released']);
      expect(owner.getStatistics().RetainedReads).toBe(0);
    } else {
      const completed = once(worker, 'message');
      worker.postMessage(action);
      await expect(completed).resolves.toEqual([{
        applied: ContextMutationStatus.Applied, stale: ContextMutationStatus.RevisionConflict,
        memory: ContextMutationStatus.Applied,
        oldCount: 0, revision: 1, text: 'written across isolates', immutable: true,
      }]);
      expect(owner.getStatistics().RetainedReads).toBe(0);
    }
  } finally {
    owner.dispose();
    await worker.terminate();
  }
});
