// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AnchorKind, ContextMutationStatus, ContextRole, MemoryStatus, SessionStatus, TextContent,
  type ContextChange, type ContextChangeSet, type LLMSessionContext, type MemoryChangeSet,
} from '../src/domain/session.js';
import { defaultLLMContextOptions } from '../src/options.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { ConventionalParticipant } from './conventional-participant.js';
import { openArrivals, type Arrival } from './bounded-arrivals.js';
import { SemanticOracle, type ReplayRequest } from './semantic-oracle.js';
import { Entries } from '../src/policies/context.js';
import { readReferenceFixture, restoreSession, type WireSession } from './reference-fixture.js';
import { sourceDigest } from './source-digest.js';

const rates = (process.argv[2] ?? '100,500').split(',').map(Number);
const plan = { rates, stageMs: Number(process.argv[3] ?? 300), workers: 2, capacity: 32 };
const id = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const fixturePath = process.argv[4]?.startsWith('--') ? undefined : process.argv[4];
const integerOption = (flag: string, fallback: number, min: number, max: number) => {
  const raw = process.argv.find((argument) => argument.startsWith(`${flag}=`));
  const value = raw ? Number(raw.slice(flag.length + 1)) : fallback;
  assert(Number.isSafeInteger(value) && value >= min && value <= max, `${flag} must be an integer in [${min}, ${max}].`);
  return value;
};
const maxHeapBytes = integerOption('--max-heap-bytes', 256 * 1024 * 1024, 1, 512 * 1024 * 1024);
const maxRssBytes = integerOption('--max-rss-bytes', 512 * 1024 * 1024, 1, 1024 * 1024 * 1024);
const repetitions = integerOption('--repetitions', 2, 1, 3);
const repetition = integerOption('--repeat', 0, 0, repetitions - 1);
const seed = integerOption('--seed', 1729, -0x8000_0000, 0x7fff_ffff);
const fixtureBytes = fixturePath ? readFileSync(fixturePath, 'utf8').replace(/^\uFEFF/, '') : undefined;
const canonical = fixtureBytes
  ? readReferenceFixture<{ Now: string; Hot: readonly WireSession[]; Distributed: readonly WireSession[] }>(fixtureBytes)
  : undefined;
const now = canonical?.Now ?? '1970-01-01T00:00:00Z';
const changeId = (kind: number, ordinal: number) => canonical
  ? `${ordinal.toString(16).padStart(8, '0')}-0000-${kind.toString(16).padStart(4, '0')}-0000-000000000000`
  : id((kind - 69) * 100_000 + ordinal);
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));
const categoryOf = (requestId: number) => {
  const index = requestId % 20;
  return index < 8 ? 'BoundedRead' : index === 8 ? 'FullRead' : index < 12 ? 'Search' : index === 12 ? 'MemoryRead' :
    index === 13 && requestId % 100 === 13 ? 'StaleCorrect' : index < 16 ? 'Correct' :
      index < 18 ? 'Append' : index === 18 ? 'Delete' : 'MemoryWrite';
};

const descriptors = ['Native', 'Scan', 'Indexed'].flatMap((participant) => [false, true].flatMap((distributed) =>
  [false, true].map((slow) => ({ participant, distributed, slow, name: `${participant}:${distributed}:${slow}` }))));
const selected = process.argv.find((argument) => argument.startsWith('--case='));
if (selected) {
  const descriptor = descriptors.find(({ name }) => selected === `--case=${name}`);
  assert(descriptor, 'Unknown mixed-load case.');
  await run(descriptor.participant, descriptor.distributed, descriptor.slow);
} else {
  let state = seed >>> 0;
  const randomIndex = (length: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(state * length / 0x1_0000_0000);
  };
  for (let repeat = 0; repeat < repetitions; repeat++) {
    const order = [...descriptors];
    for (let i = order.length - 1; i > 0; i--) {
      const j = randomIndex(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const { name } of order) {
      execFileSync(process.execPath, [...process.execArgv, ...process.argv.slice(1), `--case=${name}`, `--repeat=${repeat}`],
        { stdio: 'inherit', timeout: 120_000 });
    }
  }
}

async function run(participant: string, distributed: boolean, slow: boolean) {
  const sessionCount = distributed ? 4 : 1;
  const fixture = canonical ? (distributed ? canonical.Distributed : canonical.Hot).map((wire) => {
    const initial = restoreSession(wire);
    return { initial, entries: [...Entries(initial)], SessionId: initial.SessionId, AnchorId: initial.Anchors.keys().next().value! };
  }) : Array.from({ length: sessionCount }, (_, s) => {
    const SessionId = id(100 + s);
    const AnchorId = id(200 + s);
    const entries = Array.from({ length: 512 / sessionCount }, (_, Sequence) => ({
      EntryId: id(1000 * (s + 1) + Sequence), Sequence, Role: ContextRole.User,
      CreatedAt: now, Content: new TextContent(`entry${s}x${Sequence} topic${Sequence % 17} ${'context '.repeat(60)}`),
    }));
    const initial: LLMSessionContext = {
      SessionId, UserId: id(1), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map(Array.from({ length: entries.length / 64 }, (_, SegmentId) => [SegmentId, {
        SegmentId, Revision: 0, Entries: entries.slice(SegmentId * 64, (SegmentId + 1) * 64),
      }])),
      Anchors: new Map([[AnchorId, {
        AnchorId, StartEntryId: entries[0].EntryId, EndEntryId: entries[3].EntryId, Kind: AnchorKind.Topic,
        Title: 'point', Summary: 'point target', Topics: ['context'], SourceRevision: 0, PinnedRevision: null,
      }]]),
    };
    return { initial, entries, SessionId, AnchorId };
  });
  assert.equal(fixture.length, sessionCount);
  const sessions = fixture.map((item) => item.initial);
  const owner = participant === 'Native' ? new LLMContextOwner({
    ...defaultLLMContextOptions, EstimatedResidentByteBudget: 32 * 1024 * 1024,
    MaximumEstimatedRetainedBytes: 16 * 1024 * 1024, MaximumRetainedReads: plan.workers,
    TimeProvider: { now: () => Date.parse(now) },
  }) : undefined;
  owner?.initialize(sessions);
  const conventional = owner ? undefined : new ConventionalParticipant(sessions, now, participant === 'Indexed', plan.workers);
  const oracle = new SemanticOracle(sessions, now);
  const revision = (session: string) => owner ? owner.tryFindSession(session)!.Revision : conventional!.Revision(session);
  const retained = () => owner ? owner.getStatistics().RetainedReads : conventional!.RetainedReads;
  const journal: (
    { kind: 'session'; change: ContextChangeSet; revision: number | bigint } |
    { kind: 'memory'; change: MemoryChangeSet; revision: number | bigint } |
    { kind: 'read'; session: string; request: ReplayRequest; observed: ReturnType<typeof read> } |
    { kind: 'capture'; session: string; revision: number | bigint; first: unknown }
  )[] = [];
  const leases: { cycle: number; slot: number; session: string; revision: number | bigint;
    event: 'Captured' | 'Released' | 'ReleasedAtStop' | 'AdmissionRejected'; elapsedMs: number }[] = [];
  const stop = new AbortController();
  let stopReason = 'Duration';
  const read = (session: string, request: ReplayRequest) => {
    if (conventional) return conventional.Read(session, request);
    const capture = owner!.openRead(session);
    try {
      return {
        SessionRevision: capture.Session.Revision, MemoryRevision: capture.MemoryRevision,
        Entries: request.Kind === 'Range' ? capture.ReadRange(request.FromSequence, request.Limit) : [],
        Hits: request.Kind === 'Search' ? capture.Search(request.Query, request.Limit) : [],
        Memories: request.Kind === 'Memory' ? capture.GetApplicableMemory(request.Scopes) : [],
        Anchors: [], Model: [],
      };
    } finally { capture.dispose(); }
  };
  let offloadedWrites = 0;
  let inFlightPreparations = 0;
  let peakPreparations = 0;
  const execute = async ({ id: requestId }: Arrival) => {
    const session = fixture[(Math.floor(requestId / 20) + requestId) % sessionCount];
    const { SessionId, AnchorId, entries } = session;
    const category = categoryOf(requestId);
    if (category === 'Correct' || category === 'StaleCorrect' || category === 'Append' || category === 'Delete') {
      const expected = Number(revision(SessionId)) - (category === 'StaleCorrect' ? 1 : 0);
      let edit: ContextChange;
      if (category === 'Append') {
        edit = { kind: 'AppendEntries', Entries: [{
          EntryId: changeId(70, requestId), Role: ContextRole.User, CreatedAt: now,
          Content: new TextContent(`append${requestId} context ${'x'.repeat(512)}`),
        }] };
      } else if (category === 'Delete') {
        const target = 8 + Math.floor(requestId / (20 * sessionCount));
        if (target >= entries.length) throw new RangeError('Plan exhausts distinct deletion targets.');
        edit = { kind: 'DeleteEntry', EntryId: entries[target].EntryId };
      } else {
        edit = { kind: 'ReplaceEntry', EntryId: entries[0].EntryId, Content: new TextContent(`correction${requestId} context`) };
      }
      const change = { SessionId, ExpectedRevision: expected, Changes: [edit] };
      const submitted = owner ? owner.applySessionFromWorker(change) : conventional!.Apply(change);
      let result;
      if (submitted instanceof Promise) {
        offloadedWrites++;
        peakPreparations = Math.max(peakPreparations, ++inFlightPreparations);
        try { result = await submitted; }
        finally { inFlightPreparations--; }
      } else result = submitted;
      if (result.Status === ContextMutationStatus.Applied) journal.push({ kind: 'session', change, revision: result.Revision });
      if (category === 'StaleCorrect') assert.equal(result.Status, ContextMutationStatus.RevisionConflict);
      else assert(result.Status === ContextMutationStatus.Applied || result.Status === ContextMutationStatus.RevisionConflict ||
        result.Status === ContextMutationStatus.AdmissionRejected);
      return { session: SessionId, category, outcome: result.Status, revision: result.Revision };
    }
    if (category === 'MemoryWrite') {
      let expected;
      try { expected = read(SessionId, { Kind: 'Memory', Scopes: [] }).MemoryRevision; }
      catch (error) {
        if (!isRetentionRejection(error)) throw error;
        return { session: SessionId, category, outcome: 'AdmissionRejected', revision: -1 };
      }
      const change = { ExpectedRevision: expected, Deletes: [], Upserts: [{
        MemoryId: changeId(71, requestId), Scope: { SessionId }, Content: `memory${requestId}`, Revision: 0,
        Status: MemoryStatus.Confirmed, ExpiresAt: null, Sources: [{ SessionId, AnchorId }],
      }] };
      const result = owner ? owner.applyMemory(change) : conventional!.ApplyMemory(change);
      assert.equal(result.Status, ContextMutationStatus.Applied);
      journal.push({ kind: 'memory', change, revision: result.Revision });
      return { session: SessionId, category, outcome: result.Status, revision: result.Revision };
    }
    const request: ReplayRequest = category === 'Search'
      ? { Kind: 'Search', Query: requestId % 2 ? 'entry0x7' : 'context', Limit: 16 }
      : category === 'MemoryRead' ? { Kind: 'Memory', Scopes: [{ SessionId }] }
      : { Kind: 'Range', FromSequence: 0, Limit: category === 'FullRead' ? 0x7fff_ffff : 16 };
    let observed: ReturnType<typeof read>;
    try { observed = read(SessionId, request); }
    catch (error) {
      if (!isRetentionRejection(error)) throw error;
      return { session: SessionId, category, outcome: 'AdmissionRejected', revision: -1 };
    }
    journal.push({ kind: 'read', session: SessionId, request, observed });
    return { session: SessionId, category, outcome: 'Completed', revision: observed.SessionRevision };
  };
  const isRetentionRejection = (error: unknown) =>
    error instanceof Error && error.message === 'Read-retention budget exhausted.';
  const retain = (session: string) => {
    if (owner) {
      const capture = owner.openRead(session);
      return { revision: () => capture.Session.Revision, first: () => capture.ReadRange(0, 1)[0], release: () => capture.dispose() };
    }
    const capture = conventional!.Capture(session);
    return { revision: () => capture.Revision, first: () => capture.FirstEntry, release: () => capture.Release() };
  };
  const retainDuringWorkload = async (origin: bigint) => {
    const elapsed = () => Number(process.hrtime.bigint() - origin) / 1e6;
    const held: { cycle: number; slot: number; session: string; revision: number | bigint;
      releaseMs: number; lease: ReturnType<typeof retain>; first: unknown }[] = [];
    let next = 0;
    try {
      while (!stop.signal.aborted && elapsed() < rates.length * plan.stageMs) {
        const time = elapsed();
        const cycle = Math.floor(next / 3), slot = next % 3;
        if (time >= cycle * 500 + slot * 50) {
          next++;
          const session = fixture[cycle % sessionCount].SessionId;
          let lease: ReturnType<typeof retain> | undefined;
          try {
            lease = retain(session);
            const revision = lease.revision(), first = lease.first();
            journal.push({ kind: 'capture', session, revision, first });
            held.push({ cycle, slot, session, revision, lease, first, releaseMs: cycle * 500 + 200 + slot * 75 });
            leases.push({ cycle, slot, session, revision, event: 'Captured', elapsedMs: elapsed() });
          } catch (error) {
            lease?.release();
            if (!isRetentionRejection(error)) throw error;
            leases.push({ cycle, slot, session, revision: -1, event: 'AdmissionRejected', elapsedMs: elapsed() });
          }
        }
        for (let i = held.length - 1; i >= 0; i--) {
          const { cycle, slot, session, revision, first, releaseMs, lease } = held[i];
          assert.equal(lease.revision(), revision);
          assert.strictEqual(lease.first(), first);
          if (time < releaseMs) continue;
          lease.release();
          held.splice(i, 1);
          leases.push({ cycle, slot, session, revision, event: 'Released', elapsedMs: elapsed() });
        }
        await delay(10);
      }
    } finally {
      for (const { cycle, slot, session, revision, lease } of held) {
        lease.release();
        leases.push({ cycle, slot, session, revision, event: 'ReleasedAtStop', elapsedMs: elapsed() });
      }
    }
  };
  const start = performance.now();
  const sample = (phase: 'Start' | 'Workload' | 'Drained') => {
    const usage = process.memoryUsage();
    if (phase !== 'Drained' && !stop.signal.aborted) {
      if (usage.heapUsed > maxHeapBytes) stopReason = 'HeapUsedLimit';
      else if (usage.rss > maxRssBytes) stopReason = 'RssLimit';
      if (stopReason !== 'Duration') stop.abort();
    }
    return { phase, elapsedMs: performance.now() - start, held: retained(), ...usage };
  };
  const memory = [sample('Start')];
  const sampling = setInterval(() => memory.push(sample('Workload')), 25);
  try {
    const workload = openArrivals(plan, execute, stop.signal);
    const retainer = slow ? workload.started.then(retainDuringWorkload) : Promise.resolve();
    void retainer.catch(() => {});
    const boundaries = await workload.offered;
    const workloadMs = performance.now() - start;
    const [terminals] = await Promise.all([workload.drained, retainer]);
    const drainMs = performance.now() - start - workloadMs;
    memory.push(sample('Drained'));
    clearInterval(sampling);
    const sessionHistory = new Map<string, Map<number | bigint, ReturnType<SemanticOracle['Capture']>>>();
    const sessionCommits = journal.filter((step) => step.kind === 'session');
    for (const { SessionId } of fixture) {
      const capture = oracle.Capture(SessionId);
      const history = new Map([[capture.Revision, capture]]);
      const commits = sessionCommits.filter((step) => step.change.SessionId === SessionId)
        .sort((left, right) => Number(left.revision) - Number(right.revision));
      for (const commit of commits) {
        assert.deepEqual(oracle.Apply(commit.change), { Status: 'Applied', Revision: commit.revision });
        history.set(commit.revision, oracle.Capture(SessionId));
      }
      sessionHistory.set(SessionId, history);
    }
    const memoryHistory = new Map<number | bigint, Map<string, ReturnType<SemanticOracle['Capture']>>>();
    const captureMemory = (revision: number | bigint) =>
      memoryHistory.set(revision, new Map(fixture.map(({ SessionId }) => [SessionId, oracle.Capture(SessionId)])));
    captureMemory(0);
    for (const commit of journal.filter((step) => step.kind === 'memory').sort((left, right) => Number(left.revision) - Number(right.revision))) {
      assert.deepEqual(oracle.ApplyMemory(commit.change), { Status: 'Applied', Revision: commit.revision });
      captureMemory(commit.revision);
    }
    for (const step of journal) {
      if (step.kind === 'capture') {
        const capture = sessionHistory.get(step.session)?.get(step.revision);
        assert(capture);
        assert.deepEqual(normalized(capture.Read({ Kind: 'Range', FromSequence: 0, Limit: 1 }).Entries), normalized([step.first]));
      } else if (step.kind === 'read') {
        const { SessionRevision, MemoryRevision } = step.observed;
        const session = sessionHistory.get(step.session)?.get(SessionRevision);
        const memory = memoryHistory.get(MemoryRevision)?.get(step.session);
        assert(session && memory);
        // This ramp never changes session scope, so a memory query depends only on the captured catalog revision.
        const expected = (step.request.Kind === 'Memory' ? memory : session).Read(step.request);
        assert.deepEqual(normalized(step.observed), normalized({ ...expected, SessionRevision, MemoryRevision }));
      }
    }
    for (const { SessionId } of fixture) assert.equal(revision(SessionId), oracle.Capture(SessionId).Revision);
    assert.equal(retained(), 0);
    assert.equal(inFlightPreparations, 0);
    const requests = terminals.map((item) => item.kind === 'Completed' ? { ...item, ...item.result } :
      { ...item, category: categoryOf(item.id), outcome: item.kind });
    const stages = rates.map((rate, stage) => {
      const offered = requests.filter((item) => item.stage === stage);
      const completed = offered.filter((item) => item.kind === 'Completed');
      const cancelled = offered.filter((item) => item.kind === 'Cancelled').length;
      return { stage, rate, offered: offered.length, admitted: completed.length + cancelled,
        completed: completed.length, cancelled, queueRejected: offered.length - completed.length - cancelled,
        applied: completed.filter(({ outcome }) => outcome === 'Applied').length,
        conflicted: completed.filter(({ outcome }) => outcome === 'RevisionConflict').length,
        admissionRejected: completed.filter(({ outcome }) => outcome === 'AdmissionRejected').length,
        succeededReads: completed.filter(({ outcome }) => outcome === 'Completed').length };
    });
    const latencies = stages.flatMap(({ stage }) => {
      const groups = new Map<string, number[]>();
      for (const request of requests) {
        if (request.stage !== stage || request.kind !== 'Completed') continue;
        const key = `${request.category}:${request.outcome}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(request.queueMs + request.executionMs);
      }
      return [...groups].map(([category, samples]) => {
        samples.sort((a, b) => a - b);
        return { stage, category, samples: samples.length,
          endToEndMs: [0.5, 0.95, 0.99].map((quantile) => samples[Math.ceil(quantile * samples.length) - 1]) };
      });
    });
    console.log(JSON.stringify({ kind: 'BoundedMixedLoad', participant, distributed, slow, plan,
      stopReason, maxHeapBytes, maxRssBytes, seed, repetition,
      workloadMs, drainMs, stages, boundaries, requests, memory, leases, latencies, oracleSteps: journal.length,
      preparation: { offloadedWrites, peakInFlight: peakPreparations },
      evidence: { source: sourceDigest(), node: process.version, v8: process.versions.v8, platform: process.platform,
        arch: process.arch, execArgv: process.execArgv, argv: process.argv.slice(1),
        fixtureSha256: fixtureBytes && createHash('sha256').update(fixtureBytes).digest('hex') } }));
  } finally { clearInterval(sampling); owner?.dispose(); }
}
