// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { ContextRole, TextContent, type ContextChangeSet } from '../src/domain/session.js';
import { defaultLLMContextOptions, type LLMContextOptions } from '../src/options.js';
import { Entries } from '../src/policies/context.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { ConventionalParticipant } from './conventional-participant.js';
import { readReferenceFixture, restoreSession, type WireSession } from './reference-fixture.js';
import { SemanticOracle } from './semantic-oracle.js';
import { sourceDigest } from './source-digest.js';

const participants = ['Native', 'Scan', 'Indexed'] as const;
const [fixturePath, selected] = process.argv.slice(2);
assert(fixturePath, 'Usage: admission-pressure.ts <pressure-512.json>');
if (selected === undefined) {
  for (const participant of participants) {
    execFileSync(process.execPath, [...process.execArgv, process.argv[1], fixturePath, participant],
      { stdio: 'inherit', timeout: 120_000 });
  }
} else {
  const participant = participants.find((value) => value === selected);
  assert(participant);
  await run(participant);
}

async function run(participant: typeof participants[number]) {
  const raw = readFileSync(fixturePath, 'utf8').replace(/^\uFEFF/, '');
  const { Now, Sessions } = readReferenceFixture<{ Now: string; Sessions: WireSession[] }>(raw);
  assert.equal(Sessions.length, 1);
  const session = restoreSession(Sessions[0]);
  const { SessionId } = session;
  const entries = [...Entries(session)];
  assert.equal(entries.length, 512);
  const nativeOptions = {
    ...defaultLLMContextOptions, EstimatedResidentByteBudget: 2 * 1024 ** 3, MaximumEstimatedRetainedBytes: 1024 ** 3,
    MaximumRetainedReads: 2, AdmissionTimeoutMs: 100, TimeProvider: { now: () => Date.parse(Now) },
  };
  const native = participant === 'Native';
  const requests: { category: string; status: string; iteration: number; elapsedMs: number }[] = [];
  const create = (overrides: Partial<LLMContextOptions> = {}) => {
    const owner = native ? new LLMContextOwner({ ...nativeOptions, ...overrides }) : undefined;
    owner?.initialize([session]);
    const conventional = owner ? undefined : new ConventionalParticipant([session], Now, participant === 'Indexed', 2);
    return {
      owner,
      revision: () => owner ? owner.tryFindSession(SessionId)!.Revision : conventional!.Revision(SessionId),
      apply: (command: ContextChangeSet) => owner?.applySession(command) ?? conventional!.Apply(command),
      hold: () => {
        if (conventional) {
          const capture = conventional.Capture(SessionId);
          return () => capture.Release();
        }
        const lease = owner!.openRead(SessionId);
        return () => lease.dispose();
      },
      entries: (count: number) => {
        if (conventional) return conventional.Read(SessionId, { Kind: 'Range', FromSequence: 0, Limit: count }).Entries;
        const lease = owner!.openRead(SessionId);
        try { return lease.ReadRange(0, count); }
        finally { lease.dispose(); }
      },
      stats: () => owner?.getStatistics(),
      held: () => owner?.getStatistics().RetainedReads ?? conventional!.RetainedReads,
      dispose: () => owner?.dispose(),
    };
  };
  const memory: (NodeJS.MemoryUsage & { phase: string; held: number; owner: ReturnType<ReturnType<typeof create>['stats']> })[] = [];
  const sample = (phase: string, context: ReturnType<typeof create>) =>
    memory.push({ phase, held: context.held(), owner: context.stats(), ...process.memoryUsage() });
  const measure = async (category: string, iteration: number, run: () => string | Promise<string>) => {
    const start = performance.now();
    const status = await run();
    requests.push({ category, status, iteration, elapsedMs: performance.now() - start });
    return status;
  };
  const read = (context: ReturnType<typeof create>) => {
    try { context.entries(1); return 'Completed'; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'Read-retention budget exhausted.') throw error;
      return 'Rejected';
    }
  };
  const untilCapacity = async (context: ReturnType<typeof create>) => {
    if (native) return read(context);
    const deadline = performance.now() + 100;
    while (read(context) === 'Rejected') {
      if (performance.now() >= deadline) return 'Rejected';
      await setTimeout(1);
    }
    return 'Completed';
  };
  const count = create();
  const releaseFirst = count.hold(), releaseSecond = count.hold();
  let releaseWorker: Worker | undefined;
  try {
    const endpoint = count.owner?.attachAdmissionPeer(releaseFirst);
    if (endpoint) {
      const { port, wake } = endpoint;
      releaseWorker = new Worker(`
        const { parentPort, workerData: { port, wake } } = require('node:worker_threads');
        parentPort.postMessage('ready');
        parentPort.once('message', () => setTimeout(() => {
          port.postMessage('release');
          Atomics.add(wake, 0, 1);
          Atomics.notify(wake, 0);
          port.close();
        }, 10));
      `, { eval: true, workerData: { port, wake }, transferList: [port] });
      await once(releaseWorker, 'message');
    }
    assert.equal(await measure('ReadCountTimeout', 0, () => untilCapacity(count)), 'Rejected');
    assert.equal(await measure('ReadCountRelease', 0, () => {
      if (releaseWorker) releaseWorker.postMessage('release');
      else void setTimeout(10).then(releaseFirst);
      return untilCapacity(count);
    }), 'Completed');
  } finally {
    releaseFirst();
    releaseSecond();
    assert.equal(count.held(), 0);
    count.dispose();
    await releaseWorker?.terminate();
  }
  const calibration = new LLMContextOwner(nativeOptions);
  calibration.initialize([session]);
  const active = BigInt(calibration.getStatistics().EstimatedActiveBytes);
  calibration.dispose();
  const retainedBudget = active + active / 2n;
  const retained = create({ MaximumEstimatedRetainedBytes: retainedBudget });
  const releaseRetained = retained.hold();
  try {
    assert.equal(retained.apply({ SessionId, ExpectedRevision: 0,
      Changes: [{ kind: 'ReplaceEntry', EntryId: entries[0].EntryId, Content: new TextContent('newroot') }],
    }).Status, 'Applied');
    assert.equal(await measure('RetainedByteRead', 0, () => read(retained)), native ? 'Rejected' : 'Completed');
    sample('retained-byte-limit', retained);
  } finally {
    releaseRetained();
    assert.equal(retained.held(), 0);
    retained.dispose();
  }

  const residentBudget = 2n * active + 96n * 1024n;
  const resident = create({ EstimatedResidentByteBudget: residentBudget });
  const oracle = new SemanticOracle([session], Now);
  const releaseResident = resident.hold();
  const append = (kind: number, i: number, marker: string) => {
    const command: ContextChangeSet = { SessionId, ExpectedRevision: resident.revision(), Changes: [
      { kind: 'AppendEntries', Entries: [{
        EntryId: `${i.toString(16).padStart(8, '0')}-0000-${kind.toString(16).padStart(4, '0')}-0000-000000000000`,
        Role: ContextRole.User, CreatedAt: Now, Content: new TextContent((`${marker} context ` + 'payload '.repeat(4097)).slice(0, 32768)),
      }] },
    ] };
    const result = resident.apply(command);
    return { command, result };
  };
  const attempt = async (category: string, i: number, command: () => ReturnType<typeof append>) => {
    let observed: ReturnType<typeof append> | undefined;
    await measure(category, i, () => {
      observed = command();
      return observed.result.Status;
    });
    const { result, command: change } = observed!;
    if (result.Status === 'Applied') assert.equal(oracle.Apply(change).Revision, result.Revision);
    else {
      assert.equal(result.Status, 'AdmissionRejected');
      assert.equal(result.Revision, change.ExpectedRevision);
      assert.equal(resident.revision(), change.ExpectedRevision);
    }
    return result.Status;
  };
  try {
    try {
      sample('resident-byte-limit', resident);
      let rejected = 0;
      for (let i = 0; i < 8; i++) {
        if (await attempt('BytePressureWrite', i, () => append(41, i, `pressure${i}`)) === 'AdmissionRejected') rejected++;
        sample(`byte-growth-${i}`, resident);
      }
      assert.equal(rejected > 0, native);
    } finally { releaseResident(); }
    sample('byte-reader-released', resident);
    assert.equal(await attempt('WriteAfterRelease', 0, () => append(42, 0, 'retry')), 'Applied');
    assert.equal(resident.held(), 0);
    const expected = oracle.Capture(SessionId).Read({ Kind: 'Range', FromSequence: 0, Limit: 0x7fff_ffff }).Entries;
    const final = resident.owner ? [...Entries(resident.owner.tryFindSession(SessionId)!)] : resident.entries(0x7fff_ffff);
    assert.deepEqual(JSON.parse(JSON.stringify(final)), JSON.parse(JSON.stringify(expected)));
    console.log(JSON.stringify({ kind: 'AdmissionPressure', participant, requests, memory,
      retainedBudget: String(retainedBudget), residentBudget: String(residentBudget), sourceDigest: sourceDigest(),
      fixtureSha256: createHash('sha256').update(raw).digest('hex'),
      runtime: { node: process.version, v8: process.versions.v8, arch: process.arch, execArgv: process.execArgv, argv: process.argv.slice(1) },
      evidenceLimits: 'Native waits pump a worker mailbox. Conventional count waits poll from the harness; no conventional byte-admission guarantee.' }));
  } finally { resident.dispose(); }
}
