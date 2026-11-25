// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AnchorKind, ContextRole, SessionStatus, TextContent,
  type ContextChangeSet, type IContextMutationResult,
} from '../../src/domain/session.js';
import { LLMContextFactory } from '../../src/factory.js';
import type { ILLMContextReadLease } from '../../src/domain/reads.js';
import { ContextViews } from '../../src/views.js';

const id = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const [session, user, first, second, bookmark] = [1, 2, 3, 4, 5].map(id);
const original = new TextContent('wide Straße');
const maximum = (1n << 63n) - 1n;
const owner = LLMContextFactory.Create({
  MaximumEstimatedBytesPerSegment: maximum,
  EstimatedResidentByteBudget: maximum,
  MaximumEstimatedRetainedBytes: maximum,
  EntrySizeEstimator: (entry) => (entry.Content as TextContent).Text === 'overflow' ? maximum : 9007199254740993n,
  ProjectionSizeEstimator: () => 41,
}).WithExecutionStrategies().Initialize([{
  SessionId: session, UserId: user, RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
  Segments: new Map(), Anchors: new Map(),
}]);

const expected = readFileSync(0, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
let rows = 0;
const trace = (label: string, result?: IContextMutationResult, old?: ILLMContextReadLease) => {
  const { hits, entries, revision } = owner.WithCurrent(session, (read) => ({
    hits: read.Search('label', 8).map((hit) => hit.EntryId),
    entries: read.ReadRange(0, 8).map((entry) => (entry.Content as TextContent).Text),
    revision: read.Session.Revision,
  }));
  const stats = owner.GetStatistics();
  assert.deepEqual({
    label, status: result?.Status ?? null, revision, hits, entries, oldRevision: old?.Session.Revision ?? null,
    active: String(stats.EstimatedActiveBytes), retained: String(stats.EstimatedRetainedBytes),
    view: String(stats.EstimatedViewBytes), reads: stats.RetainedReads,
    published: stats.PublishedMutations, rewrites: stats.SegmentsRewritten,
    rewrittenBytes: String(stats.EstimatedSegmentBytesRewritten),
    collections: stats.Execution?.TermCollections, synchronous: stats.Execution?.SynchronousEntries,
  }, expected[rows++], label);
};
const apply = (revision: number, ...changes: ContextChangeSet['Changes']) =>
  owner.Apply({ SessionId: session, ExpectedRevision: revision, Changes: changes });
const append = (entry: string, content: TextContent) => ({
  kind: 'AppendEntries' as const, Entries: [{
    EntryId: entry, Role: ContextRole.User, CreatedAt: '1970-01-01T00:00:00Z', Content: content,
  }],
});
const replace = (entry: string, content: TextContent) => ({ kind: 'ReplaceEntry' as const, EntryId: entry, Content: content });
const anchor = (start: string, revision: number) => ({
  kind: 'PutAnchor' as const, Anchor: {
    AnchorId: bookmark, StartEntryId: start, EndEntryId: second, Title: 'label', Summary: 'memo',
    Topics: ['topic'], Kind: AnchorKind.Manual, SourceRevision: revision, PinnedRevision: null,
  },
});

try {
  trace('created');
  trace('append', apply(0, append(first, original)));
  const old = owner.OpenRead(session);
  try {
    trace('capture', undefined, old);
    trace('invalid', apply(1, replace(first, new TextContent('discarded')), replace(second, new TextContent('unknown'))), old);
    trace('overflow', apply(1, replace(first, new TextContent('overflow'))), old);
    trace('same-payload', apply(1, replace(first, original)), old);
    trace('replace', apply(2, replace(first, new TextContent('discarded')), replace(first, new TextContent('final Straße'))), old);
    trace('anchor', apply(3, append(second, new TextContent('tail')), anchor(first, 4)), old);
    trace('relocate', apply(4, anchor(second, 5)), old);
    const view = owner.OpenView(ContextViews.Timeline(session));
    try {
      trace('view', undefined, old);
    } finally {
      view.dispose();
    }
    trace('delete', apply(5, { kind: 'DeleteEntry', EntryId: second }), old);
    const segment = owner.TryFind(session)!.Segments.values().next().value!;
    const [entry] = segment.Entries;
    trace('segment-invalid-sequence', apply(6, {
      kind: 'ReplaceSegment', SegmentId: segment.SegmentId, Entries: [{ ...entry, Sequence: Number(entry.Sequence) + 1 }],
    }), old);
    const replacement = { kind: 'ReplaceSegment' as const, SegmentId: segment.SegmentId,
      Entries: [{ ...entry, Content: new TextContent('segment label') }] };
    trace('segment-replace', apply(6, replacement), old);
    trace('segment-stale', apply(6, replacement), old);
  } finally {
    old.dispose();
  }
  trace('released');
  assert.equal(rows, expected.length);
  console.log(`Matched ${rows} mutation and accounting snapshots.`);
} finally {
  owner.dispose();
}
