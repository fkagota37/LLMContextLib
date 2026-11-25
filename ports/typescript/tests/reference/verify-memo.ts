// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { testGuid } from '../test-guid.js';
import { createInterface } from 'node:readline';
import { WithBitFasterTermMemoization, defaultBitFasterTermMemoOptions } from '../../adapters/bitfaster/index.js';
import { ContextMutationStatus, ContextRole, SessionStatus, TextContent } from '../../src/domain/session.js';
import { LLMContextFactory } from '../../src/factory.js';

type Trace = { capacity: number; steps: { key: string; hit: boolean; count: number }[] };
let traces = 0;
let observations = 0;

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const { capacity, steps }: Trace = JSON.parse(line);
  const owner = WithBitFasterTermMemoization(LLMContextFactory.Create(), {
    ...defaultBitFasterTermMemoOptions, Capacity: capacity,
  }).Initialize([{
    SessionId: testGuid('session'), UserId: testGuid('user'), RepositoryId: null,
    Revision: 0, Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
  }]);

  try {
    let hits = 0n;
    for (const [index, step] of steps.entries()) {
      const applied = owner.Apply({
        SessionId: testGuid('session'), ExpectedRevision: index,
        Changes: [{ kind: 'AppendEntries', Entries: [{
          EntryId: testGuid(`entry-${index}`), Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent(step.key),
        }] }],
      });
      if (applied.Status !== ContextMutationStatus.Applied) {
        throw new Error(`Trace ${traces}, step ${index}: ${applied.Status}: ${applied.Error}`);
      }
      const stats = owner.GetStatistics().Execution!;
      const nextHits = BigInt(stats.MemoHits);
      if (nextHits - hits !== (step.hit ? 1n : 0n) || stats.MemoEntries !== step.count) {
        throw new Error(`Trace ${traces}, step ${index}: ${step.key} hit=${nextHits > hits}, count=${stats.MemoEntries}; expected hit=${step.hit}, count=${step.count}`);
      }
      hits = nextHits;
      observations++;
    }
    traces++;
  } finally {
    owner.dispose();
  }
}

if (traces !== 320 || observations !== 76800) throw new Error('Reference observations were incomplete.');
console.log(`${traces} traces, ${observations} BitFaster hit/count observations matched.`);
