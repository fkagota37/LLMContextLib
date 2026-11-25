// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { expect, it } from 'vitest';
import { ContextIndexingMode } from '../src/domain/index-keys.js';
import { AnchorKind, ContextMutationStatus, ContextRole, SessionStatus, TextContent, type ContextChange } from '../src/domain/session.js';
import { ContextExecutionRecipe, ContextIndexingStrategy, defaultContextExecutionOptions } from '../src/execution/strategy.js';
import { defaultDeferredIndexingOptions, defaultLLMContextOptions, WriteOptimized } from '../src/options.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { testGuid } from './test-guid.js';

const SessionId = testGuid('session');
const EntryId = testGuid('entry');
const NeighborId = testGuid('neighbor');
const OtherSegmentId = testGuid('other segment entry');
const replace = (key: string, id = EntryId, content = key) => ({
  kind: 'ReplaceEntry' as const, EntryId: id, Content: new TextContent(content), IndexKeys: [key],
});
const change = (ExpectedRevision: number, key: string) => ({
  SessionId, ExpectedRevision, Changes: [replace(key)],
});

function initialize(options = WriteOptimized, multipleSegments = false, recipe?: ContextExecutionRecipe) {
  const owner = new LLMContextOwner(options, undefined, recipe);
  const entry = (EntryId: string, Sequence: number) => ({
    EntryId, Sequence, Role: ContextRole.User,
    CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('base'),
    IndexKeys: options.IndexingMode === ContextIndexingMode.ProducerOwned ? ['base'] : undefined,
  });
  const segments = new Map([[0, {
    SegmentId: 0, Revision: 0, Entries: multipleSegments ? [entry(EntryId, 0), entry(NeighborId, 1)] : [entry(EntryId, 0)],
  }]]);
  if (multipleSegments) segments.set(1, { SegmentId: 1, Revision: 0, Entries: [entry(OtherSegmentId, 2)] });
  owner.initialize([{ SessionId, UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
    Anchors: new Map(), Segments: segments }]);
  return owner;
}

it('preserves owner-local collector ordering and attribution for accepted and rolled-back worker preparations', async () => {
  const localCalls: string[] = [];
  const workerCalls: string[] = [];
  const recipe = (calls: string[]) => new ContextExecutionRecipe(() => ({
    Name: 'test',
    Collect(text) {
      calls.push(text);
      return Object.freeze([...new Set(text.split(' '))]);
    },
  }), true);
  const options = { ...defaultLLMContextOptions, Execution: { ...defaultContextExecutionOptions, Indexing: ContextIndexingStrategy.Synchronous } };
  const local = initialize(options, true, recipe(localCalls));
  const owner = initialize(options, true, recipe(workerCalls));
  const replace = (text: string): ContextChange => ({ kind: 'ReplaceEntry', EntryId, Content: new TextContent(text) });
  try {
    const invalid = { SessionId, ExpectedRevision: 0, Changes: [
      replace('before rollback'), { kind: 'DeleteEntry' as const, EntryId: testGuid('missing') },
    ] };
    const first = owner.applySessionFromWorker(invalid);
    expect(first).toBeInstanceOf(Promise);
    const rejected = local.applySession(invalid);
    expect(rejected.Status).toBe(ContextMutationStatus.InvalidOperation);
    expect(await first).toEqual(rejected);
    expect(workerCalls).toEqual(localCalls);
    expect(workerCalls.at(-1)).toBe('before rollback');
    expect(owner.getStatistics()).toEqual(local.getStatistics());

    const valid = { SessionId, ExpectedRevision: 0, Changes: [replace('intermediate'), replace('final')] };
    const second = owner.applySessionFromWorker(valid);
    expect(second).toBeInstanceOf(Promise);
    expect(await second).toEqual(local.applySession(valid));
    expect(workerCalls).toEqual(localCalls);
    expect(workerCalls.slice(-2)).toEqual(['intermediate', 'final']);
    expect(owner.getStatistics()).toEqual(local.getStatistics());
  } finally { owner.dispose(); local.dispose(); }
});

it.each([
  ['text', defaultLLMContextOptions],
  ['deferred text', { ...defaultLLMContextOptions, DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundWords: 1 } }],
  ['producer-owned', { ...defaultLLMContextOptions, IndexingMode: ContextIndexingMode.ProducerOwned }],
] as const)('overlaps unpartitioned %s preparation and publishes exact indexes with the content', async (_, options) => {
  const owner = initialize(options, true);
  const inline = initialize(options, true);
  const old = owner.openRead(SessionId);
  const oldInline = inline.openRead(SessionId);
  const appended = testGuid('unpartitioned appended');
  const keys = options.IndexingMode === ContextIndexingMode.ProducerOwned;
  const command = (term: string): ContextChange => ({
    kind: 'ReplaceEntry', EntryId, Content: new TextContent(`prefix ${term}`), IndexKeys: keys ? [term] : undefined,
  });
  const request = (ExpectedRevision: number, ...Changes: ContextChange[]) => ({ SessionId, ExpectedRevision, Changes });
  const search = (read: typeof old, term: string) => keys ? read.SearchKeys([term], 4) : read.Search(term, 4);
  try {
    const first = owner.applySessionFromWorker(request(0, command('loserone')));
    const second = owner.applySessionFromWorker(request(0, command('losertwo')));
    expect(first).toBeInstanceOf(Promise);
    expect(second).toBeInstanceOf(Promise);
    const winner = request(0, command('winner'));
    expect(owner.applySessionFromWorker(winner)).toEqual(inline.applySession(winner));
    expect((await Promise.all([first, second])).map((result) => [result.Status, result.Revision])).toEqual([
      [ContextMutationStatus.RevisionConflict, 1], [ContextMutationStatus.RevisionConflict, 1],
    ]);
    const mixed = request(1, command('final'), { kind: 'DeleteEntry', EntryId: NeighborId }, {
      kind: 'AppendEntries', Entries: [{
        EntryId: appended, Role: ContextRole.User, CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('prefix appended'), IndexKeys: keys ? ['appended'] : undefined,
      }],
    });
    const pending = owner.applySessionFromWorker(mixed);
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual(inline.applySession(mixed));
    const read = owner.openRead(SessionId);
    const expected = inline.openRead(SessionId);
    try {
      expect(read.ReadRange(0, 4)).toEqual(expected.ReadRange(0, 4));
      expect(search(read, 'final')).toMatchObject([{ EntryId }]);
      expect(search(read, 'appended')).toMatchObject([{ EntryId: appended }]);
      expect(search(read, 'winner')).toEqual([]);
      expect(search(read, 'loserone')).toEqual([]);
      expect(search(old, 'base')).toHaveLength(3);
    } finally { read.dispose(); expected.dispose(); }
    await Promise.all([owner.waitForIndexingAsync(SessionId, 2), inline.waitForIndexingAsync(SessionId, 2)]);
    const { CompletedIndexJobs: _done, DiscardedIndexJobs: _discarded, ...statistics } = owner.getStatistics();
    const { CompletedIndexJobs: _expectedDone, DiscardedIndexJobs: _expectedDiscarded, ...expectedStatistics } = inline.getStatistics();
    expect(statistics).toEqual(expectedStatistics);
  } finally { old.dispose(); oldInline.dispose(); owner.dispose(); inline.dispose(); }
});

it('holds two speculative reservations until an index fence rejects both candidates', async () => {
  const owner = initialize();
  try {
    expect(owner.applySession(change(0, 'previous')).Status).toBe(ContextMutationStatus.Applied);
    const first = owner.applySessionFromWorker(change(1, 'first'));
    const firstBytes = BigInt(owner.getStatistics().EstimatedPreparationBytes);
    const second = owner.applySessionFromWorker(change(1, 'second'));
    expect(firstBytes).toBeGreaterThan(0n);
    expect(BigInt(owner.getStatistics().EstimatedPreparationBytes)).toBeGreaterThan(firstBytes);
    const synchronization = owner.synchronizeIndexAsync(SessionId);
    expect(owner.getStatistics().PendingSynchronizations).toBe(1);
    expect((await Promise.all([first, second])).map((result) => result.Status))
      .toEqual([ContextMutationStatus.SynchronizationRequired, ContextMutationStatus.SynchronizationRequired]);
    expect(await synchronization).toMatchObject({ Succeeded: true, PartitionsCompacted: 1, ContentRevision: 1 });
    expect(owner.getStatistics()).toMatchObject({ EstimatedPreparationBytes: 0, PendingSynchronizations: 0 });
    const read = owner.openRead(SessionId);
    try {
      expect(read.SearchKeys(['previous'], 1)).toHaveLength(1);
      expect(read.SearchKeys(['first'], 1)).toEqual([]);
      expect(read.SearchKeys(['second'], 1)).toEqual([]);
    } finally { read.dispose(); }
  } finally { owner.dispose(); }
});

it('prepares repeated and interleaved replacements off-thread and matches inline publication across segments', async () => {
  const local = initialize(WriteOptimized, true);
  const remote = initialize(WriteOptimized, true);
  const old = remote.openRead(SessionId);
  const oldLocal = local.openRead(SessionId);
  try {
    const batch = { SessionId, ExpectedRevision: 0, Changes: [
      replace('intermediate'), replace('other', OtherSegmentId), replace('final'), replace('final', EntryId, 'new text'),
    ] };
    const pending = remote.applySessionFromWorker(batch);
    expect(BigInt(remote.getStatistics().EstimatedPreparationBytes)).toBeGreaterThan(0n);
    expect(await pending).toEqual(local.applySession(batch));
    expect(remote.getStatistics()).toEqual(local.getStatistics());
    const read = remote.openRead(SessionId);
    const expected = local.openRead(SessionId);
    try {
      expect(read.ReadRange(0, 3)).toEqual(expected.ReadRange(0, 3));
      expect(read.SearchKeys(['intermediate'], 3)).toEqual([]);
      expect(read.SearchKeys(['final'], 3)).toMatchObject([{ EntryId }]);
      expect(read.SearchKeys(['other'], 3)).toMatchObject([{ EntryId: OtherSegmentId }]);
      expect(old.SearchKeys(['base'], 3)).toHaveLength(3);
    } finally { read.dispose(); expected.dispose(); }
  } finally { old.dispose(); oldLocal.dispose(); remote.dispose(); local.dispose(); }
});

it('rejects intermediate size and capacity errors without publishing a later command', async () => {
  const options = { ...WriteOptimized, PartitionedIndex: { ...WriteOptimized.PartitionedIndex!, MaximumWorkingSetEntries: 1 } };
  const local = initialize(options, true);
  const remote = initialize(options, true);
  try {
    for (const [Changes, status] of [
      [[replace('large', EntryId, 'x'.repeat(32_768)), replace('small')], ContextMutationStatus.InvalidOperation],
      [[replace('one'), replace('two', NeighborId)], ContextMutationStatus.AdmissionRejected],
    ] as const) {
      const batch = { SessionId, ExpectedRevision: 0, Changes };
      const pending = remote.applySessionFromWorker(batch);
      expect(BigInt(remote.getStatistics().EstimatedPreparationBytes)).toBeGreaterThan(0n);
      const expected = local.applySession(batch);
      expect(expected.Status).toBe(status);
      expect(await pending).toEqual(expected);
      expect(remote.getStatistics()).toEqual(local.getStatistics());
      const read = remote.openRead(SessionId);
      try { expect(read.Session.Revision).toBe(0); } finally { read.dispose(); }
    }
  } finally { remote.dispose(); local.dispose(); }
});

it('falls back inline when both preparation workers are busy and does not rebase their captures', async () => {
  const owner = initialize();
  try {
    const first = owner.applySessionFromWorker(change(0, 'first'));
    const second = owner.applySessionFromWorker(change(0, 'second'));
    expect(owner.applySessionFromWorker(change(0, 'inline'))).toMatchObject({ Status: ContextMutationStatus.Applied });
    expect((await Promise.all([first, second])).map((result) => result.Status))
      .toEqual([ContextMutationStatus.RevisionConflict, ContextMutationStatus.RevisionConflict]);
    expect(owner.getStatistics()).toMatchObject({ EstimatedPreparationBytes: 0 });
  } finally { owner.dispose(); }
});

it('matches inline deletion for base entries, override-only entries, and the last member of a segment', async () => {
  const local = initialize(WriteOptimized, true);
  const remote = initialize(WriteOptimized, true);
  const appended = testGuid('appended');
  const old = remote.openRead(SessionId);
  const oldLocal = local.openRead(SessionId);
  try {
    const append = (ExpectedRevision: number, EntryId: string) => ({
      SessionId, ExpectedRevision, Changes: [{ kind: 'AppendEntries' as const, Entries: [{
        EntryId, Role: ContextRole.User, CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('append'), IndexKeys: ['append'],
      }] }],
    });
    expect(remote.applySession(append(0, appended))).toEqual(local.applySession(append(0, appended)));
    for (const [step, id] of [EntryId, appended, OtherSegmentId].entries()) {
      const mutation = { SessionId, ExpectedRevision: step + 1, Changes: [{ kind: 'DeleteEntry' as const, EntryId: id }] };
      const pending = remote.applySessionFromWorker(mutation);
      expect(BigInt(remote.getStatistics().EstimatedPreparationBytes)).toBeGreaterThan(0n);
      expect(await pending).toEqual(local.applySession(mutation));
      expect(remote.getStatistics()).toEqual(local.getStatistics());
      const actual = remote.openRead(SessionId);
      const expected = local.openRead(SessionId);
      try {
        expect(actual.ReadRange(0, 4)).toEqual(expected.ReadRange(0, 4));
        expect(actual.SearchKeys(['base'], 4)).toEqual(expected.SearchKeys(['base'], 4));
        expect(actual.SearchKeys(['append'], 4)).toEqual(expected.SearchKeys(['append'], 4));
      } finally { actual.dispose(); expected.dispose(); }
    }
    expect(remote.applySession(append(4, EntryId))).toMatchObject({ Status: ContextMutationStatus.InvalidOperation });
    expect(old.SearchKeys(['base'], 4)).toHaveLength(3);
    expect(await remote.synchronizeIndexAsync(SessionId)).toEqual(await local.synchronizeIndexAsync(SessionId));
    expect(remote.getStatistics()).toEqual(local.getStatistics());
  } finally { old.dispose(); oldLocal.dispose(); remote.dispose(); local.dispose(); }
});

it('requires synchronization when a deletion tombstone would exceed an existing working set', async () => {
  const owner = initialize({ ...WriteOptimized, PartitionedIndex: { ...WriteOptimized.PartitionedIndex!, MaximumWorkingSetEntries: 1 } }, true);
  try {
    const replaceNeighbor = { SessionId, ExpectedRevision: 0, Changes: [replace('neighbor', NeighborId)] };
    expect(owner.applySession(replaceNeighbor).Status).toBe(ContextMutationStatus.Applied);
    const deletion = { SessionId, ExpectedRevision: 1, Changes: [{ kind: 'DeleteEntry' as const, EntryId }] };
    expect(await owner.applySessionFromWorker(deletion)).toMatchObject({
      Status: ContextMutationStatus.SynchronizationRequired, Revision: 1,
    });
    const read = owner.openRead(SessionId);
    try { expect(read.SearchKeys(['base'], 3)).toMatchObject([{ EntryId }, { EntryId: OtherSegmentId }]); }
    finally { read.dispose(); }
    expect(await owner.synchronizeIndexAsync(SessionId)).toMatchObject({ Succeeded: true, ContentRevision: 1 });
    expect(await owner.applySessionFromWorker(deletion)).toMatchObject({ Status: ContextMutationStatus.Applied, Revision: 2 });
  } finally { owner.dispose(); }
});

it('validates whole-segment membership and checks only the final segment size before publishing metadata', async () => {
  const local = initialize(WriteOptimized, true);
  const remote = initialize(WriteOptimized, true);
  try {
    const seed = { SessionId, ExpectedRevision: 0, Changes: [replace('base', NeighborId, 'y'.repeat(10_000))] };
    expect(remote.applySession(seed)).toEqual(local.applySession(seed));
    const old = remote.openRead(SessionId);
    const oldLocal = local.openRead(SessionId);
    try {
      const originals = old.Session.Segments.get(0)!.Entries;
      const first = { ...originals[0], Role: ContextRole.Assistant, Content: new TextContent('x'.repeat(10_000)),
        CreatedAt: '2026-01-03T00:00:00Z', IndexKeys: ['updated'] };
      const last = { ...originals[1], Content: new TextContent('small'), IndexKeys: ['small'] };
      for (const [Entries, Status] of [
        [[last, first], ContextMutationStatus.InvalidOperation],
        [[first, last], ContextMutationStatus.Applied],
      ] as const) {
        const mutation = { SessionId, ExpectedRevision: 1, Changes: [{ kind: 'ReplaceSegment' as const, SegmentId: 0, Entries }] };
        const pending = remote.applySessionFromWorker(mutation);
        expect(BigInt(remote.getStatistics().EstimatedPreparationBytes)).toBeGreaterThan(0n);
        const expected = local.applySession(mutation);
        expect(expected.Status).toBe(Status);
        expect(await pending).toEqual(expected);
        expect(remote.getStatistics()).toEqual(local.getStatistics());
      }
      const current = remote.openRead(SessionId);
      const expected = local.openRead(SessionId);
      try {
        expect(current.ReadRange(0, 3)).toEqual(expected.ReadRange(0, 3));
        expect(current.SearchKeys(['updated'], 3)).toEqual(expected.SearchKeys(['updated'], 3));
        expect(current.Session.Segments.get(0)!.Entries[0]).toMatchObject({ Role: ContextRole.Assistant, CreatedAt: first.CreatedAt });
        expect(old.SearchKeys(['updated'], 3)).toEqual([]);
      } finally { current.dispose(); expected.dispose(); }
    } finally { old.dispose(); oldLocal.dispose(); }
  } finally { remote.dispose(); local.dispose(); }
});

it('matches inline append accounting across tail reuse, partition rollover, and an atomic identity failure', async () => {
  const options = { ...WriteOptimized, PartitionedIndex: { ...WriteOptimized.PartitionedIndex!, MaximumWorkingSetEntries: 1 } };
  const local = initialize(options, true);
  const remote = initialize(options, true);
  try {
    const draft = (key: string, EntryId = testGuid(key)) => ({
      EntryId, Role: ContextRole.User, CreatedAt: '2026-01-03T00:00:00Z', Content: new TextContent(key), IndexKeys: [key],
    });
    const append = (ExpectedRevision: number, ...Entries: ReturnType<typeof draft>[]) => ({
      SessionId, ExpectedRevision, Changes: [{ kind: 'AppendEntries' as const, Entries }],
    });
    for (const [command, status] of [
      [append(0, draft('discarded'), draft('duplicate old', EntryId)), ContextMutationStatus.InvalidOperation],
      [append(0, draft('tail'), draft('rollover'), draft('second rollover')), ContextMutationStatus.Applied],
      [append(1, draft('duplicate new'), draft('duplicate new')), ContextMutationStatus.InvalidOperation],
    ] as const) {
      const pending = remote.applySessionFromWorker(command);
      expect(BigInt(remote.getStatistics().EstimatedPreparationBytes)).toBeGreaterThan(0n);
      const expected = local.applySession(command);
      expect(expected.Status).toBe(status);
      expect(await pending).toEqual(expected);
      expect(remote.getStatistics()).toEqual(local.getStatistics());
    }
    const actual = remote.openRead(SessionId);
    const expected = local.openRead(SessionId);
    try {
      expect(actual.ReadRange(0, 7)).toEqual(expected.ReadRange(0, 7));
      expect([...actual.Session.Segments.values()].map(({ Entries }) => Entries.length)).toEqual([2, 2, 1, 1]);
      expect(actual.SearchKeys(['rollover'], 1)).toMatchObject([{ EntryId: testGuid('rollover') }]);
      expect(actual.SearchKeys(['discarded'], 1)).toEqual([]);
    } finally { actual.dispose(); expected.dispose(); }
    const generated = await remote.applySessionFromWorker(append(1, draft('generated', '')));
    expect(generated).toMatchObject({ Status: ContextMutationStatus.Applied, Revision: 2 });
    expect(generated.AppendedEntryIds).toHaveLength(1);
    const current = remote.openRead(SessionId);
    try { expect(current.SearchKeys(['generated'], 1)).toMatchObject([{ EntryId: generated.AppendedEntryIds[0] }]); }
    finally { current.dispose(); }
  } finally { remote.dispose(); local.dispose(); }
});

it('preserves ordered mixed edits, rollback after deletion, and retained roots', async () => {
  const local = initialize(WriteOptimized, true);
  const remote = initialize(WriteOptimized, true);
  const old = remote.openRead(SessionId);
  const oldLocal = local.openRead(SessionId);
  try {
    const neighbor = old.Session.Segments.get(0)!.Entries[1];
    const verify = async (ExpectedRevision: number, Status: ContextMutationStatus, Changes: Parameters<typeof local.applySession>[0]['Changes']) => {
      const request = { SessionId, ExpectedRevision, Changes };
      const pending = remote.applySessionFromWorker(request);
      expect(BigInt(remote.getStatistics().EstimatedPreparationBytes)).toBeGreaterThan(0n);
      const expected = local.applySession(request);
      expect(expected.Status).toBe(Status);
      expect(await pending).toEqual(expected);
      expect(remote.getStatistics()).toEqual(local.getStatistics());
    };
    const deletion = { kind: 'DeleteEntry' as const, EntryId };
    const AnchorId = testGuid('mixed-anchor');
    const anchor = (key: string, EndEntryId = NeighborId) => ({
      kind: 'PutAnchor' as const, Anchor: { AnchorId, StartEntryId: NeighborId, EndEntryId, Title: key,
        Summary: '', Topics: [], Kind: AnchorKind.Manual, SourceRevision: 0, PinnedRevision: null, IndexKeys: [key] },
    });
    await verify(0, ContextMutationStatus.InvalidOperation, [deletion, replace('no resurrection')]);
    await verify(0, ContextMutationStatus.InvalidOperation, [{ ...deletion, EntryId: OtherSegmentId }, anchor('invalid', OtherSegmentId)]);
    await verify(0, ContextMutationStatus.Applied, [
      anchor('first anchor'), replace('intermediate', OtherSegmentId), deletion,
      { kind: 'ReplaceSegment', SegmentId: 0, Entries: [{ ...neighbor, Content: new TextContent('segment'), IndexKeys: ['segment'] }] },
      replace('final', NeighborId), { kind: 'DeleteEntry', EntryId: OtherSegmentId }, anchor('final anchor'),
    ]);
    const read = remote.openRead(SessionId);
    const expected = local.openRead(SessionId);
    try {
      expect(read.ReadRange(0, 3)).toEqual(expected.ReadRange(0, 3));
      expect(read.SearchKeys(['final'], 3)).toMatchObject([{ EntryId: NeighborId }]);
      for (const key of ['intermediate', 'segment', 'base']) expect(read.SearchKeys([key], 3)).toEqual([]);
      expect(read.Session.Anchors.get(AnchorId)).toEqual(expected.Session.Anchors.get(AnchorId));
      expect(read.Session.Anchors.get(AnchorId)?.Title).toBe('final anchor');
      expect(old.Session.Anchors.size).toBe(0);
      expect(old.SearchKeys(['base'], 3)).toHaveLength(3);
    } finally { read.dispose(); expected.dispose(); }
    expect(await remote.synchronizeIndexAsync(SessionId)).toEqual(await local.synchronizeIndexAsync(SessionId));
    expect(remote.getStatistics()).toEqual(local.getStatistics());
    await verify(1, ContextMutationStatus.Applied, [{ kind: 'RemoveAnchor', AnchorId }, { kind: 'SetSessionStatus', Status: SessionStatus.Expired }]);
    await verify(2, ContextMutationStatus.InvalidOperation, [{ kind: 'SetSessionStatus', Status: SessionStatus.Active }]);
  } finally { old.dispose(); oldLocal.dispose(); remote.dispose(); local.dispose(); }
});

it('resets a reused empty tail and preserves tombstones for entries appended and deleted in one transaction', async () => {
  const local = initialize(WriteOptimized, true);
  const remote = initialize(WriteOptimized, true);
  const NewId = testGuid('new tail');
  const TemporaryId = testGuid('temporary tail');
  const draft = (EntryId: string) => ({
    EntryId, Role: ContextRole.User, CreatedAt: '2026-01-03T00:00:00Z', Content: new TextContent('append'), IndexKeys: ['append'],
  });
  const reuse = { SessionId, ExpectedRevision: 0, Changes: [
    { kind: 'DeleteEntry' as const, EntryId: OtherSegmentId },
    { kind: 'AppendEntries' as const, Entries: [draft(NewId), draft(TemporaryId)] },
    replace('new final', NewId), { kind: 'DeleteEntry' as const, EntryId: TemporaryId },
  ] };
  try {
    const pending = remote.applySessionFromWorker(reuse);
    expect(BigInt(remote.getStatistics().EstimatedPreparationBytes)).toBeGreaterThan(0n);
    const expected = local.applySession(reuse);
    expect(expected).toMatchObject({ Status: ContextMutationStatus.Applied, AppendedEntryIds: [NewId, TemporaryId] });
    expect(await pending).toEqual(expected);
    expect(remote.getStatistics()).toEqual(local.getStatistics());
    const actualRead = remote.openRead(SessionId);
    const expectedRead = local.openRead(SessionId);
    try {
      expect(actualRead.ReadRange(0, 5)).toEqual(expectedRead.ReadRange(0, 5));
      expect(actualRead.SearchKeys(['base'], 5)).toHaveLength(2);
      expect(actualRead.SearchKeys(['append'], 5)).toEqual([]);
      expect(actualRead.SearchKeys(['new final'], 5)).toMatchObject([{ EntryId: NewId, Sequence: 3 }]);
    } finally { actualRead.dispose(); expectedRead.dispose(); }
    const revive = { SessionId, ExpectedRevision: 1, Changes: [{ kind: 'AppendEntries' as const, Entries: [draft(TemporaryId)] }] };
    expect(await remote.applySessionFromWorker(revive)).toMatchObject({ Status: ContextMutationStatus.InvalidOperation, Revision: 1 });
    expect(await remote.synchronizeIndexAsync(SessionId)).toEqual(await local.synchronizeIndexAsync(SessionId));
    expect(remote.getStatistics()).toEqual(local.getStatistics());
  } finally { remote.dispose(); local.dispose(); }
});

it('publishes the same replacement and accounting as local preparation, including validation failure', async () => {
  const local = initialize();
  const remote = initialize();
  try {
    const invalid = change(0, 'too large '.repeat(4000));
    const rejected = local.applySession(invalid);
    expect(rejected.Status).toBe(ContextMutationStatus.InvalidOperation);
    expect(await remote.applySessionFromWorker(invalid)).toEqual(rejected);
    expect(remote.getStatistics()).toEqual(local.getStatistics());

    for (const [revision, key] of ['first', 'second', 'second'].entries()) {
      const mutation = change(revision, key);
      expect(await remote.applySessionFromWorker(mutation)).toEqual(local.applySession(mutation));
      expect(remote.getStatistics()).toEqual(local.getStatistics());
      const remoteRead = remote.openRead(SessionId);
      const localRead = local.openRead(SessionId);
      try {
        expect(remoteRead.ReadRange(0, 1)).toEqual(localRead.ReadRange(0, 1));
        expect(remoteRead.SearchKeys([key], 2)).toEqual(localRead.SearchKeys([key], 2));
        expect(remoteRead.SearchKeys(['base'], 2)).toEqual([]);
      } finally { remoteRead.dispose(); localRead.dispose(); }
    }
  } finally { remote.dispose(); local.dispose(); }
});

it('disposes in-flight preparation without publishing or invalidating an older capture', async () => {
  const owner = initialize();
  const read = owner.openRead(SessionId);
  try {
    const pending = owner.applySessionFromWorker(change(0, 'unpublished'));
    expect(BigInt(owner.getStatistics().EstimatedPreparationBytes)).toBeGreaterThan(0n);
    const terminal = expect(pending).rejects.toMatchObject({ code: 'Disposed' });
    owner.dispose();
    await terminal;
    expect(read.Session.Revision).toBe(0);
    expect(read.SearchKeys(['base'], 1)).toHaveLength(1);
    expect(read.SearchKeys(['unpublished'], 1)).toEqual([]);
  } finally { read.dispose(); owner.dispose(); }
});
