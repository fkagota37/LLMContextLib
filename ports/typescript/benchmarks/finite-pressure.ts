// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextContent, type ContextChangeSet } from '../src/domain/session.js';
import { defaultLLMContextOptions } from '../src/options.js';
import { Entries } from '../src/policies/context.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { ConventionalParticipant } from './conventional-participant.js';
import { readReferenceFixture, restoreSession, type WireSession } from './reference-fixture.js';
import { SemanticOracle, type ReplayRequest } from './semantic-oracle.js';
import { sourceDigest } from './source-digest.js';

type Descriptor = { participant: 'Native' | 'Scan' | 'Indexed' } & (
  { point: 'Deletion'; entries: number; position: 'begin' | 'middle' | 'end' } |
  { point: 'IndexPayoff'; entries: number; changedCharacters: number; searchPercent: number }
);
const descriptors: Descriptor[] = [];
for (const participant of ['Native', 'Scan', 'Indexed'] as const) {
  for (const entries of [512, 4096, 16384]) {
    for (const position of ['begin', 'middle', 'end'] as const) descriptors.push({ participant, point: 'Deletion', entries, position });
  }
  for (const changedCharacters of [128, 8192, 32768]) {
    for (const searchPercent of [0, 50, 90]) descriptors.push({ participant, point: 'IndexPayoff', entries: 1024, changedCharacters, searchPercent });
  }
}
const [fixtures, iterationsArgument, warmupsArgument, selected] = process.argv.slice(2);
const iterations = Number(iterationsArgument ?? 20), warmups = Number(warmupsArgument ?? 5);
assert(fixtures && Number.isInteger(iterations) && iterations >= 1 && iterations <= 128 &&
  Number.isInteger(warmups) && warmups >= 0 && warmups <= 10,
'Usage: finite-pressure.ts <pinned-fixture-directory> [iterations] [warmups]');

if (selected === undefined) {
  for (let i = 0; i < descriptors.length; i++) {
    execFileSync(process.execPath, [...process.execArgv, process.argv[1], fixtures, String(iterations), String(warmups), String(i)],
      { stdio: 'inherit', timeout: 120_000 });
  }
} else {
  const descriptor = descriptors[Number(selected)];
  assert(descriptor, 'Unknown finite-pressure descriptor.');
  run(descriptor);
}

function run(descriptor: Descriptor) {
  const fixture = readFileSync(join(fixtures, `pressure-${descriptor.entries}.json`), 'utf8').replace(/^\uFEFF/, '');
  const { Now, Sessions } = readReferenceFixture<{ Now: string; Sessions: WireSession[] }>(fixture);
  assert.equal(Sessions.length, 1);
  const session = restoreSession(Sessions[0]);
  const SessionId = session.SessionId;
  const entries = [...Entries(session)];
  assert.equal(entries.length, descriptor.entries);
  type Action = { change: ContextChangeSet } | { request: ReplayRequest };
  const actions: Action[] = [];
  if (descriptor.point === 'Deletion') {
    const position = descriptor.position === 'begin' ? 0 : descriptor.position === 'end' ? entries.length - 1 : Math.floor(entries.length / 2);
    actions.push({ change: { SessionId, ExpectedRevision: 0, Changes: [{ kind: 'DeleteEntry', EntryId: entries[position].EntryId }] } });
  } else {
    let revision = 0;
    const writes = 20 * (100 - descriptor.searchPercent) / 100;
    for (let i = 0; i < 20; i++) {
      if (Math.floor((i + 1) * writes / 20) > Math.floor(i * writes / 20)) {
        const length = descriptor.changedCharacters;
        const payload = (`changed${i} context ` + 'payload '.repeat(Math.floor(length / 8) + 1)).slice(0, length);
        actions.push({ change: { SessionId, ExpectedRevision: revision++, Changes: [
          { kind: 'ReplaceEntry', EntryId: entries[4].EntryId, Content: new TextContent(payload) },
        ] } });
      } else actions.push({ request: { Kind: 'Search', Query: i % 2 ? 'entry0x7' : 'context', Limit: 16 } });
    }
  }
  const all: ReplayRequest = { Kind: 'Range', FromSequence: 0, Limit: 0x7fff_ffff };
  const oracle = new SemanticOracle([session], Now);
  const expected = actions.map((action) => 'change' in action ? oracle.Apply(action.change) : oracle.Capture(SessionId).Read(action.request));
  const expectedEntries = oracle.Capture(SessionId).Read(all).Entries;
  const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  })).digest('hex');
  const expectedDigest = digest(expected);
  const requests: { category: string; iteration: number; elapsedMs: number }[] = [];
  const memory = [];
  for (let iteration = -warmups - 1; iteration < iterations; iteration++) {
    const initialization = performance.now();
    const owner = descriptor.participant === 'Native' ? new LLMContextOwner({
      ...defaultLLMContextOptions, EstimatedResidentByteBudget: 2 * 1024 ** 3,
      MaximumEstimatedRetainedBytes: 1024 ** 3, TimeProvider: { now: () => Date.parse(Now) },
    }) : undefined;
    const conventional = owner ? undefined : new ConventionalParticipant([session], Now, descriptor.participant === 'Indexed', 64);
    try {
      owner?.initialize([session]);
      const initializationMs = performance.now() - initialization;
      const read = (request: ReplayRequest) => {
        if (conventional) return conventional.Read(SessionId, request);
        const capture = owner!.openRead(SessionId);
        try {
          return {
            SessionRevision: capture.Session.Revision, MemoryRevision: capture.MemoryRevision,
            Entries: request.Kind === 'Range' ? capture.ReadRange(request.FromSequence, request.Limit) : [],
            Hits: request.Kind === 'Search' ? capture.Search(request.Query, request.Limit) : [],
            Anchors: [], Memories: [], Model: [],
          };
        } finally { capture.dispose(); }
      };
      const started = performance.now();
      const observed = actions.map((action) => {
        if (!('change' in action)) return read(action.request);
        const result = owner ? owner.applySession(action.change) : conventional!.Apply(action.change);
        return { Status: result.Status, Revision: result.Revision };
      });
      if (iteration === -warmups - 1) assert.deepEqual(normalized(observed), normalized(expected));
      else assert.equal(digest(observed), expectedDigest);
      const elapsedMs = performance.now() - started;
      assert.deepEqual(normalized(read(all).Entries), normalized(expectedEntries));
      assert.equal(owner?.getStatistics().RetainedReads ?? conventional!.RetainedReads, 0);
      if (iteration >= 0) requests.push({ category: 'Initialization', iteration, elapsedMs: initializationMs }, { category: 'Replay', iteration, elapsedMs });
      if (iteration === iterations - 1) memory.push({ phase: 'Final', ...process.memoryUsage(), owner: owner?.getStatistics() });
    } finally { owner?.dispose(); }
  }
  const percentiles = ['Initialization', 'Replay'].map((category) => {
    const times = requests.filter((request) => request.category === category).map((request) => request.elapsedMs).sort((a, b) => a - b);
    return { category, samples: times.length, ms: [0.5, 0.95, 0.99].map((p) => times[Math.ceil(p * times.length) - 1]) };
  });
  console.log(JSON.stringify({ kind: 'FinitePressure', descriptor, iterations, warmups, requests, memory, percentiles,
    oracleDigest: expectedDigest, sourceDigest: sourceDigest(), fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
    runtime: { node: process.version, v8: process.versions.v8, arch: process.arch, execArgv: process.execArgv, argv: process.argv.slice(1) },
    evidenceLimits: 'V8 memory samples are not per-operation allocation or C# lock/GC measurements.' }));
}
