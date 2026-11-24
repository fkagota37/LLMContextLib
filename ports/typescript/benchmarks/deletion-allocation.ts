// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { defaultLLMContextOptions } from '../src/options.js';
import { Entries } from '../src/policies/context.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { readReferenceFixture, restoreSession, type WireSession } from './reference-fixture.js';
import { SemanticOracle } from './semantic-oracle.js';
import { sourceDigest } from './source-digest.js';

const [fixturePath, repetitionsArgument] = process.argv.slice(2);
const repetitions = Number(repetitionsArgument ?? 5);
assert(fixturePath && Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 20,
  'Usage: deletion-allocation.ts <pressure-fixture.json> [repetitions]');
const raw = readFileSync(fixturePath, 'utf8').replace(/^\uFEFF/, '');
const { Now, Sessions } = readReferenceFixture<{ Now: string; Sessions: WireSession[] }>(raw);
assert.equal(Sessions.length, 1);
const session = restoreSession(Sessions[0]);
const { SessionId } = session;
const entries = [...Entries(session)];
assert(entries.length >= 32);
const positions = ['Begin', 'Middle', 'End'] as const;
const sampling = { samplingInterval: 128, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true };
const inspector = new Session();
inspector.connect();
try {
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (let index = 0; index < positions.length; index++) {
      const position = positions[(index + repetition) % positions.length];
      const target = entries[position === 'Begin' ? 0 : position === 'End' ? entries.length - 1 : Math.floor(entries.length / 2)];
      const change = { SessionId, ExpectedRevision: 0, Changes: [{ kind: 'DeleteEntry' as const, EntryId: target.EntryId }] };
      const oracle = new SemanticOracle([session], Now);
      const expected = oracle.Apply(change);
      const owner = new LLMContextOwner({
        ...defaultLLMContextOptions, EstimatedResidentByteBudget: 2 * 1024 ** 3,
        MaximumEstimatedRetainedBytes: 1024 ** 3, TimeProvider: { now: () => Date.parse(Now) },
      });
      try {
        owner.initialize([session]);
        await inspector.post('HeapProfiler.startSampling', sampling);
        let result;
        try { result = owner.applySession(change); }
        finally {
          const { profile } = await inspector.post('HeapProfiler.stopSampling');
          const stacks: { category: string; bytes: number; frames: string[] }[] = [];
          const walk = (node: typeof profile.head, ancestry: string[] = []) => {
            const { functionName, url, lineNumber } = node.callFrame;
            const frame = `${url}:${lineNumber + 1}:${functionName}`;
            const frames = [...ancestry, frame];
            if (node.selfSize > 0) {
              const category = frames.some((item) => item.includes('session-index.ts:')) ? 'Index' :
                frames.some((item) => item.endsWith(':copyEntryLocations')) ? 'LocationDirectoryCopy' :
                frames.some((item) => /:updateEntryLocations?$/.test(item)) ? 'LocationDirectoryUpdate' :
                frames.some((item) => item.includes('session-store.ts:') && /:(?:copySegmentEntries|segment)$/.test(item)) ? 'SegmentCopyAndConstruction' :
                frames.some((item) => item.includes('session-store.ts:')) ? 'OtherStoragePreparation' :
                frames.some((item) => item.includes('owner.ts:')) ? 'Owner' : 'HarnessOrProfiler';
              stacks.push({ category, bytes: node.selfSize, frames });
            }
            for (const child of node.children) walk(child, frames);
          };
          walk(profile.head);
          const categories: Record<string, number> = Object.create(null);
          for (const { category, bytes } of stacks) categories[category] = (categories[category] ?? 0) + bytes;
          runs.push({ position, repetition, categories, stacks });
        }
        assert.deepEqual({ Status: result.Status, Revision: result.Revision }, expected);
        const final = owner.tryFindSession(SessionId)!;
        const expectedEntries = oracle.Capture(SessionId).Read({ Kind: 'Range', FromSequence: 0, Limit: 0x7fff_ffff }).Entries;
        assert.deepEqual(JSON.parse(JSON.stringify([...Entries(final)])), JSON.parse(JSON.stringify(expectedEntries)));
        assert.equal(owner.getStatistics().RetainedReads, 0);
      } finally { owner.dispose(); }
    }
  }
  console.log(JSON.stringify({ kind: 'DeletionAllocation', entries: entries.length, sampling, runs,
    sourceDigest: sourceDigest(), fixtureSha256: createHash('sha256').update(raw).digest('hex'),
    runtime: { node: process.version, v8: process.versions.v8, arch: process.arch, execArgv: process.execArgv, argv: process.argv.slice(1) },
    evidenceLimits: 'V8 stack-sampled allocation estimates only; initialization, oracle, and final observation lie outside the profiled operation.' }));
} finally { inspector.disconnect(); }
