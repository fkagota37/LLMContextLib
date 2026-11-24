// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
const output = resolve('dist');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run test:packages after building the packages.');
const consumer = mkdtempSync(join(output, 'consumer-'));

const install = (...names) => execFileSync(process.execPath, [
  npm, 'install', '--no-package-lock', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
  ...names.map((module) => join(output, `${module}-${version}.tgz`)),
], { cwd: consumer, stdio: 'inherit' });
const check = (code) => execFileSync(process.execPath, ['--input-type=module', '--eval', code],
  { cwd: consumer, stdio: 'inherit' });
const lucene = `${name}-lucene`;
const bitfaster = `${name}-bitfaster`;
try {
  writeFileSync(join(consumer, 'package.json'), '{"name":"package-consumer","private":true}\n');
  install(name);
  copyFileSync(join('examples', 'write-optimized-smoke.mjs'), join(consumer, 'write-optimized-smoke.mjs'));
  execFileSync(process.execPath, ['write-optimized-smoke.mjs'], { cwd: consumer, stdio: 'inherit' });
  check(`
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { Worker } from 'node:worker_threads';
    import { ContextRole, LLMContextFactory, SessionStatus, TextContent, defaultDeferredIndexingOptions } from '${name}';
    import * as core from '${name}';
    await assert.rejects(import('${lucene}'), { code: 'ERR_MODULE_NOT_FOUND' });
    await assert.rejects(import('${bitfaster}'), { code: 'ERR_MODULE_NOT_FOUND' });
    for (const internal of ['LLMContextOwner', 'SessionStore', 'ContextIndexPartition', 'PartitionedContextIndex', 'DeferredIndexLifecycle']) {
      assert.equal(Object.hasOwn(core, internal), false, internal);
    }
    await assert.rejects(import('${name}/storage/partitioned-index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    assert.equal(core.defaultPartitionedContextIndexOptions.WriteBehavior, core.ContextSynchronizationWriteBehavior.Reject);
    const payload = new TextContent('installed content');
    const copy = core.ContextContentRecords.clone(payload);
    assert.notEqual(copy, payload);
    assert(core.ContextContentRecords.equals(copy, payload));
    const cursor = { SessionId: '00000000-0000-0000-0000-000000000001', Revision: 7n, AfterSequence: 9 };
    const cursors = core.ContextScalarRecords.ContextCursor;
    assert(cursors.equals(cursor, { ...cursors.clone(cursor), Revision: 7 }));
    assert.deepEqual(cursors.deconstruct(cursor), [cursor.SessionId, 7, 9]);
    const replacement = { kind: 'ReplaceEntry', EntryId: cursor.SessionId, Content: payload, IndexKeys: ['opaque'] };
    const replacements = core.ContextEntryRecords.ReplaceEntry;
    assert(replacements.equals(replacement, replacements.clone(replacement)));
    assert(!replacements.equals(replacement, { ...replacement, IndexKeys: ['opaque'] }));
    const owner = LLMContextFactory.Create().Initialize([]);
    assert.equal(owner.GetStatistics().Sessions, 0);
    owner.dispose();
    const SessionId = '00000000-0000-0000-0000-000000000001';
    const EntryId = '00000000-0000-0000-0000-000000000003';
    const deferred = LLMContextFactory.Create({
      DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundWords: 1 },
    }).Initialize([{
      SessionId, UserId: '00000000-0000-0000-0000-000000000002', RepositoryId: null,
      Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [{
        EntryId, Sequence: 0, Role: ContextRole.User,
        CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('prefix suffix'),
      }] }]]),
      Anchors: new Map(),
    }]);
    try {
      await deferred.WaitForIndexingAsync(SessionId, 0, AbortSignal.timeout(8000));
      assert.equal(deferred.WithCurrent(SessionId, (read) => read.SearchIndexed('suffix', 1).Hits[0]?.EntryId), EntryId);
      assert.equal(deferred.GetStatistics().PendingIndexWork, 0);
      const endpoint = LLMContextFactory.CreateWorkerEndpoint(deferred);
      const workerSource = function () {
        const { parentPort, workerData } = require('node:worker_threads');
        const assert = require('node:assert/strict');
        import(workerData.module).then(async ({ WorkerContextPeer, TextContent }) => {
          const id = workerData.SessionId;
          if (workerData.projection) {
            const value = () => 'original';
            const definition = { SessionId: id, MaximumResults: 1, *Evaluate() { yield value; } };
            const expected = new Error('estimator failed');
            let estimate = 123n;
            let evaluations = 0;
            const options = { ProjectionSizeEstimator(item) {
              assert.equal(item, value);
              evaluations++;
              if (estimate < 0n) throw expected;
              return estimate;
            } };
            if (workerData.projection === 'not-authorized') {
              assert.throws(() => new WorkerContextPeer(workerData.endpoint, options), { code: 'NotSupported' });
              const peer = new WorkerContextPeer(workerData.endpoint);
              try { assert.throws(() => peer.openView(definition), { code: 'NotSupported' }); }
              finally { peer.dispose(); }
              parentPort.postMessage('not-authorized');
              return;
            }
            const peer = new WorkerContextPeer(workerData.endpoint, options);
            try {
              const view = peer.openView(definition);
              try {
                assert.equal(view.at(0), value);
                assert.equal(peer.getStatistics().EstimatedViewBytes, 123);
              } finally { view.dispose(); }
              estimate = -1n;
              assert.throws(() => peer.openView(definition), (error) => error === expected);
              estimate = 0n;
              assert.throws(() => peer.openView(definition), RangeError);
              estimate = 9_000_000_000_000_000_000n;
              assert.throws(() => peer.openView(definition), { code: 'InvalidOperation', message: 'Projected-view budget exhausted.' });
              assert.equal(evaluations, 4);
              assert.equal(peer.getStatistics().EstimatedViewBytes, 0);
              assert.equal(peer.getStatistics().RetainedReads, 0);
            } finally { peer.dispose(); }
            parentPort.postMessage('custom-estimator');
            return;
          }
          const peer = new WorkerContextPeer(workerData.endpoint);
          let escaped;
          try {
            if (workerData.partitioned) {
              const { label, barrier, rewriteAt } = workerData.partitioned;
              if (rewriteAt !== undefined) {
                const entries = peer.withCurrent(id, (lease) => lease.ReadRange(0, 1));
                const rewrite = peer.apply({ SessionId: id, ExpectedRevision: rewriteAt, Changes: [{
                  kind: 'ReplaceSegment', SegmentId: 0,
                  Entries: entries.map((entry) => ({ ...entry, Content: new TextContent('segment'), IndexKeys: ['segment'] })),
                }] });
                assert.equal(rewrite.Status, 'Applied');
                assert.equal(peer.withCurrent(id, (lease) => lease.SearchKeys(['segment'], 1)[0].SessionRevision), rewriteAt + 1);
                const result = peer.apply({ SessionId: id, ExpectedRevision: rewriteAt + 1, Changes: [
                  { kind: 'ReplaceEntry', EntryId: workerData.EntryId, Content: new TextContent('discarded'), IndexKeys: ['discarded'] },
                  { kind: 'DeleteEntry', EntryId: workerData.EntryId },
                  { kind: 'AppendEntries', Entries: [{
                    EntryId: '', Role: entries[0].Role, CreatedAt: entries[0].CreatedAt,
                    Content: new TextContent('append'), IndexKeys: ['append'],
                  }] },
                ] });
                assert.equal(result.Status, 'Applied');
                assert.equal(result.AppendedEntryIds.length, 1);
                parentPort.postMessage(result.AppendedEntryIds[0]);
                return;
              }
              const meet = (phase) => {
                if (Atomics.add(barrier, phase, 1) === 0) {
                  assert.notEqual(Atomics.wait(barrier, phase, 1, 8000), 'timed-out');
                } else Atomics.notify(barrier, phase);
              };
              const capture = peer.openReadLease(id);
              const local = () => label;
              const view = peer.openView({ SessionId: id, MaximumResults: 1, *Evaluate(read) {
                assert.equal(read.SearchKeys(['prefix'], 1)[0].EntryId, workerData.EntryId);
                yield local;
                throw new Error('View consumed beyond its bound.');
              } });
              try {
                meet(0);
                const intermediate = label + '-intermediate';
                const result = peer.apply({ SessionId: id, ExpectedRevision: 0, Changes: [intermediate, label].map((key) => ({
                  kind: 'ReplaceEntry', EntryId: workerData.EntryId, Content: new TextContent(key), IndexKeys: [key],
                })) });
                meet(1);
                if (result.Status === 'Applied') {
                  const synchronization = await peer.synchronizeIndexAsync(id);
                  assert.equal(synchronization.Succeeded, true);
                  assert.equal(synchronization.ContentRevision, 1);
                  assert.equal(synchronization.PartitionsCompacted, 1);
                  peer.withCurrent(id, (lease) => {
                    assert.equal(lease.SearchKeys([label], 1)[0].SessionRevision, 1);
                    assert.deepEqual(lease.SearchKeys([intermediate], 1), []);
                  });
                }
                assert.equal(capture.SearchKeys(['prefix'], 1)[0].SessionRevision, 0);
                assert.equal(view.SessionRevision, 0);
                assert.equal(view.at(0), local);
                assert(peer.getStatistics().EstimatedViewBytes >= 128);
                parentPort.postMessage({ status: result.Status, label });
              } finally {
                view.dispose();
                assert.throws(() => view.at(0), { code: 'Disposed' });
                capture.dispose();
              }
              return;
            }
            peer.withCurrent(id, (lease) => { escaped = lease; });
            assert.equal(peer.getStatistics().RetainedReads, 0);
            await peer.waitForIndexingAsync(id, 0, AbortSignal.timeout(8000));
            assert.throws(() => escaped.Session, { code: 'Disposed' });
            peer.withCurrent(id, (lease) => {
              assert.equal(peer.getStatistics().RetainedReads, 0);
              const entry = lease.ReadRange(0, 1)[0];
              assert(entry.Content instanceof TextContent);
              assert.equal(peer.getStatistics().RetainedReads, 1);
              assert.equal(lease.Session.Segments.get(0).Entries[0].EntryId, entry.EntryId);
              assert.equal(lease.SearchIndexed('suffix', 1).Hits[0].EntryId, entry.EntryId);
            });
            assert.equal(peer.getStatistics().RetainedReads, 0);
            assert.throws(() => peer.openView({ SessionId: id, MaximumResults: 1, *Evaluate() {
              yield 'x'.repeat(34 * 1024 * 1024);
            } }), { code: 'InvalidOperation' });
            assert.equal(peer.getStatistics().RetainedReads, 0);
            assert.equal(peer.getStatistics().EstimatedViewBytes, 0);
            const initial = peer.tryFindSession(id);
            const newId = '00000000-0000-0000-0000-000000000004';
            assert.equal(peer.tryFindSession(newId), null);
            assert.equal(peer.createSession({ ...initial, SessionId: newId }).Status, 'Applied');
            assert.equal(peer.withCurrent(newId, (read) => read.Search('prefix', 1)[0].EntryId), workerData.EntryId);
            assert.equal(peer.removeSession(newId, 0).Status, 'Applied');
            assert.equal(peer.tryFindSession(newId), null);
          } finally { peer.dispose(); }
          parentPort.postMessage('verified');
        }).catch((error) => { setImmediate(() => { throw error; }); });
      };
      const verifyWorker = async (endpoint, partitioned = false, projection = null) => {
        const worker = new Worker('(' + workerSource.toString() + ')()', {
          eval: true, execArgv: [], workerData: { endpoint, SessionId, EntryId, partitioned, projection, module: import.meta.resolve('${name}') },
          transferList: [endpoint.port],
        });
        try {
          const [[result]] = await Promise.all([
            once(worker, 'message'), once(worker, 'exit').then(([code]) => assert.equal(code, 0)),
          ]);
          return result;
        }
        finally { await worker.terminate(); }
      };
      assert.equal(await verifyWorker(endpoint), 'verified');
      assert.equal(deferred.GetStatistics().RetainedReads, 0);
      const initial = deferred.TryFind(SessionId);
      const custom = LLMContextFactory.Create({ ProjectionSizeEstimator(item) {
        assert.equal(typeof item, 'symbol');
        return 73;
      } }).Initialize([initial]);
      try {
        assert.equal(await verifyWorker(LLMContextFactory.CreateWorkerEndpoint(custom), false, 'not-authorized'), 'not-authorized');
        assert.equal(await verifyWorker(LLMContextFactory.CreateWorkerEndpoint(custom, { AllowWorkerProjectionEstimator: true }),
          false, 'authorized'), 'custom-estimator');
        const ownerValue = Symbol('owner-local');
        const view = custom.OpenView({ SessionId, MaximumResults: 1, *Evaluate() { yield ownerValue; } });
        try {
          assert.equal(view.at(0), ownerValue);
          assert.equal(custom.GetStatistics().EstimatedViewBytes, 73);
        } finally { view.dispose(); }
        assert.equal(custom.GetStatistics().EstimatedViewBytes, 0);
        assert.equal(custom.GetStatistics().RetainedReads, 0);
      } finally { custom.dispose(); }
      const segment = initial.Segments.get(0);
      const partitioned = LLMContextFactory.Create(core.LLMContextOptions.WriteOptimized).Initialize([{
        ...initial,
        Segments: new Map([[0, { ...segment, Entries: segment.Entries.map((entry) => ({ ...entry, IndexKeys: ['prefix'] })) }]]),
      }]);
      try {
        const barrier = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
        let peakPreparationBytes = 0;
        const observer = setInterval(() => {
          peakPreparationBytes = Math.max(peakPreparationBytes, Number(partitioned.GetStatistics().EstimatedPreparationBytes));
        }, 1);
        let results;
        try {
          results = await Promise.all(['left', 'right'].map((label) =>
            verifyWorker(LLMContextFactory.CreateWorkerEndpoint(partitioned), { label, barrier })));
        } finally { clearInterval(observer); }
        assert(peakPreparationBytes > 320_000, 'Both captured replacement batches must be reserved concurrently.');
        assert.deepEqual(results.map(({ status }) => status).sort(), ['Applied', 'RevisionConflict']);
        const { label: winner } = results.find(({ status }) => status === 'Applied');
        const { label: loser } = results.find(({ status }) => status === 'RevisionConflict');
        partitioned.WithCurrent(SessionId, (read) => {
          assert.equal(read.Session.Revision, 1);
          assert.equal(read.SearchKeys([winner], 1)[0].EntryId, EntryId);
          assert.deepEqual(read.SearchKeys([loser], 1), []);
          assert.deepEqual(read.SearchKeys(['prefix'], 1), []);
        });
        const appended = await verifyWorker(LLMContextFactory.CreateWorkerEndpoint(partitioned), { rewriteAt: 1 });
        assert.notEqual(appended, EntryId);
        partitioned.WithCurrent(SessionId, (read) => {
          assert.equal(read.Session.Revision, 3);
          assert.deepEqual(read.SearchKeys([winner], 1), []);
          assert.deepEqual(read.SearchKeys(['segment'], 1), []);
          assert.deepEqual(read.SearchKeys(['discarded'], 1), []);
          assert.equal(read.SearchKeys(['append'], 1)[0].EntryId, appended);
        });
        assert.equal(partitioned.GetStatistics().PendingSynchronizations, 0);
        assert.equal(partitioned.GetStatistics().RetainedReads, 0);
        assert.equal(partitioned.GetStatistics().EstimatedViewBytes, 0);
      } finally { partitioned.dispose(); }
    } finally { deferred.dispose(); }
  `);
  install(lucene, bitfaster);
  check(`
    import assert from 'node:assert/strict';
    import { ContextRole, LLMContextFactory, SessionStatus, TextContent, defaultDeferredIndexingOptions } from '${name}';
    import { LuceneTermCollection, WithLuceneTermCollection } from '${lucene}';
    import { WithBitFasterTermMemoization } from '${bitfaster}';
    const owner = WithBitFasterTermMemoization(WithLuceneTermCollection(LLMContextFactory.Create())).Initialize([]);
    assert.equal(owner.GetStatistics().Execution.TermCollector, 'LuceneRangeBuffer');
    assert.equal(owner.GetStatistics().Execution.TermMemo, 'BitFasterConcurrentLru');
    owner.dispose();
    const SessionId = '00000000-0000-0000-0000-000000000001';
    const EntryId = '00000000-0000-0000-0000-000000000003';
    for (const collector of [LuceneTermCollection.RangeBuffer, LuceneTermCollection.CharTerm]) {
      const builder = LLMContextFactory.Create({
        DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundWords: 1 },
      });
      const deferred = WithBitFasterTermMemoization(WithLuceneTermCollection(builder, collector)).Initialize([{
        SessionId, UserId: '00000000-0000-0000-0000-000000000002', RepositoryId: null,
        Revision: 0, Status: SessionStatus.Active,
        Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [{
          EntryId, Sequence: 0, Role: ContextRole.User,
          CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('prefix suffix'),
        }] }]]),
        Anchors: new Map(),
      }]);
      try {
        await deferred.WaitForIndexingAsync(SessionId, 0, AbortSignal.timeout(8000));
        assert.equal(deferred.WithCurrent(SessionId, (read) => read.SearchIndexed('suffix', 1).Hits[0]?.EntryId), EntryId);
        assert.equal(deferred.GetStatistics().Execution.MemoEntries, 1);
        assert.equal(deferred.GetStatistics().Execution.TermCollections, 1);
      } finally { deferred.dispose(); }
    }
  `);
  execFileSync(process.execPath, ['--import', 'tsx', 'tests\\reference\\verify-adapter-workers.ts', consumer],
    { stdio: 'inherit', timeout: 120_000 });
  console.log('Verified standalone core and both installed adapter packages.');
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
