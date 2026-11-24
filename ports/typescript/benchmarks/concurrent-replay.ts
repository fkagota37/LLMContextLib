// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AnchorKind, ContextMutationStatus, ContextRole, SessionStatus, TextContent, type LLMSessionContext } from '../src/domain/session.js';
import { defaultLLMContextOptions } from '../src/options.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { OwnerMailbox } from '../src/runtime/owner-mailbox.js';
import { BuildModelContext, Entries } from '../src/policies/context.js';
import { ConventionalParticipant } from './conventional-participant.js';
import { SemanticOracle, type ReplayRequest } from './semantic-oracle.js';
import { readReferenceFixture, restoreSession, type WireSession } from './reference-fixture.js';
import type { Int64 } from '../src/domain/int64.js';

type Sample = {
  worker: number;
  operation: number;
  session: string;
  revision: number;
  kind: 'PointWrite' | 'Range' | 'Model' | 'Search' | 'Anchor';
  status: ContextMutationStatus | null;
  text?: string;
  observation?: unknown;
  startMs: number;
  queueMs: number;
  serviceMs: number;
  endToEndMs: number;
};

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const initialText = 'original point value';
const fixtureBytes = process.argv[4] ? readFileSync(process.argv[4], 'utf8').replace(/^\uFEFF/, '') : undefined;
const canonical = fixtureBytes ? readReferenceFixture<{ Now: string; Sessions: readonly WireSession[] }>(fixtureBytes) : undefined;
const now = canonical?.Now ?? '1970-01-01T00:00:00Z';
const searchLimit = canonical ? 16 : 64;
const tokenBudget = canonical ? 2048 : 512;
const modelLimit = canonical ? 128 : 64;

const readers = 4;
const writers = 2;
const operations = Number(process.argv[2] ?? 32);
const arrivals = Number(process.argv[3] ?? 0);
assert(Number.isSafeInteger(operations) && operations > 0 && operations <= 4096);
assert(Number.isSafeInteger(arrivals) && arrivals >= 0);

function sourceDigest() {
  const hash = createHash('sha256');
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (path.endsWith('.ts')) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  scan('src');
  scan('benchmarks');
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json']) hash.update(readFileSync(path));
  return hash.digest('hex');
}

function fixture(distributed: boolean) {
  if (canonical) return canonical.Sessions.slice(0, distributed ? writers : 1).map((session) => {
    const initial = restoreSession(session);
    const point = [...Entries(initial)][4];
    assert(point.Content instanceof TextContent);
    const anchor = [...initial.Anchors.values()][0];
    return { SessionId: initial.SessionId, target: point.EntryId, AnchorId: anchor.AnchorId,
      anchorStart: anchor.StartEntryId, initialText: point.Content.Text, initial };
  });
  return Array.from({ length: distributed ? writers : 1 }, (_, index) => {
    const SessionId = id(1000 * (index + 1));
    const target = id(1000 * (index + 1) + 5);
    const AnchorId = id(1000 * (index + 1) + 200);
    const initial: LLMSessionContext = {
      SessionId, UserId: id(1), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: Array.from({ length: 64 }, (_, Sequence) => ({
        EntryId: id(1000 * (index + 1) + 1 + Sequence), Sequence, Role: ContextRole.User,
        CreatedAt: now,
        Content: new TextContent(Sequence === 4 ? initialText : `topic${Sequence % 8} entry${Sequence}`),
      })) }]]),
      Anchors: new Map([[AnchorId, {
        AnchorId, StartEntryId: target, EndEntryId: target, Kind: AnchorKind.Topic,
        Title: 'point', Summary: 'point target', Topics: ['point'], SourceRevision: 0, PinnedRevision: null,
      }]]),
    };
    return { SessionId, target, AnchorId, anchorStart: target, initialText, initial };
  });
}

for (const participant of ['Native', 'Scan', 'Indexed']) {
  for (const distributed of [false, true]) await run(participant, distributed);
}

async function run(participant: string, distributed: boolean) {
  const owner = participant === 'Native'
    ? new LLMContextOwner({ ...defaultLLMContextOptions, MaximumRetainedReads: readers + writers })
    : undefined;
  const sessions = fixture(distributed);
  assert.equal(sessions.length, distributed ? writers : 1);
  const initial = sessions.map((session) => session.initial);
  owner?.initialize(initial);
  const conventional = owner ? undefined : new ConventionalParticipant(initial, now, participant === 'Indexed', readers + writers);
  const mailbox = new OwnerMailbox();
  const readRequest = (kind: string, anchorId: string): ReplayRequest =>
    kind === 'Range' ? { Kind: 'Range', FromSequence: 4, Limit: 1 } :
      kind === 'Search' ? { Kind: 'Search', Query: 'topic3', Limit: searchLimit } :
        kind === 'Anchor' ? { Kind: 'Anchor', AnchorId: anchorId } : { Kind: 'Model', TokenBudget: tokenBudget, Limit: modelLimit, Scopes: [] };
  const observe = (kind: string, result: {
    SessionRevision: Int64; Entries: readonly unknown[]; Hits: readonly unknown[]; Anchors: readonly unknown[]; Model: readonly unknown[];
  }) => {
    const revision = result.SessionRevision;
    switch (kind) {
      case 'Range': return { revision, entries: result.Entries };
      case 'Search': return { revision, hits: result.Hits };
      case 'Anchor': return { revision, anchor: result.Anchors[0] };
      case 'Model': return { revision, model: result.Model };
      default: throw new Error('Unknown benchmark request.');
    }
  };
  const revision = (sessionId: string) => owner ? owner.tryFindSession(sessionId)!.Revision : conventional!.Revision(sessionId);
  const retained = () => owner ? owner.getStatistics().RetainedReads : conventional!.RetainedReads;
  const handle = (session: (typeof sessions)[number], request: { kind: string; expected?: number; text?: string }) => {
    const { SessionId, target, AnchorId } = session;
    if (request.kind === 'revision') return revision(SessionId);
    if (request.kind === 'PointWrite') {
      const changes = { SessionId, ExpectedRevision: request.expected!, Changes: [
        { kind: 'ReplaceEntry' as const, EntryId: target, Content: new TextContent(request.text!) },
      ] };
      return owner ? owner.applySessionFromWorker(changes) : conventional!.Apply(changes);
    }
    if (conventional) {
      return observe(request.kind, conventional.Read(SessionId, readRequest(request.kind, AnchorId)));
    }
    const read = owner!.openRead(SessionId);
    try {
      const revision = read.Session.Revision;
      switch (request.kind) {
        case 'Range': return { revision, entries: read.ReadRange(4, 1) };
        case 'Search': return { revision, hits: read.Search('topic3', searchLimit) };
        case 'Anchor': return { revision, anchor: read.ResolveAnchor(AnchorId) };
        case 'Model': return { revision, model: BuildModelContext(Entries(read.Session), [], tokenBudget,
          (text) => Math.ceil(text.length / 4), modelLimit) };
        default: throw new Error('Unknown benchmark request.');
      }
    } finally { read.dispose(); }
  };
  let inFlightPreparations = 0;
  let peakPreparations = 0;
  let offloadedWrites = 0;
  const start = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  const workers = Array.from({ length: readers + writers }, (_, worker) => {
    const write = worker >= readers;
    const session = sessions[distributed ? (write ? worker - readers : worker % writers) : 0];
    const response = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const { port } = mailbox.attach((value, post) => {
      const reply = (packet: { value: unknown } | { error: string }) => {
        post(packet);
        Atomics.add(response, 0, 1);
        Atomics.notify(response, 0);
      };
      try {
        const result = handle(session, value as Parameters<typeof handle>[1]);
        if (result instanceof Promise) {
          offloadedWrites++;
          peakPreparations = Math.max(peakPreparations, ++inFlightPreparations);
          const finish = (packet: Parameters<typeof reply>[0]) => {
            inFlightPreparations--;
            reply(packet);
          };
          void result.then((value) => finish({ value }), (error: unknown) => finish({ error: String(error) }));
        } else reply({ value: result });
      } catch (error) { reply({ error: String(error) }); }
    });
    return new Worker(`
      const assert = require('node:assert/strict');
      const { parentPort, receiveMessageOnPort, workerData: data } = require('node:worker_threads');
      (() => {
        const request = (message) => {
          const { port, response } = data;
          port.postMessage(message);
          for (;;) {
            const start = Atomics.load(response, 0);
            const packet = receiveMessageOnPort(port);
            if (packet) {
              if (packet.message.error) throw new Error(packet.message.error);
              return packet.message.value;
            }
            if (Atomics.wait(response, 0, start, 10000) === 'timed-out') throw new Error('Replay request timed out.');
          }
        };
        const sleep = new Int32Array(new SharedArrayBuffer(4));
        parentPort.postMessage('ready');
        if (Atomics.wait(data.start, 0, 0n, 10000) === 'timed-out') throw new Error('Replay barrier timed out.');
        const began = Atomics.load(data.start, 0);
        const elapsed = () => Number(process.hrtime.bigint() - began) / 1e6;
        const { SessionId, target, AnchorId, anchorStart } = data.session;
        const samples = [];
        try {
          for (let operation = 0; operation < data.operations; operation++) {
            const due = data.arrivals ? 1000 * (operation * data.total + data.worker) / data.arrivals : 0;
            const remaining = due - elapsed();
            if (remaining > 0) Atomics.wait(sleep, 0, 0, remaining);
            const entered = elapsed();
            const queueMs = data.arrivals ? Math.max(0, entered - due) : 0;
            let revision, status = null, text, observation;
            const kind = data.write ? 'PointWrite' : ['Range', 'Model', 'Search', 'Anchor'][operation % 4];
            if (kind === 'PointWrite') {
              text = 'writer' + data.worker + 'operation' + operation;
              const expected = request({ kind: 'revision' });
              const outcome = request({ kind, expected, text });
              status = outcome.Status;
              revision = outcome.Revision;
            } else {
              observation = request({ kind });
              revision = observation.revision;
              if (kind === 'Range') {
                const { entries } = observation;
                assert.equal(entries.length, 1);
                assert.equal(entries[0].EntryId, target);
                text = entries[0].Content.Text;
              } else if (kind === 'Search') {
                const { hits } = observation;
                assert(hits.length > 0);
                assert(hits.every((hit) => hit.SessionRevision === revision));
              } else if (kind === 'Anchor') {
                assert.equal(observation.anchor.Anchor.AnchorId, AnchorId);
                assert.equal(observation.anchor.SessionRevision, revision);
                assert.equal(observation.anchor.Start.EntryId, anchorStart);
                if (anchorStart === target) text = observation.anchor.Start.Content.Text;
              } else if (kind === 'Model') {
                assert(observation.model.length > 0);
                text = observation.model.find((item) => item.EntryId === target)?.Text;
              }
            }
            const serviceMs = elapsed() - entered;
            samples.push({ worker: data.worker, operation, session: SessionId, revision, kind, status, text, observation,
              startMs: entered, queueMs, serviceMs, endToEndMs: queueMs + serviceMs });
          }
        } finally { data.port.close(); }
        parentPort.postMessage(samples);
      })();
    `, { eval: true, workerData: { port, response, start, worker, write,
      session: { SessionId: session.SessionId, target: session.target, AnchorId: session.AnchorId, anchorStart: session.anchorStart },
      arrivals, operations, total: readers + writers }, transferList: [port] });
  });
  try {
    assert.deepEqual(await Promise.all(workers.map((worker) => once(worker, 'message'))), workers.map(() => ['ready']));
    const results = Promise.all(workers.map((worker) => once(worker, 'message')));
    const began = process.hrtime.bigint();
    const sampleMemory = () => ({ elapsedMs: Number(process.hrtime.bigint() - began) / 1e6, ...process.memoryUsage() });
    const memory = [sampleMemory()];
    const sampler = setInterval(() => memory.push(sampleMemory()), 50);
    Atomics.store(start, 0, began);
    Atomics.notify(start, 0);
    let requests: Sample[];
    try { requests = (await results).flatMap(([samples]) => samples as Sample[]); }
    finally { clearInterval(sampler); }
    const elapsedMs = Number(process.hrtime.bigint() - began) / 1e6;
    memory.push(sampleMemory());
    const writes = requests.filter((sample) => sample.kind === 'PointWrite');
    assert.equal(requests.length, (readers + writers) * operations);
    assert.equal(writes.length, writers * operations);
    const commits = writes.filter((sample) => sample.status === ContextMutationStatus.Applied);
    const conflicts = writes.filter((sample) => sample.status === ContextMutationStatus.RevisionConflict);
    const rejected = writes.filter((sample) => sample.status === ContextMutationStatus.AdmissionRejected);
    assert.equal(commits.length + conflicts.length + rejected.length, writes.length);
    assert(requests.every((sample) => sample.kind === 'PointWrite' || sample.status === null));
    const oracle = new SemanticOracle(initial, now);
    for (const { SessionId, target, AnchorId, initialText } of sessions) {
      const history = [initialText];
      const applied = commits.filter((sample) => sample.session === SessionId).sort((a, b) => a.revision - b.revision);
      const observed = requests.filter((sample) => sample.status === null && sample.session === SessionId)
        .sort((a, b) => a.revision - b.revision);
      let next = 0;
      for (const read of observed) {
        while (next < read.revision && next < applied.length) replayCommit(applied[next]);
        const capture = oracle.Capture(SessionId);
        assert.equal(capture.Revision, read.revision);
        const expected = observe(read.kind, capture.Read(readRequest(read.kind, AnchorId)));
        assert.deepEqual(JSON.parse(JSON.stringify(read.observation)), JSON.parse(JSON.stringify(expected)),
          `${participant} ${read.kind} revision ${read.revision}`);
      }
      while (next < applied.length) replayCommit(applied[next]);
      function replayCommit(commit: Sample) {
        assert.equal(commit.revision, history.length);
        assert(commit.text);
        assert.equal(oracle.Apply({ SessionId, ExpectedRevision: next, Changes: [
          { kind: 'ReplaceEntry', EntryId: target, Content: new TextContent(commit.text) },
        ] }).Status, ContextMutationStatus.Applied);
        history.push(commit.text);
        next++;
      }
      assert.equal(revision(SessionId), history.length - 1);
      for (const read of observed) {
        assert(history[read.revision] !== undefined);
        if (read.kind === 'Range' || read.text !== undefined) {
          assert.equal(read.text, history[read.revision]);
        }
      }
    }
    assert.equal(retained(), 0);
    assert.equal(inFlightPreparations, 0);
    console.log(JSON.stringify({ kind: 'WorkerReplay', participant, distributed, readers, writers, operations, arrivals, elapsedMs,
      commits: commits.length, conflicts: conflicts.length, rejections: rejected.length, requests, memory, latencies: summarize(requests),
      preparation: { offloadedWrites, peakInFlight: peakPreparations },
      evidence: { source: sourceDigest(), node: process.version, v8: process.versions.v8, platform: process.platform,
        arch: process.arch, execArgv: process.execArgv, argv: process.argv.slice(1),
        fixtureSha256: fixtureBytes && createHash('sha256').update(fixtureBytes).digest('hex') } }));
  } finally {
    mailbox.dispose();
    owner?.dispose();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }

  function summarize(requests: readonly Sample[]) {
    const groups = new Map<string, Sample[]>();
    for (const request of requests) {
      const key = `${request.kind}:${request.status ?? 'Read'}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(request);
    }
    const quantile = (samples: readonly Sample[], field: 'serviceMs' | 'endToEndMs' | 'queueMs', probability: number) => {
      const values = samples.map((sample) => sample[field]).sort((a, b) => a - b);
      return values[Math.ceil(values.length * probability) - 1];
    };
    return [...groups].map(([category, samples]) => ({ category, samples: samples.length,
      serviceMs: [0.5, 0.95, 0.99].map((p) => quantile(samples, 'serviceMs', p)),
      endToEndMs: [0.5, 0.95, 0.99].map((p) => quantile(samples, 'endToEndMs', p)),
      queueP95Ms: quantile(samples, 'queueMs', 0.95),
    }));
  }
}
