// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import type { Int64 } from '../src/domain/int64.js';
import { ContextRole, TextContent, type ContextChangeSet, type ContextEntry } from '../src/domain/session.js';
import { defaultLLMContextOptions } from '../src/options.js';
import { Entries } from '../src/policies/context.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { ConventionalParticipant } from './conventional-participant.js';
import { readReferenceFixture, restoreSession, type WireSession } from './reference-fixture.js';
import { SemanticOracle } from './semantic-oracle.js';
import { sourceDigest } from './source-digest.js';

const participants = ['Native', 'Scan', 'Indexed'] as const;
const sizes = [512, 4096, 16384];
const [fixtures, participantArgument, entriesArgument] = process.argv.slice(2);
assert(fixtures, 'Usage: node --expose-gc <tsx-cli.mjs> snapshot-pressure.ts <pinned-fixture-directory>');
if (participantArgument === undefined) {
  const execArgv = [...process.execArgv];
  if (!execArgv.includes('--expose-gc')) execArgv.push('--expose-gc');
  for (const participant of participants) {
    for (const entries of sizes) {
      execFileSync(process.execPath, [...execArgv, process.argv[1], fixtures, participant, String(entries)],
        { stdio: 'inherit', timeout: 120_000 });
    }
  }
} else {
  const participant = participants.find((value) => value === participantArgument), entries = Number(entriesArgument);
  assert(participant && sizes.includes(entries) && global.gc, 'Invalid snapshot-pressure case or missing --expose-gc.');
  await run(participant, entries, global.gc);
}

async function run(participant: typeof participants[number], entries: number, gc: () => void) {
  const fixture = readFileSync(join(fixtures, `pressure-${entries}.json`), 'utf8').replace(/^\uFEFF/, '');
  const { Now, Sessions } = readReferenceFixture<{ Now: string; Sessions: WireSession[] }>(fixture);
  assert.equal(Sessions.length, 1);
  const session = restoreSession(Sessions[0]);
  const first = Entries(session)[Symbol.iterator]().next().value;
  assert(first);
  const { SessionId } = session;
  const create = () => {
    const owner = participant === 'Native' ? new LLMContextOwner({
      ...defaultLLMContextOptions, EstimatedResidentByteBudget: 2 * 1024 ** 3,
      MaximumEstimatedRetainedBytes: 1024 ** 3, TimeProvider: { now: () => Date.parse(Now) },
    }) : undefined;
    owner?.initialize([session]);
    const conventional = owner ? undefined : new ConventionalParticipant([session], Now, participant === 'Indexed', 64);
    return {
      capture() {
        if (conventional) {
          const lease = conventional.Capture(SessionId);
          return { revision: () => lease.Revision, first: () => lease.FirstEntry, release: () => lease.Release() };
        }
        const lease = owner!.openRead(SessionId);
        return { revision: () => lease.Session.Revision, first: () => lease.ReadRange(0, 1)[0], release: () => lease.dispose() };
      },
      apply(change: ContextChangeSet) { return owner?.applySession(change) ?? conventional!.Apply(change); },
      read() {
        if (conventional) return conventional.Read(SessionId, { Kind: 'Range', FromSequence: 0, Limit: 0x7fff_ffff }).Entries;
        const lease = owner!.openRead(SessionId);
        try { return lease.ReadRange(0, 0x7fff_ffff); }
        finally { lease.dispose(); }
      },
      statistics: () => owner?.getStatistics(),
      held: () => owner?.getStatistics().RetainedReads ?? conventional!.RetainedReads,
      dispose: () => owner?.dispose(),
    };
  };
  const warmUp = () => {
    const warm = create();
    try {
      for (let i = 0; i < 5; i++) {
        const lease = warm.capture();
        try {
          assert.equal(warm.apply({ SessionId, ExpectedRevision: i,
            Changes: [{ kind: 'ReplaceEntry', EntryId: first.EntryId, Content: new TextContent(`warm${i}`) }],
          }).Status, 'Applied');
        } finally { lease.release(); }
      }
    } finally { warm.dispose(); }
  };
  warmUp();
  const measured = create();
  const oracle = new SemanticOracle([session], Now);
  const snapshots: { lease: ReturnType<typeof measured.capture>; revision: Int64; first?: ContextEntry }[] = [];
  const requests: { category: string; iteration: number; elapsedMs: number }[] = [];
  const memory: (NodeJS.MemoryUsage & { phase: string; held: number; owner: ReturnType<typeof measured.statistics> })[] = [];
  const sample = (phase: string) => {
    assert.equal(measured.held(), snapshots.length);
    memory.push({ phase, held: snapshots.length, ...process.memoryUsage(), owner: measured.statistics() });
  };
  const collect = async () => { gc(); await setImmediate(); gc(); };
  try {
    sample('initial-before-forced-gc');
    await collect();
    sample('initial-after-forced-gc');
    for (let i = 0; i < 8; i++) {
      let start = performance.now();
      const lease = measured.capture();
      requests.push({ category: 'Retain', iteration: i, elapsedMs: performance.now() - start });
      snapshots.push({ lease, revision: lease.revision(), first: lease.first() });
      const change: ContextChangeSet = { SessionId, ExpectedRevision: i, Changes: [
        { kind: 'ReplaceEntry', EntryId: first.EntryId, Content: new TextContent(`snapshot${i}`) },
        { kind: 'AppendEntries', Entries: [{
          EntryId: `${i.toString(16).padStart(8, '0')}-0000-0028-0000-000000000000`,
          Role: ContextRole.User, CreatedAt: Now, Content: new TextContent((`growth${i} context ` + 'payload '.repeat(129)).slice(0, 1024)),
        }] },
      ] };
      start = performance.now();
      const result = measured.apply(change);
      requests.push({ category: 'Mutation', iteration: i, elapsedMs: performance.now() - start });
      assert.equal(result.Status, 'Applied');
      assert.deepEqual({ Status: result.Status, Revision: result.Revision }, oracle.Apply(change));
      for (const capture of snapshots) {
        assert.equal(capture.lease.revision(), capture.revision);
        assert.strictEqual(capture.lease.first(), capture.first);
      }
      sample(`held-${i + 1}`);
    }
    await collect();
    sample('held-after-forced-gc');
    while (snapshots.length) snapshots.pop()!.lease.release();
    sample('released-before-gc');
    await setTimeout(100);
    sample('released-after-100ms');
    await collect();
    sample('released-after-forced-gc');
    const expected = oracle.Capture(SessionId).Read({ Kind: 'Range', FromSequence: 0, Limit: 0x7fff_ffff }).Entries;
    assert.deepEqual(JSON.parse(JSON.stringify(measured.read())), JSON.parse(JSON.stringify(expected)));
    assert.equal(measured.statistics()?.EstimatedRetainedBytes ?? 0, 0);
    console.log(JSON.stringify({ kind: 'SnapshotPressure', participant, entries, requests, memory,
      sourceDigest: sourceDigest(), fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
      runtime: { node: process.version, v8: process.versions.v8, arch: process.arch, execArgv: process.execArgv, argv: process.argv.slice(1) },
      evidenceLimits: 'V8 forced collections and process memory are incremental diagnostics, not exact retained sizes.' }));
  } finally {
    while (snapshots.length) snapshots.pop()!.lease.release();
    measured.dispose();
  }
}
