// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { TextContent, type ContextChangeSet, type ContextEntry } from '../src/domain/session.js';
import { defaultLLMContextOptions } from '../src/options.js';
import { Entries } from '../src/policies/context.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { ConventionalParticipant } from './conventional-participant.js';
import { readReferenceFixture, restoreSession, type WireSession } from './reference-fixture.js';
import { SemanticOracle } from './semantic-oracle.js';
import { sourceDigest } from './source-digest.js';

const participants = ['Native', 'Scan', 'Indexed'] as const;
const sizes = [2048, 16384];
const [fixtures, iterationsArgument, selected, sizeArgument] = process.argv.slice(2);
const iterations = Number(iterationsArgument ?? 32);
assert(fixtures && Number.isInteger(iterations) && iterations > 0 && iterations <= 128,
  'Usage: contention-pressure.ts <pinned-fixture-directory> [iterations]');
if (selected === undefined) {
  for (const participant of participants) {
    for (const size of sizes) {
      execFileSync(process.execPath, [...process.execArgv, process.argv[1], fixtures, String(iterations), participant, String(size)],
        { stdio: 'inherit', timeout: 120_000 });
    }
  }
} else {
  const participant = participants.find((value) => value === selected), size = Number(sizeArgument);
  assert(participant && sizes.includes(size));
  await run(participant, size);
}

async function run(participant: typeof participants[number], size: number) {
  const raw = readFileSync(join(fixtures, `pressure-${size}.json`), 'utf8').replace(/^\uFEFF/, '');
  const { Now, Sessions } = readReferenceFixture<{ Now: string; Sessions: WireSession[] }>(raw);
  assert.equal(Sessions.length, 1);
  const session = restoreSession(Sessions[0]);
  const { SessionId } = session;
  const originals = [...Entries(session)];
  assert.equal(originals.length, size);
  const range = { Kind: 'Range' as const, FromSequence: 0, Limit: size };
  const command = (revision: number | bigint, value: string): ContextChangeSet => ({
    SessionId, ExpectedRevision: revision, Changes: [
      { kind: 'ReplaceEntry', EntryId: originals[4].EntryId, Content: new TextContent(value) },
    ],
  });
  const create = () => {
    const owner = participant === 'Native' ? new LLMContextOwner({
      ...defaultLLMContextOptions, EstimatedResidentByteBudget: 2 * 1024 ** 3,
      MaximumEstimatedRetainedBytes: 1024 ** 3, TimeProvider: { now: () => Date.parse(Now) },
    }) : undefined;
    owner?.initialize([session]);
    const conventional = owner ? undefined : new ConventionalParticipant([session], Now, participant === 'Indexed', 64);
    return {
      revision: () => owner ? owner.tryFindSession(SessionId)!.Revision : conventional!.Revision(SessionId),
      apply: (change: ContextChangeSet) => owner?.applySession(change) ?? conventional!.Apply(change),
      read() {
        if (conventional) {
          const result = conventional.Read(SessionId, range);
          return { revision: result.SessionRevision, entries: result.Entries };
        }
        const lease = owner!.openRead(SessionId);
        try { return { revision: lease.Session.Revision, entries: lease.ReadRange(0, size) }; }
        finally { lease.dispose(); }
      },
      captureCount: () => owner?.getStatistics().RetainedReads ?? conventional!.RetainedReads,
      dispose: () => owner?.dispose(),
    };
  };
  const warmUp = () => {
    const warm = create();
    try {
      for (let i = 0; i < 5; i++) {
        warm.read();
        assert.equal(warm.apply(command(i, `warm${i}`)).Status, 'Applied');
      }
    } finally { warm.dispose(); }
  };
  warmUp();
  const measured = create();
  const oracle = new SemanticOracle([session], Now);
  const memory = [{ phase: 'Initial', ...process.memoryUsage() }];
  const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const workers = Array.from({ length: 3 }, (_, worker) => new Worker(`
    const { parentPort, workerData: { barrier, worker } } = require('node:worker_threads');
    parentPort.postMessage('ready');
    parentPort.on('message', (round) => {
      const target = 3 * (round + 1);
      Atomics.add(barrier, 0, 1);
      Atomics.notify(barrier, 0);
      for (;;) {
        const observed = Atomics.load(barrier, 0);
        if (observed >= target) break;
        if (Atomics.wait(barrier, 0, observed, 30_000) === 'timed-out') throw new Error('Barrier timed out.');
      }
      parentPort.postMessage({ worker, round, sent: process.hrtime.bigint() });
    });
  `, { eval: true, workerData: { barrier, worker } }));
  const terminals = [];
  const normalize = (entries: readonly ContextEntry[]) => entries.map((entry) => ({ ...entry, IndexKeys: entry.IndexKeys }));
  try {
    await Promise.all(workers.map((worker) => once(worker, 'message')));
    const began = performance.now();
    for (let round = 0; round < iterations; round++) {
      const responses = workers.map((worker, id) => once(worker, 'message').then(([message]) => {
        const request = message as { worker: number; round: number; sent: bigint };
        assert.equal(request.worker, id);
        assert.equal(request.round, round);
        const start = process.hrtime.bigint();
        const category = id === 2 ? 'Writer' : 'LongReader';
        const result = category === 'Writer' ? measured.apply(command(measured.revision(), `version${round + 1}`)) : measured.read();
        const serviceMs = Number(process.hrtime.bigint() - start) / 1e6;
        return { result, category, worker: id, round, serviceMs, queueMs: Number(start - request.sent) / 1e6 };
      }));
      for (const worker of workers) worker.postMessage(round);
      const before = oracle.Capture(SessionId);
      const observed = await Promise.all(responses);
      const expected = oracle.Apply(command(round, `version${round + 1}`));
      const after = oracle.Capture(SessionId);
      for (const { result, ...timing } of observed) {
        if ('Status' in result) {
          assert.deepEqual({ Status: result.Status, Revision: result.Revision }, expected);
          terminals.push({ ...timing, status: result.Status, revision: result.Revision });
        } else {
          assert(result.revision === before.Revision || result.revision === after.Revision);
          const captured = result.revision === before.Revision ? before : after;
          assert.deepEqual(normalize(result.entries), normalize(captured.Read(range).Entries));
          terminals.push({ ...timing, status: 'Completed', revision: result.revision });
        }
      }
    }
    assert.equal(measured.revision(), iterations);
    assert.equal(measured.captureCount(), 0);
    memory.push({ phase: 'Final', ...process.memoryUsage() });
    console.log(JSON.stringify({ kind: 'ContentionPressure', participant, size, iterations, terminals, memory,
      elapsedMs: performance.now() - began,
      fixtureSha256: createHash('sha256').update(raw).digest('hex'), sourceDigest: sourceDigest(),
      runtime: { node: process.version, v8: process.versions.v8, arch: process.arch, execArgv: process.execArgv, argv: process.argv.slice(1) },
      evidenceLimits: 'Three dedicated request threads; the owner isolate serializes storage service. Not a parallel lock-cost comparison.' }));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    measured.dispose();
  }
}
