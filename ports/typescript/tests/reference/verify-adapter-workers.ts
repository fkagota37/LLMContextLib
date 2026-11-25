// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { SemanticOracle } from '../../benchmarks/semantic-oracle.js';
import { sourceDigest } from '../../benchmarks/source-digest.js';
import { TextContent as OracleText, type ContextChangeSet, type LLMSessionContext } from '../../src/domain/session.js';
import type { WorkerContextEndpoint } from '../../src/runtime/worker-context-peer.js';

const consumer = process.argv[2];
assert(consumer, 'Pass the clean installed-package consumer directory.');
const entryPath = (name: string) => {
  const directory = resolve(consumer, 'node_modules', name);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  return resolve(directory, manifest.exports['.'].import);
};
const moduleUrl = (name: string) => pathToFileURL(entryPath(name)).href;
const coreUrl = moduleUrl('llmcontextlib-port-typescript');
const core = await import(coreUrl) as typeof import('../../src/index.js');
const lucene = await import(moduleUrl('llmcontextlib-port-typescript-lucene')) as typeof import('../../adapters/lucene/index.js');
const bitfaster = await import(moduleUrl('llmcontextlib-port-typescript-bitfaster')) as typeof import('../../adapters/bitfaster/index.js');
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const now = '1970-01-01T00:00:00Z';
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));
const initial = (Content: typeof OracleText): LLMSessionContext[] => [0, 1, 2].map((session) => ({
  SessionId: id(session + 1), UserId: id(10), RepositoryId: null, Revision: 0, Status: core.SessionStatus.Active,
  Segments: new Map([[0, { SegmentId: 0, Revision: 0,
    Entries: Array.from({ length: session === 2 ? 4 : 1 }, (_, Sequence) => ({
      EntryId: id(100 + session * 10 + Sequence), Sequence, Role: core.ContextRole.User, CreatedAt: now,
      Content: new Content(session === 2 ? `hot${Sequence} suffix` : 'base suffix'),
    })),
  }]]), Anchors: new Map(),
}));
const source = `
  const { parentPort, workerData: data } = require('node:worker_threads');
  const assert = require('node:assert/strict');
  import(data.module).then(async ({ WorkerContextPeer, TextContent }) => {
    const peer = new WorkerContextPeer(data.endpoint);
    const old = peer.openReadLease(data.session);
    const journal = [];
    try {
      for (let round = 0; round < 16; round++) {
        const phase = round % 2;
        const arrived = Atomics.add(data.barrier, phase, 1);
        if (arrived % 2 === 0)
          assert.notEqual(Atomics.wait(data.barrier, phase, arrived + 1, 8000), 'timed-out');
        else Atomics.notify(data.barrier, phase);
        const text = 'hot' + (round % 4) + ' suffix';
        const change = { SessionId: data.session, ExpectedRevision: round, Changes: [
          { kind: 'ReplaceEntry', EntryId: data.entry, Content: new TextContent(text) },
        ] };
        const terminal = peer.apply(change);
        assert.equal(terminal.Status, 'Applied');
        await peer.waitForIndexingAsync(data.session, round + 1, AbortSignal.timeout(8000));
        peer.withCurrent(data.session, (read) => {
          journal.push({ round, terminal, entries: read.ReadRange(0, 8), hits: read.Search('hot' + (round % 4), 8) });
        });
        assert.equal(old.Session.Revision, 0);
        assert.equal(old.Search('base', 1)[0].EntryId, data.entry);
      }
      parentPort.postMessage(journal);
    } finally { old.dispose(); peer.dispose(); }
  }).catch((error) => { setImmediate(() => { throw error; }); });
`;
async function worker(endpoint: WorkerContextEndpoint, index: number, barrier: Int32Array) {
  const thread = new Worker(source, { eval: true, execArgv: [], transferList: [endpoint.port], workerData: {
    module: coreUrl, endpoint, session: id(index + 1), entry: id(100 + index * 10), barrier,
  } });
  try {
    const [[journal]] = await Promise.all([
      once(thread, 'message'),
      once(thread, 'exit').then(([code]) => assert.equal(code, 0)),
    ]);
    return journal as { round: number; terminal: { Status: string; Revision: number }; entries: unknown; hits: unknown }[];
  } finally { await thread.terminate(); }
}

for (const provider of ['Native', 'LuceneRangeBuffer', 'LuceneCharTerm']) {
  for (const memo of [false, true]) {
    for (const deferred of [false, true]) {
      let builder = core.LLMContextFactory.Create({
        DeferredIndexing: deferred ? { ...core.defaultDeferredIndexingOptions, ForegroundWords: 1 } : null,
      }).WithExecutionStrategies();
      if (provider !== 'Native') builder = lucene.WithLuceneTermCollection(builder,
        provider === 'LuceneRangeBuffer' ? lucene.LuceneTermCollection.RangeBuffer : lucene.LuceneTermCollection.CharTerm);
      if (memo) builder = bitfaster.WithBitFasterTermMemoization(builder);
      // Seed the shared hot set before callers start; concurrent misses are not assumed exactly-once.
      const owner = builder.Initialize(initial(core.TextContent));
      const oracle = new SemanticOracle(initial(OracleText), now);
      try {
        for (let session = 0; session < 3; session++) await owner.WaitForIndexingAsync(id(session + 1), 0);
        const before = owner.GetStatistics().Execution!;
        const barrier = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
        const journals = await Promise.all([0, 1].map((index) =>
          worker(core.LLMContextFactory.CreateWorkerEndpoint(owner), index, barrier)));
        let terminals = 0;
        for (let session = 0; session < journals.length; session++) {
          for (const step of journals[session]) {
            const change: ContextChangeSet = { SessionId: id(session + 1), ExpectedRevision: step.round, Changes: [
              { kind: 'ReplaceEntry', EntryId: id(100 + session * 10), Content: new OracleText(`hot${step.round % 4} suffix`) },
            ] };
            const expected = oracle.Apply(change);
            assert.deepEqual({ Status: step.terminal.Status, Revision: step.terminal.Revision }, expected);
            const read = oracle.Capture(change.SessionId);
            assert.deepEqual(normalize(step.entries), normalize(read.Read({ Kind: 'Range', FromSequence: 0, Limit: 8 }).Entries));
            assert.deepEqual(normalize(step.hits), normalize(read.Read({ Kind: 'Search', Query: `hot${step.round % 4}`, Limit: 8 }).Hits));
            terminals++;
          }
        }
        assert.equal(terminals, 32);
        const after = owner.GetStatistics();
        assert.equal(after.RetainedReads, 0);
        assert.equal(after.EstimatedViewBytes, 0);
        assert.equal(after.EstimatedPreparationBytes, 0);
        assert.equal(after.PendingIndexWork, 0);
        if (memo) {
          assert.equal(BigInt(after.Execution!.MemoHits) - BigInt(before.MemoHits), 32n);
          assert.equal(after.Execution!.TermCollections, before.TermCollections);
          assert.equal(after.Execution!.MemoMisses, before.MemoMisses);
          assert.equal(after.Execution!.MemoEntries, 5);
        }
        const retainedKeys: string[] = [];
        if (memo) for (let key = 0; key < 4; key++) {
          const previous = owner.GetStatistics().Execution!;
          const revision = owner.TryFind(id(1))!.Revision;
          assert.equal(owner.Apply({ SessionId: id(1), ExpectedRevision: revision, Changes: [
            { kind: 'ReplaceEntry', EntryId: id(100), Content: new core.TextContent(`hot${key} suffix`) },
          ] }).Status, 'Applied');
          const current = owner.GetStatistics().Execution!;
          assert.equal(current.TermCollections, previous.TermCollections);
          assert.equal(BigInt(current.MemoHits) - BigInt(previous.MemoHits), 1n);
          retainedKeys.push(createHash('sha256').update(`hot${key} suffix`, 'utf16le').digest('hex'));
        }
        const final = owner.GetStatistics();
        assert.equal(final.RetainedReads, 0);
        assert.equal(final.EstimatedViewBytes, 0);
        assert.equal(final.EstimatedPreparationBytes, 0);
        assert.equal(final.PendingIndexWork, 0);
        if (memo) {
          assert.equal(BigInt(final.Execution!.MemoHits) - BigInt(after.Execution!.MemoHits), 4n);
          assert.equal(final.Execution!.MemoEntries, 5);
        }
        console.log(JSON.stringify({ diagnostic: 'installed-adapter-workers', runtime: process.version, v8: process.versions.v8,
          architecture: process.arch, execArgv: process.execArgv, sourceSha256: sourceDigest(),
          fixtureSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
          packages: ['llmcontextlib-port-typescript', 'llmcontextlib-port-typescript-lucene', 'llmcontextlib-port-typescript-bitfaster']
            .map((name) => ({ name, entrySha256: createHash('sha256').update(readFileSync(entryPath(name))).digest('hex') })),
          provider, memo, deferred, terminals, probeTerminals: retainedKeys.length,
          totalMutationTerminals: terminals + retainedKeys.length, independentWorkerCallers: 2,
          service: 'Owner-serialized composed collectors/memos; no CPU-parallel service claim.',
          before, after: after.Execution, afterProbes: final.Execution, retainedKeys,
          cleanup: { reads: final.RetainedReads, output: final.EstimatedViewBytes,
            preparation: final.EstimatedPreparationBytes, pendingIndexWork: final.PendingIndexWork } }));
      } finally { owner.dispose(); }
    }
  }
}
