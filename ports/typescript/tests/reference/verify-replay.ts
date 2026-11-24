// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ConventionalParticipant } from '../../benchmarks/conventional-participant.js';
import { retentionSoak, type RetentionCapture } from '../../benchmarks/retention-soak.js';
import { SemanticOracle, type ReplayRequest } from '../../benchmarks/semantic-oracle.js';
import { LLMContextFactory } from '../../src/factory.js';
import { BuildModelContext, Entries } from '../../src/policies/context.js';
import type { ILLMContextPolymorphicArray, ILLMContextReadLease } from '../../src/domain/reads.js';
import {
  ContextRole, SummaryContent, TextContent, ToolCallContent, ToolResultContent,
  type ContextChange, type ContextChangeSet, type ContextSegment, type LLMSessionContext, type MemoryChangeSet,
} from '../../src/domain/session.js';
import type { Int64 } from '../../src/domain/int64.js';
import type { LLMContextOptions } from '../../src/options.js';

type Action = { SessionId: string; RetentionId: number } & (
  | { Kind: 'Read'; Request: ReplayRequest }
  | { Kind: 'Change'; ExpectedRevision: number; Changes: readonly ContextChange[] }
  | { Kind: 'Memory'; Memory: MemoryChangeSet }
  | { Kind: 'Retain' | 'CheckRetained' | 'Release' }
);
type Scenario = Pick<LLMContextOptions, 'MaximumEntriesPerSegment' | 'MaximumEstimatedBytesPerSegment' |
  'MaximumEstimatedRetainedBytes' | 'MaximumRetainedReads' | 'MaximumViewResults' | 'EstimatedResidentByteBudget'> & {
  Scenario: string;
  Now: string;
  Sessions: readonly (Omit<LLMSessionContext, 'Anchors' | 'Segments'> & {
    Anchors: Record<string, LLMSessionContext['Anchors'] extends ReadonlyMap<string, infer T> ? T : never>;
    Segments: Record<string, ContextSegment>;
  })[];
  Actions: readonly Action[];
  Steps: readonly unknown[];
};

function revive(_key: string, value: TextContent | SummaryContent | ToolCallContent | ToolResultContent) {
  if (!value || typeof value !== 'object') return value;
  switch (value.kind) {
    case 'TextContent': return new TextContent(value.Text);
    case 'SummaryContent': return new SummaryContent(value.Text, value.ThroughSequence);
    case 'ToolCallContent': return new ToolCallContent(value.CallId, value.ToolName, value.ArgumentsJson);
    case 'ToolResultContent': return new ToolResultContent(value.CallId, value.ResultJson, value.IsError);
    default: return value;
  }
}

function observe(read: ILLMContextReadLease, request: ReplayRequest) {
  const observation = {
    SessionRevision: read.Session.Revision, MemoryRevision: read.MemoryRevision,
    Entries: [] as readonly unknown[], Hits: [] as readonly unknown[], Anchors: [] as readonly unknown[],
    Memories: [] as readonly unknown[], Model: [] as readonly unknown[],
  };
  switch (request.Kind) {
    case 'Range': observation.Entries = read.ReadRange(request.FromSequence, request.Limit); break;
    case 'Search': observation.Hits = read.Search(request.Query, request.Limit); break;
    case 'Anchor': observation.Anchors = [read.ResolveAnchor(request.AnchorId)]; break;
    case 'Memory': observation.Memories = read.GetApplicableMemory(request.Scopes); break;
    case 'Conversation':
      observation.Entries = [...Entries(read.Session)]
        .filter((entry) => (entry.Role === ContextRole.User || entry.Role === ContextRole.Assistant) && entry.Content instanceof TextContent)
        .slice(0, request.Limit);
      break;
    case 'Model':
      observation.Model = BuildModelContext(Entries(read.Session), read.GetApplicableMemory(request.Scopes),
        request.TokenBudget, (text) => Math.ceil(text.length / 4), request.Limit);
      break;
  }
  return observation;
}

function normalized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => item === null ? undefined : item));
}

let scenarios = 0;
let steps = 0;
const measure = process.argv.includes('--measure');
const soak = process.argv.includes('--soak');

function sourceHash() {
  const hash = createHash('sha256');
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.ts')) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  for (const directory of ['src', 'benchmarks', join('tests', 'reference')]) {
    if (directory === join('tests', 'reference')) {
      hash.update(readFileSync(join(directory, 'verify-replay.ts')));
    } else visit(directory);
  }
  for (const path of ['tsconfig.json', 'package.json', 'package-lock.json']) hash.update(readFileSync(path));
  return hash.digest('hex');
}

function consume(value: unknown, initial: number): number {
  let hash = initial;
  const mix = (part: number) => { hash = Math.imul(hash ^ part, 16777619) >>> 0; };
  const visit = (item: unknown) => {
    if (typeof item === 'string') {
      mix(item.length);
      for (let index = 0; index < item.length; index++) mix(item.charCodeAt(index));
    } else if (typeof item === 'number' || typeof item === 'bigint') {
      const low = typeof item === 'bigint' ? Number(item & 0xffff_ffffn) : item >>> 0;
      const high = typeof item === 'bigint' ? Number(item >> 32n) >>> 0 : Math.trunc(item / 0x1_0000_0000) >>> 0;
      mix(low);
      mix(high);
    } else if (item != null && typeof item === 'object') {
      if (Array.isArray(item)) {
        mix(item.length);
        for (const element of item) visit(element);
      } else {
        const fields = item as Record<string, unknown>;
        for (const key of Object.keys(fields).sort()) if (fields[key] != null) visit(fields[key]);
      }
    } else if (typeof item === 'boolean') mix(item ? 1 : 0);
  };
  visit(value);
  return hash;
}

const evidence = measure || soak ? { sourceSha256: sourceHash(), runtime: process.version, v8: process.versions.v8,
  platform: process.platform, architecture: process.arch, execArgv: process.execArgv,
  nodeOptions: process.env.NODE_OPTIONS ?? null, command: process.argv } : null;
interface Participant {
  Apply(changes: ContextChangeSet): { Revision: Int64; Status: string };
  ApplyMemory(changes: MemoryChangeSet): { Revision: Int64; Status: string };
  Read(session: string, request: ReplayRequest): { SessionRevision: Int64 };
  Capture(session: string): RetentionCapture;
}

function nativeParticipant(owner: ILLMContextPolymorphicArray): Participant {
  return {
    Apply(changes) {
      const { Status, Revision } = owner.Apply(changes);
      return { Status, Revision };
    },
    ApplyMemory(changes) {
      const { Status, Revision } = owner.ApplyMemory(changes);
      return { Status, Revision };
    },
    Read: (session, request) => owner.WithCurrent(session, (read) => observe(read, request)),
    Capture(session) {
      const lease = owner.OpenRead(session);
      return { get Revision() { return lease.Session.Revision; },
        get FirstEntry() { return lease.ReadRange(0, 1)[0]; }, Release: () => lease.dispose() };
    },
  };
}

function run(participant: Participant, { Actions, Steps, Scenario }: Scenario, label: string, sample = false) {
  const retained = new Map<number, RetentionCapture>();
  const execute = (action: Action) => {
    const { Kind, SessionId, RetentionId } = action;
    switch (Kind) {
      case 'Read': {
        const Observation = participant.Read(SessionId, action.Request);
        return { Kind, Observation, Revision: Observation.SessionRevision };
      }
      case 'Change': return { Kind, ...participant.Apply({ SessionId, ExpectedRevision: action.ExpectedRevision, Changes: action.Changes }) };
      case 'Memory': return { Kind, ...participant.ApplyMemory(action.Memory) };
      case 'Retain':
      case 'CheckRetained': {
        if (Kind === 'Retain') {
          assert(!retained.has(RetentionId));
          retained.set(RetentionId, participant.Capture(SessionId));
        }
        const lease = retained.get(RetentionId);
        assert(lease);
        return { Kind, Revision: lease.Revision, RetainedFirst: lease.FirstEntry };
      }
      case 'Release': {
        const lease = retained.get(RetentionId);
        assert(lease);
        const Revision = lease.Revision;
        lease.Release?.();
        retained.delete(RetentionId);
        return { Kind, Revision };
      }
    }
  };
  try {
    assert.equal(Actions.length, Steps.length, Scenario);
    const observed = [];
    const samples = [];
    let digest = 2166136261;
    const started = process.hrtime.bigint();
    for (const action of Actions) {
      const before = sample ? process.hrtime.bigint() : 0n;
      const step = execute(action);
      if (sample) {
        digest = consume(step, digest);
        samples.push({ category: action.Kind === 'Read' ? action.Request.Kind : action.Kind,
          revision: step.Revision, status: 'Status' in step ? step.Status : null, elapsedNs: String(process.hrtime.bigint() - before) });
      }
      observed.push(step);
    }
    const elapsedNs = process.hrtime.bigint() - started;
    for (const [index, step] of observed.entries()) {
      assert.deepEqual(normalized(step), normalized(Steps[index]), `${label}: ${Scenario} operation ${index} (${Actions[index].Kind})`);
    }
    return { elapsedNs: String(elapsedNs), samples, digest };
  } finally {
    for (const lease of retained.values()) lease.Release?.();
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const replay = JSON.parse(line, revive) as Scenario;
  const { Scenario, Now, Sessions, Actions, Steps: _steps, ...options } = replay;
  const sessions = Sessions.map((session) => ({ ...session,
    Anchors: new Map(Object.entries(session.Anchors)),
    Segments: new Map(Object.values(session.Segments).map((segment) => [segment.SegmentId, segment])),
  }));
  const oracle = new SemanticOracle(sessions, Now);
  const inputSha256 = measure ? createHash('sha256').update(line).digest('hex') : undefined;
  let digest: number | undefined;
  const record = (participant: string, data: ReturnType<typeof run>) => {
    if (!measure) return;
    digest ??= data.digest;
    assert.equal(data.digest, digest, `${participant}: ${Scenario} output digest`);
    console.log(JSON.stringify({ scenario: Scenario, participant, inputSha256, ...evidence, ...data }));
  };
  run({
    Apply: (changes) => oracle.Apply(changes),
    ApplyMemory: (changes) => oracle.ApplyMemory(changes),
    Read: (session, request) => oracle.Capture(session).Read(request),
    Capture: (session) => oracle.Capture(session),
  }, replay, 'TypeScript semantic oracle');
  for (const indexed of [false, true]) {
    const conventional = new ConventionalParticipant(sessions, Now, indexed, options.MaximumRetainedReads);
    const label = indexed ? 'ConventionalIndexed' : 'ConventionalScan';
    try { record(label, run(conventional, replay, label, measure)); }
    finally { assert.equal(conventional.RetainedReads, 0, `${Scenario} leaked a conventional read`); }
  }
  const builder = LLMContextFactory.Create({ ...options, TimeProvider: { now: () => Now } });
  const owner = builder.Initialize(sessions);
  try {
    const result = run(nativeParticipant(owner), replay, 'LLMPolymorphic', measure);
    record('LLMPolymorphic', result);
    if (soak && Scenario === 'Retention') {
      for (const [label, indexed] of [['ConventionalScan', false], ['ConventionalIndexed', true]] as const) {
        const participant = new ConventionalParticipant(sessions, Now, indexed, options.MaximumRetainedReads);
        const samples = await retentionSoak(participant, sessions[0].SessionId);
        assert.equal(participant.RetainedReads, 0);
        console.log(JSON.stringify({ diagnostic: 'retention', participant: label, ...evidence, samples }));
      }
      const fresh = builder.Initialize(sessions);
      try {
        const samples = await retentionSoak(nativeParticipant(fresh), sessions[0].SessionId);
        assert.equal(fresh.GetStatistics().RetainedReads, 0);
        console.log(JSON.stringify({ diagnostic: 'retention', participant: 'LLMPolymorphic', ...evidence, samples }));
      } finally { fresh.dispose(); }
    }
    steps += Actions.length;
    scenarios++;
  } finally {
    try { assert.equal(owner.GetStatistics().RetainedReads, 0, `${Scenario} leaked a read`); }
    finally { owner.dispose(); }
  }
}
assert.equal(scenarios, 7);
const summary = `Matched ${steps} replay steps across ${scenarios} reference scenarios with four TypeScript participants.`;
if (measure || soak) console.error(summary);
else console.log(summary);
