// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContextRole, SessionStatus, TextContent } from '../../src/domain/session.js';
import type { ILLMContextReadLease } from '../../src/domain/reads.js';
import { LLMContextFactory } from '../../src/factory.js';
import { WriteOptimized } from '../../src/options.js';
import { defaultPartitionedContextIndexOptions, type ContextIndexSynchronization } from '../../src/storage/partitioned-index.js';

const id = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const [session, user, first, second] = [1, 2, 3, 4].map(id);
const builder = process.argv.includes('--write-optimized') ? LLMContextFactory.Create(WriteOptimized) :
  LLMContextFactory.Create().WithPartitionedIndexing({ ...defaultPartitionedContextIndexOptions, MaximumWorkingSetEntries: 2 });
const owner = builder.Initialize([{
  SessionId: session, UserId: user, RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
  Segments: new Map([[0, {
    SegmentId: 0, Revision: 0, Entries: [first, second].map((EntryId, Sequence) => ({
      EntryId, Sequence, Role: ContextRole.User, CreatedAt: '1970-01-01T00:00:00Z',
      Content: new TextContent('base'), IndexKeys: ['base'],
    })),
  }]]), Anchors: new Map(),
}]);
const expected = readFileSync(0, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
let rows = 0;
const trace = (label: string, read: ILLMContextReadLease, status: string | null = null, synchronization: ContextIndexSynchronization | null = null) => {
  const revision = read.Session.Revision;
  const stats = owner.GetStatistics();
  assert.deepEqual({
    label, status, synchronization, revision, generation: read.IndexStatus.IndexGeneration,
    shared: read.SearchKeys(['base'], 8).map((hit) => hit.EntryId),
    working: read.SearchKeys(['override'], 8).map((hit) => hit.EntryId),
    mixed: read.SearchKeys(['base', 'override'], 8).map((hit) => hit.EntryId),
    active: stats.EstimatedActiveBytes, retained: stats.EstimatedRetainedBytes, recovery: stats.EstimatedSynchronizationReserveBytes,
  }, expected[rows++], label);
};

const original = owner.OpenRead(session);
try {
  trace('original', original);
  const replace = owner.Apply({ SessionId: session, ExpectedRevision: 0, Changes: [
    { kind: 'ReplaceEntry', EntryId: first, Content: new TextContent('override'), IndexKeys: ['override'] },
  ] });
  const working = owner.OpenRead(session);
  try {
    trace('working', working, replace.Status);
    const synchronize = await owner.SynchronizeIndexAsync(session);
    owner.WithCurrent(session, (read) => trace('compacted', read, null, synchronize));
    trace('old-base', original);
    trace('old-working', working);
    const remove = owner.Apply({ SessionId: session, ExpectedRevision: 1, Changes: [
      { kind: 'DeleteEntry', EntryId: first }, { kind: 'DeleteEntry', EntryId: second },
    ] });
    owner.WithCurrent(session, (read) => trace('drop', read, remove.Status));
  } finally { working.dispose(); }
  original.dispose();
  owner.WithCurrent(session, (read) => trace('released', read));
  assert.equal(rows, expected.length);
  console.log(`Matched ${rows} partition generation and accounting snapshots.`);
} finally {
  original.dispose();
  owner.dispose();
}
