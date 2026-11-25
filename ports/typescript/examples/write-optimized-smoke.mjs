// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import {
  ContextMutationStatus, ContextRole, LLMContextFactory, LLMContextOptions, SessionStatus, TextContent,
} from 'llmcontextlib-port-typescript';

const SessionId = '00000000-0000-0000-0000-000000000001';
const UserId = '00000000-0000-0000-0000-000000000002';
const EntryId = '00000000-0000-0000-0000-000000000003';
const owner = LLMContextFactory.Create(LLMContextOptions.WriteOptimized).Initialize([{
  SessionId, UserId, RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
  Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [{
    EntryId, Sequence: 0, Role: ContextRole.User, CreatedAt: '2026-01-01T00:00:00Z',
    Content: new TextContent('Build investigation started'), IndexKeys: ['started'],
  }] }]]),
  Anchors: new Map(),
}]);

const snapshot = owner.OpenRead(SessionId);
const replace = (key) => owner.Apply({ SessionId, ExpectedRevision: 0, Changes: [
  { kind: 'ReplaceEntry', EntryId, Content: new TextContent(`Build investigation ${key}`), IndexKeys: [key] },
] });
const observe = (read, key) => read.SearchKeys([key], 1).map(({ EntryId, Snippet }) => ({ EntryId, Snippet }));
let output;
try {
  const applied = replace('completed');
  const stale = replace('reopened');
  assert.equal(applied.Status, ContextMutationStatus.Applied);
  assert.equal(stale.Status, ContextMutationStatus.RevisionConflict);
  assert.equal(applied.Revision, 1);
  assert.equal(stale.Revision, 1);
  const compacted = await owner.SynchronizeIndexAsync(SessionId, AbortSignal.timeout(8000));
  assert.equal(compacted.Succeeded, true, compacted.Error);
  assert.equal(compacted.ContentRevision, 1);
  assert.equal(compacted.PartitionsCompacted, 1);
  const current = owner.WithCurrent(SessionId, (read) => {
    assert.deepEqual(observe(read, 'started'), []);
    assert.deepEqual(observe(read, 'reopened'), []);
    const hits = observe(read, 'completed');
    assert.deepEqual(hits, [{ EntryId, Snippet: 'Build investigation completed' }]);
    return { revision: read.Session.Revision, key: 'completed', hits };
  });
  const oldHits = observe(snapshot, 'started');
  assert.deepEqual(oldHits, [{ EntryId, Snippet: 'Build investigation started' }]);
  assert.deepEqual(observe(snapshot, 'completed'), []);
  output = {
    preset: 'WriteOptimized',
    writes: [{ status: applied.Status, revision: applied.Revision }, { status: stale.Status, revision: stale.Revision }],
    compaction: { succeeded: compacted.Succeeded, partitions: compacted.PartitionsCompacted, generation: compacted.Generation },
    snapshot: { revision: snapshot.Session.Revision, key: 'started', hits: oldHits },
    current,
  };
} finally {
  snapshot.dispose();
  const { RetainedReads, EstimatedViewBytes, PendingSynchronizations } = owner.GetStatistics();
  owner.dispose();
  assert.deepEqual({ RetainedReads, EstimatedViewBytes, PendingSynchronizations },
    { RetainedReads: 0, EstimatedViewBytes: 0, PendingSynchronizations: 0 });
  if (output) console.log(JSON.stringify({ ...output, cleanup: { RetainedReads, EstimatedViewBytes, PendingSynchronizations } }, null, 2));
}
