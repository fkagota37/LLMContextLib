// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AnchorKind, ContextRole, SessionStatus, TextContent,
  type ContextChangeSet, type IContextMutationResult } from '../../src/domain/session.js';
import type { ILLMContextReadLease } from '../../src/domain/reads.js';
import { WriteOptimized } from '../../src/options.js';
import { LLMContextOwner } from '../../src/storage/owner.js';
import type { ContextIndexSynchronization } from '../../src/storage/partitioned-index.js';

const [session, user, old, appended, discarded, anchor] =
  [1, 2, 3, 4, 5, 6].map((value) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`);
const draft = (EntryId: string, text = 'temporary') => ({
  EntryId, Role: ContextRole.User, CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent(text), IndexKeys: [text],
});
const replace = (EntryId: string) => ({ kind: 'ReplaceEntry' as const, EntryId, Content: new TextContent('final'), IndexKeys: ['final'] });
const remove = (EntryId: string) => ({ kind: 'DeleteEntry' as const, EntryId });
const owner = new LLMContextOwner(WriteOptimized);
owner.initialize([{
  SessionId: session, UserId: user, RepositoryId: null, Revision: 0, Status: SessionStatus.Active, Anchors: new Map(),
  Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [{ ...draft(old, 'base'), Sequence: 0 }] }]]),
}]);
const reference = readFileSync(0, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
let rows = 0;
const trace = (label: string, read: ILLMContextReadLease, result?: IContextMutationResult, synchronization: ContextIndexSynchronization | null = null) => {
  const stats = owner.getStatistics();
  assert.deepEqual({
    label, status: result?.Status ?? null, appended: result?.AppendedEntryIds ?? null, synchronization,
    revision: read.Session.Revision, generation: read.IndexStatus.IndexGeneration,
    entries: read.ReadRange(0, 8).map(({ EntryId, Sequence, Content }) => ({ EntryId, Sequence, Text: (Content as TextContent).Text })),
    hits: ['base', 'temporary', 'final'].map((key) => read.SearchKeys([key], 8).map((hit) => hit.EntryId)),
    anchors: [...read.Session.Anchors.values()].map(({ AnchorId, StartEntryId, EndEntryId, Title }) => ({ AnchorId, StartEntryId, EndEntryId, Title })),
    active: stats.EstimatedActiveBytes, retained: stats.EstimatedRetainedBytes, preparation: stats.EstimatedPreparationBytes,
    rewrites: stats.SegmentsRewritten, rewrittenBytes: stats.EstimatedSegmentBytesRewritten,
  }, reference[rows++], label);
};
async function mutate(ExpectedRevision: number, Changes: ContextChangeSet['Changes']) {
  const result = owner.applySessionFromWorker({ SessionId: session, ExpectedRevision, Changes });
  assert(BigInt(owner.getStatistics().EstimatedPreparationBytes) > 0n, 'The worker must hold a reservation during preparation.');
  return await result;
}
function current(label: string, result?: IContextMutationResult, synchronization?: ContextIndexSynchronization) {
  const read = owner.openRead(session);
  try { trace(label, read, result, synchronization); } finally { read.dispose(); }
}
const original = owner.openRead(session);
try {
  const rollback = await mutate(0, [remove(old), replace(old)]);
  current('rollback', rollback);
  const mixed = await mutate(0, [
    remove(old), { kind: 'AppendEntries', Entries: [draft(appended), draft(discarded)] }, replace(appended), remove(discarded),
    { kind: 'PutAnchor', Anchor: { AnchorId: anchor, StartEntryId: appended, EndEntryId: appended, Title: 'retained',
      Summary: '', Topics: [], Kind: AnchorKind.Manual, SourceRevision: 1, PinnedRevision: null, IndexKeys: ['anchor'] } },
  ]);
  current('mixed', mixed);
  const synchronization = await owner.synchronizeIndexAsync(session);
  current('compacted', undefined, synchronization);
  trace('original', original);
  const tombstone = await mutate(1, [{ kind: 'AppendEntries', Entries: [draft(discarded)] }]);
  current('tombstone', tombstone);
  assert.equal(rows, reference.length);
  console.log(`Matched ${rows} WriteOptimized mixed worker snapshots.`);
} finally {
  original.dispose();
  owner.dispose();
}
