// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { ContextIndexingMode } from '../src/domain/index-keys.js';
import { ContextMutationStatus, ContextRole, MemoryStatus, SessionStatus, TextContent } from '../src/domain/session.js';
import { defaultDeferredIndexingOptions, defaultLLMContextOptions } from '../src/options.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { ContextSynchronizationWriteBehavior, defaultPartitionedContextIndexOptions } from '../src/storage/partitioned-index.js';

it('reopens partition admission after off-thread compaction without rebasing a waiting writer', async () => {
  const owner = new LLMContextOwner({
    ...defaultLLMContextOptions, IndexingMode: ContextIndexingMode.ProducerOwned,
    PartitionedIndex: {
      ...defaultPartitionedContextIndexOptions, WriteBehavior: ContextSynchronizationWriteBehavior.Wait,
      SynchronizationWaitTimeoutMs: 2000,
    },
  });
  const SessionId = '00000000-0000-0000-0000-000000000001';
  const EntryId = '00000000-0000-0000-0000-000000000003';
  try {
    expect(owner.createSession({
      SessionId, UserId: '00000000-0000-0000-0000-000000000002', RepositoryId: null,
      Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [{
        EntryId, Sequence: 0, Role: ContextRole.User,
        CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('base'), IndexKeys: ['base'],
      }] }]]),
      Anchors: new Map(),
    }).Status).toBe(ContextMutationStatus.Applied);
    expect(owner.applySession({ SessionId, ExpectedRevision: 0, Changes: [
      { kind: 'ReplaceEntry', EntryId, Content: new TextContent('working'), IndexKeys: ['working'] },
    ] }).Status).toBe(ContextMutationStatus.Applied);
    const old = owner.openRead(SessionId);
    try {
      const synchronization = owner.synchronizeIndexAsync(SessionId);
      expect(owner.getStatistics().PendingSynchronizations).toBe(1);
      const apply = (ExpectedRevision: number) => owner.applySession({
        SessionId, ExpectedRevision, Changes: [{ kind: 'SetSessionStatus', Status: SessionStatus.Active }],
      });
      expect(apply(0)).toMatchObject({ Status: ContextMutationStatus.RevisionConflict, Revision: 1 });
      expect(apply(1)).toMatchObject({ Status: ContextMutationStatus.Applied, Revision: 2 });
      await expect(synchronization).resolves.toMatchObject({ Succeeded: true, ContentRevision: 1, PartitionsCompacted: 1 });
      expect(old.IndexStatus.IndexGeneration).toBe(0);
      const current = owner.openRead(SessionId);
      try {
        expect(current.IndexStatus).toMatchObject({ SessionRevision: 2, IndexGeneration: 1 });
        expect(current.SearchKeys(['working'], 1)).toMatchObject([{ EntryId }]);
      } finally { current.dispose(); }
    } finally { old.dispose(); }
  } finally { owner.dispose(); }
});

it.each(['admit', 'dispose'])('handles in-flight native indexing during synchronous %s', (action) => {
  const budget = 1024 * 1024;
  const owner = new LLMContextOwner({
    ...defaultLLMContextOptions, AdmissionTimeoutMs: 2000, EstimatedResidentByteBudget: budget,
    DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundWords: 1 },
  });
  const SessionId = '00000000-0000-0000-0000-000000000001';
  const EntryId = '00000000-0000-0000-0000-000000000003';
  try {
    expect(owner.createSession({
      SessionId, UserId: '00000000-0000-0000-0000-000000000002', RepositoryId: null,
      Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [{
        EntryId, Sequence: 0, Role: ContextRole.User,
        CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('prefix suffix'),
      }] }]]),
      Anchors: new Map(),
    }).Status).toBe(ContextMutationStatus.Applied);
    const old = owner.openRead(SessionId);
    try {
      const before = owner.getStatistics();
      expect(before.PendingIndexWork).toBe(1);
      expect(old.SearchIndexed('suffix', 1).Hits).toHaveLength(0);
      expect(old.Search('suffix', 1)).toMatchObject([{ EntryId }]);
      if (action === 'dispose') {
        owner.dispose();
        expect(old.IndexStatus).toMatchObject({ IndexGeneration: 0, IsComplete: false });
        expect(old.Search('suffix', 1)).toMatchObject([{ EntryId }]);
        return;
      }
      const release = owner.retainOutput(BigInt(budget) - BigInt(before.EstimatedActiveBytes) - BigInt(before.EstimatedRetainedBytes) + 1n);
      try {
        expect(owner.getStatistics()).toMatchObject({ PendingIndexWork: 0, EstimatedIndexWorkBytes: 0, CompletedIndexJobs: 1 });
        expect(old.IndexStatus.IndexGeneration).toBe(0);
        const latest = owner.openRead(SessionId);
        try {
          expect(latest.IndexStatus).toMatchObject({ SessionRevision: 0, IndexGeneration: 1, IsComplete: true });
          expect(latest.SearchIndexed('suffix', 1).Hits).toMatchObject([{ EntryId }]);
        } finally { latest.dispose(); }
      } finally { release(); }
    } finally { old.dispose(); }
  } finally { owner.dispose(); }
});

it.each([
  ['release', ContextMutationStatus.Applied, 2],
  ['publish', ContextMutationStatus.RevisionConflict, 2],
  ['synchronize', ContextMutationStatus.SynchronizationRequired, 1],
  ['serialized-synchronize', ContextMutationStatus.Applied, 2],
] as const)('rechecks a partitioned candidate after worker-requested %s during reservation', async (action, status, revision) => {
  const budget = 16 * 1024 * 1024;
  const owner = new LLMContextOwner({
    ...defaultLLMContextOptions, AdmissionTimeoutMs: 2000, EstimatedResidentByteBudget: budget,
    IndexingMode: ContextIndexingMode.ProducerOwned, PartitionedIndex: defaultPartitionedContextIndexOptions,
    SerializeSessionPreparation: action === 'serialized-synchronize',
  });
  const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const SessionId = id(1), EntryId = id(3);
  expect(owner.createSession({
    SessionId, UserId: id(2), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
    Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [{
      EntryId, Sequence: 0, Role: ContextRole.User,
      CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('base'), IndexKeys: ['base'],
    }] }]]),
    Anchors: new Map(),
  }).Status).toBe(ContextMutationStatus.Applied);
  const replace = (ExpectedRevision: number, key: string) => owner.applySession({
    SessionId, ExpectedRevision, Changes: [{ kind: 'ReplaceEntry', EntryId, Content: new TextContent(key), IndexKeys: [key] }],
  });
  expect(replace(0, 'dirty').Status).toBe(ContextMutationStatus.Applied);
  const release = owner.retainOutput(BigInt(budget) - BigInt(owner.getStatistics().EstimatedActiveBytes));
  let released = false;
  let concurrentStatus: ContextMutationStatus | undefined;
  let synchronization: ReturnType<LLMContextOwner['synchronizeIndexAsync']> | undefined;
  const { port, wake } = owner.attachAdmissionPeer((event) => {
    if (event !== 'release') return;
    release();
    released = true;
    if (action === 'publish') concurrentStatus = replace(1, 'winner').Status;
    if (action === 'synchronize' || action === 'serialized-synchronize') {
      synchronization = owner.synchronizeIndexAsync(SessionId);
    }
  });
  const worker = new Worker(`
    const { parentPort, workerData: { port, wake } } = require('node:worker_threads');
    parentPort.postMessage('ready');
    parentPort.once('message', () => {
      port.postMessage('release');
      Atomics.add(wake, 0, 1);
      Atomics.notify(wake, 0);
    });
  `, { eval: true, workerData: { port, wake }, transferList: [port] });
  try {
    await once(worker, 'message');
    worker.postMessage('reserving');
    expect(replace(1, 'candidate')).toMatchObject({ Status: status, Revision: revision });
    expect(released).toBe(true);
    if (action === 'publish') expect(concurrentStatus).toBe(ContextMutationStatus.Applied);
    if (action === 'synchronize' || action === 'serialized-synchronize') {
      expect(synchronization).toBeDefined();
      await expect(synchronization).resolves.toMatchObject({ Succeeded: true, PartitionsCompacted: 1, ContentRevision: revision });
    }
    const expectedKey = {
      release: 'candidate', publish: 'winner', synchronize: 'dirty', 'serialized-synchronize': 'candidate',
    }[action];
    const read = owner.openRead(SessionId);
    try {
      expect(read.Session.Revision).toBe(revision);
      expect(read.SearchKeys([expectedKey], 1)).toMatchObject([{ EntryId }]);
    } finally { read.dispose(); }
    expect(owner.getStatistics()).toMatchObject({ EstimatedPreparationBytes: 0, EstimatedViewBytes: 0, PendingSynchronizations: 0 });
  } finally {
    if (!released) release();
    owner.dispose();
    await worker.terminate();
  }
});

it('admits the pre-wait capture after a worker requests publication and release', async () => {
  const sessionId = '00000000-0000-0000-0000-000000000001';
  const start = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let captures = 0;
  const owner = new LLMContextOwner({
    ...defaultLLMContextOptions, AdmissionTimeoutMs: 2000, MaximumRetainedReads: 1,
    TimeProvider: { now() {
      if (++captures === 2) {
        Atomics.store(start, 0, 1);
        Atomics.notify(start, 0);
      }
      return 0;
    } },
  });

  expect(owner.createSession({
    SessionId: sessionId, UserId: '00000000-0000-0000-0000-000000000002', RepositoryId: null,
    Revision: 0, Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
  }).Status).toBe(ContextMutationStatus.Applied);
  const first = owner.openRead(sessionId);
  let published: ContextMutationStatus | undefined;
  const { port, wake } = owner.attachAdmissionPeer((event) => {
    if (event !== 'publish-and-release') return;
    published = owner.applySession({ SessionId: sessionId, ExpectedRevision: 0, Changes: [
      { kind: 'AppendEntries', Entries: [{
        EntryId: '00000000-0000-0000-0000-000000000003', Role: ContextRole.User,
        CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('concurrent update'),
      }] },
    ] }).Status;
    first.dispose();
  });
  const worker = new Worker(`
    const { parentPort, workerData: { port, start, wake } } = require('node:worker_threads');
    parentPort.postMessage('ready');
    if (Atomics.wait(start, 0, 0, 2000) !== 'timed-out') {
      port.postMessage('publish-and-release');
      Atomics.add(wake, 0, 1);
      Atomics.notify(wake, 0);
    }
    port.close();
  `, { eval: true, workerData: { port, start, wake }, transferList: [port] });
  try {
    await once(worker, 'message');
    const admitted = owner.openRead(sessionId);
    try {
      expect(published).toBe(ContextMutationStatus.Applied);
      expect(admitted.Session.Revision).toBe(0);
      expect(owner.tryFindSession(sessionId)?.Revision).toBe(1);
      expect(admitted.ReadRange(0, 4)).toHaveLength(0);
    } finally { admitted.dispose(); }
    expect(owner.getStatistics().RetainedReads).toBe(0);
  } finally {
    first.dispose();
    owner.dispose();
    await worker.terminate();
  }
});

it.each([false, true])('waits for create admission and rechecks the ID reservation (competing create: %s)', async (competing) => {
  const budget = 8192;
  const owner = new LLMContextOwner({
    ...defaultLLMContextOptions, AdmissionTimeoutMs: 2000, EstimatedResidentByteBudget: budget,
  });
  const sessionId = '00000000-0000-0000-0000-000000000001';
  const session = {
    SessionId: sessionId, UserId: '00000000-0000-0000-0000-000000000002', RepositoryId: null,
    Revision: 0, Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
  };
  const release = owner.retainOutput(BigInt(budget) - BigInt(owner.getStatistics().EstimatedActiveBytes));
  let released = false;
  let competingStatus: ContextMutationStatus | undefined;
  const { port, wake } = owner.attachAdmissionPeer((event) => {
    if (event !== 'release') return;
    release();
    released = true;
    if (competing) {
      competingStatus = owner.createSession({ ...session, Revision: 1 }).Status;
      owner.removeSession(sessionId, 1);
    }
  });
  const worker = new Worker(`
    const { parentPort, workerData: { port, wake } } = require('node:worker_threads');
    parentPort.postMessage('ready');
    parentPort.once('message', () => {
      port.postMessage('release');
      Atomics.add(wake, 0, 1);
      Atomics.notify(wake, 0);
    });
  `, { eval: true, workerData: { port, wake }, transferList: [port] });
  try {
    await once(worker, 'message');
    worker.postMessage('creating');
    const result = owner.createSession(session);
    expect(released).toBe(true);
    if (competing) {
      expect(competingStatus).toBe(ContextMutationStatus.Applied);
      expect(result).toMatchObject({
        Status: ContextMutationStatus.InvalidOperation, Error: 'Session identity was admitted while waiting.',
      });
      expect(owner.tryFindSession(sessionId)).toBeNull();
    } else {
      expect(result.Status).toBe(ContextMutationStatus.Applied);
      expect(owner.tryFindSession(sessionId)?.Revision).toBe(0);
    }
    expect(owner.getStatistics().EstimatedViewBytes).toBe(0);
  } finally {
    if (!released) release();
    owner.dispose();
    await worker.terminate();
  }
});

describe('resident publication and output admission', () => {
  it.each(['speculative session', 'serialized session', 'memory'])('keeps the %s publication gate while waiting for resident capacity', async (catalog) => {
    const budget = 8192;
    let estimates = 0;
    const owner = new LLMContextOwner({
      ...defaultLLMContextOptions, AdmissionTimeoutMs: 2000, EstimatedResidentByteBudget: budget,
      SerializeSessionPreparation: catalog === 'serialized session',
      EntrySizeEstimator: (entry) => {
        estimates++;
        return defaultLLMContextOptions.EntrySizeEstimator(entry);
      },
    });
    const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    const sessionId = id(1);
    for (const SessionId of [sessionId, id(5)]) {
      expect(owner.createSession({
        SessionId, UserId: id(2), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
        Segments: new Map(), Anchors: new Map(),
      }).Status).toBe(ContextMutationStatus.Applied);
    }
    const write = () => catalog !== 'memory'
      ? owner.applySession({ SessionId: sessionId, ExpectedRevision: 0, Changes: [{ kind: 'AppendEntries', Entries: [{
        EntryId: id(3), Role: ContextRole.User, CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('append'),
      }] }] })
      : owner.applyMemory({ ExpectedRevision: 0, Deletes: [], Upserts: [{
        MemoryId: id(4), Scope: { UserId: id(2) }, Content: 'memory', Revision: 0,
        Status: MemoryStatus.Proposed, ExpiresAt: null, Sources: [],
      }] });
    const release = owner.retainOutput(BigInt(budget) - BigInt(owner.getStatistics().EstimatedActiveBytes));
    let released = false;
    let preparedWhileBusy = false;
    const observed: ContextMutationStatus[] = [];
    const { port, wake } = owner.attachAdmissionPeer((event) => {
      if (event !== 'release') return;
      release();
      released = true;
      const before = estimates;
      observed.push(write().Status, owner.removeSession(id(5), 0).Status);
      preparedWhileBusy = estimates > before;
    });
    const worker = new Worker(`
      const { parentPort, workerData: { port, wake } } = require('node:worker_threads');
      parentPort.postMessage('ready');
      parentPort.once('message', () => {
        port.postMessage('release');
        Atomics.add(wake, 0, 1);
        Atomics.notify(wake, 0);
      });
    `, { eval: true, workerData: { port, wake }, transferList: [port] });
    try {
      await once(worker, 'message');
      worker.postMessage('writing');
      expect(write()).toMatchObject({ Status: ContextMutationStatus.Applied, Revision: 1 });
      expect(observed).toEqual([ContextMutationStatus.AdmissionRejected, ContextMutationStatus.Applied]);
      expect(preparedWhileBusy).toBe(catalog === 'speculative session');
      expect(write().Status).toBe(ContextMutationStatus.RevisionConflict);
      expect(owner.getStatistics().EstimatedViewBytes).toBe(0);
    } finally {
      if (!released) release();
      owner.dispose();
      await worker.terminate();
    }
  });
  it('rechecks projected-output admission after an independent release', async () => {
    const owner = new LLMContextOwner({
      ...defaultLLMContextOptions, AdmissionTimeoutMs: 2000, MaximumEstimatedRetainedBytes: 32,
    });
    const releaseFirst = owner.retainOutput(32n);
    let released = false;
    const { port, wake } = owner.attachAdmissionPeer((event) => {
      if (event === 'release-output') {
        releaseFirst();
        released = true;
      }
    });
    const worker = new Worker(`
      const { parentPort, workerData: { port, wake } } = require('node:worker_threads');
      parentPort.postMessage('ready');
      parentPort.once('message', () => {
        port.postMessage('release-output');
        Atomics.add(wake, 0, 1);
        Atomics.notify(wake, 0);
      });
    `, { eval: true, workerData: { port, wake }, transferList: [port] });
    try {
      await once(worker, 'message');
      worker.postMessage('attempting-output');
      const releaseSecond = owner.retainOutput(24n);
      try {
        expect(released).toBe(true);
        expect(owner.getStatistics().EstimatedViewBytes).toBe(24);
      } finally { releaseSecond(); }
      expect(owner.getStatistics().EstimatedViewBytes).toBe(0);
    } finally {
      if (!released) releaseFirst();
      owner.dispose();
      await worker.terminate();
    }
  });
});
