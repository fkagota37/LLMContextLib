// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { LLMContextFactory } from '../../src/factory.js';
import { ContextError } from '../../src/domain/errors.js';
import { ContextIndexingMode } from '../../src/domain/index-keys.js';
import { ContextRole, MemoryStatus, SessionStatus, TextContent, type ContextMemory, type LLMSessionContext } from '../../src/domain/session.js';
import { defaultLLMContextOptions, WriteOptimized, type LLMContextOptions } from '../../src/options.js';
import { ApplicableMemory } from '../../src/policies/context.js';
import { defaultPartitionedContextIndexOptions } from '../../src/storage/partitioned-index.js';

const id = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const SessionId = id(1), UserId = id(2), EntryId = id(3);
const session = (): LLMSessionContext => ({
  SessionId, UserId, RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
  Segments: new Map(), Anchors: new Map(),
});
class CallbackFailure extends Error {}

function category(error: unknown): string {
  if (error instanceof ContextError) return error.code;
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled';
  if (error instanceof RangeError) return /overflow/i.test(error.message) ? 'Overflow' : 'Range';
  if (error instanceof TypeError) return 'Argument';
  if (error instanceof CallbackFailure) return 'Callback';
  throw error;
}

export async function supportedContracts() {
  const rows: object[] = [];
  const check = (label: string, action: () => unknown) => {
    let outcome = 'ok';
    try { action(); } catch (error) { outcome = category(error); }
    rows.push({ label, outcome });
  };
  const asyncCheck = async (label: string, action: () => Promise<unknown>) => {
    let outcome = 'ok';
    try { await action(); } catch (error) { outcome = category(error); }
    rows.push({ label, outcome });
  };
  for (const field of ['MaximumEntriesPerSegment', 'MaximumEstimatedBytesPerSegment', 'EstimatedResidentByteBudget',
    'MaximumEstimatedRetainedBytes', 'MaximumRetainedReads', 'MaximumViewResults']) {
    for (const value of [-1, 0, 1, 2147483647]) {
      check(`options/${field}/${value}`, () => LLMContextFactory.Create({ [field]: value }).Initialize([]).dispose());
    }
  }
  for (const value of [-1, 0, .0001, 2147483647, 2147483648]) {
    check(`options/timeout/${value}`, () => LLMContextFactory.Create({ AdmissionTimeoutMs: value }).Initialize([]).dispose());
  }
  for (const field of ['TimeProvider', 'EntrySizeEstimator', 'ProjectionSizeEstimator']) {
    check(`options/null/${field}`, () => LLMContextFactory.Create({ [field]: null }));
  }
  check('options/unknown-mode', () => LLMContextFactory.Create({ IndexingMode: 'Unknown' as ContextIndexingMode }));
  check('options/producer-deferred', () => LLMContextFactory.Create({
    IndexingMode: ContextIndexingMode.ProducerOwned, DeferredIndexing: {} as LLMContextOptions['DeferredIndexing'],
  }));
  check('options/text-partitions', () => LLMContextFactory.Create({ PartitionedIndex: defaultPartitionedContextIndexOptions }));
  check('options/partition-headroom', () => LLMContextFactory.Create({ ...WriteOptimized, EstimatedResidentByteBudget: 1 }));

  const token = new (class ProjectionValue {})();
  let estimatorCalls = 0;
  let estimate: number | bigint = 37;
  const configured: LLMContextOptions = {
    ...defaultLLMContextOptions, MaximumViewResults: 2,
    ProjectionSizeEstimator(item) {
      assert.equal(item, token, 'Estimator must see the materialized object, not a clone.');
      estimatorCalls++;
      if (estimate === -2) throw new CallbackFailure('configured estimator failed');
      return estimate;
    },
  };
  const copied = { ...configured, MaximumRetainedReads: 1 };
  rows.push({ label: 'options/copy', originalReads: configured.MaximumRetainedReads, copiedReads: copied.MaximumRetainedReads,
    sameCallback: configured.ProjectionSizeEstimator === copied.ProjectionSizeEstimator,
    sameClock: configured.TimeProvider === copied.TimeProvider, defaultsUnchanged: defaultLLMContextOptions.MaximumViewResults === 4096 });
  const builder = LLMContextFactory.Create(copied);
  const owner = builder.Initialize([session()]);
  const independent = builder.Initialize([session()]);
  const recovery = (label: string) => {
    const stats = owner.GetStatistics();
    rows.push({ label, reads: stats.RetainedReads, retained: String(stats.EstimatedRetainedBytes),
      view: String(stats.EstimatedViewBytes), revision: owner.TryFind(SessionId)?.Revision ?? -1 });
  };
  try {
    rows.push({ label: 'options/reusable-builder', first: owner.GetStatistics().Sessions, second: independent.GetStatistics().Sessions });
    for (const next of [37, 0, -1, -2, 9223372036854775807n]) {
      estimate = next;
      check(`projection/${next}`, () => {
        const view = owner.OpenView({ SessionId, MaximumResults: 1, Evaluate: () => [token] });
        try {
          rows.push({ label: `projection/live/${next}`, identity: view.at(0) === token,
            bytes: String(owner.GetStatistics().EstimatedViewBytes), reads: owner.GetStatistics().RetainedReads });
        } finally { view.dispose(); }
      });
      recovery(`projection/recovered/${next}`);
    }
    estimate = 37;
    check('projection/evaluation-failure', () => owner.OpenView({
      SessionId, MaximumResults: 1, Evaluate() { throw new CallbackFailure('evaluation failed'); },
    }));
    check('projection/zero-limit', () => owner.OpenView({ SessionId, MaximumResults: 0, *Evaluate() {
      yield token;
      throw new Error('Zero-limit projection was enumerated.');
    } }).dispose());
    check('projection/invalid-limit', () => owner.OpenView({ SessionId, MaximumResults: 3, Evaluate: () => [token] }).dispose());
    rows.push({ label: 'projection/callback-count', estimatorCalls });
    recovery('projection/final-recovery');
    const held = owner.OpenRead(SessionId);
    try { check('read/admission-rejected', () => owner.OpenRead(SessionId).dispose()); }
    finally { held.dispose(); }
    const read = owner.OpenRead(SessionId);
    try {
      check('read/range-negative', () => read.ReadRange(-1, 1));
      check('read/count-negative', () => read.ReadRange(0, -1));
      check('read/range-zero', () => read.ReadRange(0, 0));
      check('read/range-max', () => read.ReadRange(9223372036854775807n, 2147483647));
      check('read/page-zero', () => read.ReadPage(null, 0));
      check('read/page-wrong-session', () => read.ReadPage({ SessionId: id(9), Revision: 0, AfterSequence: 0 }, 1));
      check('read/page-wrong-revision', () => read.ReadPage({ SessionId, Revision: 1, AfterSequence: 0 }, 1));
      check('read/page-negative-cursor', () => read.ReadPage({ SessionId, Revision: 0, AfterSequence: -1 }, 1));
      check('read/page-max-cursor', () => read.ReadPage({ SessionId, Revision: 0, AfterSequence: 9223372036854775807n }, 1));
      check('read/search-negative', () => read.Search('word', -1));
      check('read/search-null', () => read.Search(null as unknown as string, 1));
      check('read/search-empty', () => read.Search('', 2147483647));
      check('read/keys-null', () => read.SearchKeys(null!, 1));
      check('read/anchor-missing', () => read.ResolveAnchor(id(9)));
    } finally { read.dispose(); }
    recovery('read/recovered');
    check('read/missing', () => owner.OpenRead(id(9)));
    check('initialize/duplicates', () => builder.Initialize([session(), session()]));
    check('initialize/selector', () => LLMContextFactory.Create(null, () => id(9)).Initialize([session()]));
    check('initialize/enumerator-failure', () => builder.Initialize((function* () {
      yield session();
      throw new CallbackFailure('enumerator failed');
    })()));
    await asyncCheck('wait/missing', () => owner.WaitForIndexingAsync(id(9), 0));
    await asyncCheck('wait/revision', () => owner.WaitForIndexingAsync(SessionId, 1));
    await asyncCheck('wait/complete', () => owner.WaitForIndexingAsync(SessionId, 0));
    await asyncCheck('synchronize/not-supported', () => owner.SynchronizeIndexAsync(SessionId));
    await asyncCheck('wait/cancelled', () => owner.WaitForIndexingAsync(SessionId, 0, AbortSignal.abort()));
    await asyncCheck('synchronize/cancelled', () => owner.SynchronizeIndexAsync(SessionId, AbortSignal.abort()));
    scopeTrace(rows);
    resourceTrace(rows);
    owner.dispose();
    check('owner/disposed', () => owner.GetStatistics());
    await asyncCheck('wait/disposed', () => owner.WaitForIndexingAsync(SessionId, 0));
  } finally { owner.dispose(); independent.dispose(); }
  return { reference: '479d2612315cbd292da917bae6d8d3fec35fea24', rows };
}

function scopeTrace(rows: object[]) {
  const anchorId = id(4);
  const source: LLMSessionContext = {
    ...session(),
    Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [{
      EntryId, Sequence: 0, Role: ContextRole.User, CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('source'),
    }] }]]),
    Anchors: new Map([[anchorId, { AnchorId: anchorId, StartEntryId: EntryId, EndEntryId: EntryId, Title: 'source',
      Summary: '', Topics: [], Kind: 'Manual', SourceRevision: 0, PinnedRevision: null }]]) as LLMSessionContext['Anchors'],
  };
  const owner = LLMContextFactory.Create({ TimeProvider: { now: () => 0 } }).Initialize([source]);
  const scopes = [{ UserId }, { SessionId }, { UserId, SessionId }];
  const memories: ContextMemory[] = scopes.map((Scope, index) => ({
    MemoryId: id(10 + index), Scope, Content: `memory${index}`, Revision: 0, Status: MemoryStatus.Confirmed,
    ExpiresAt: null, Sources: [{ SessionId, AnchorId: anchorId }],
  }));
  const result = owner.ApplyMemory({ ExpectedRevision: 0, Upserts: memories, Deletes: [] });
  const captured = owner.OpenRead(SessionId);
  try {
    scopes.forEach((value, index) => {
      const scope = { ...value };
      rows.push({ label: `scope/${index}`, status: result.Status,
        policy: ApplicableMemory(memories, source, [scope], 0).map((x) => x.MemoryId),
        storage: captured.GetApplicableMemory([scope]).map((x) => x.MemoryId) });
    });
    owner.ApplyMemory({ ExpectedRevision: 1, Upserts: [], Deletes: [id(10)] });
    owner.RemoveSession(SessionId, 0);
    owner.dispose();
    rows.push({ label: 'scope/retained', revision: captured.MemoryRevision,
      memory: captured.GetApplicableMemory([{ UserId }]).map((x) => x.MemoryId) });
  } finally { captured.dispose(); owner.dispose(); }
}

function resourceTrace(rows: object[]) {
  const budget = 8192;
  let outputBytes = 1n;
  const owner = LLMContextFactory.Create({
    EstimatedResidentByteBudget: budget, ProjectionSizeEstimator: () => outputBytes,
  }).Initialize([session()]);
  const old = owner.OpenRead(SessionId);
  try {
    const stats = owner.GetStatistics();
    outputBytes = BigInt(budget) - BigInt(stats.EstimatedActiveBytes) - BigInt(stats.EstimatedRetainedBytes);
    const view = owner.OpenView({ SessionId, MaximumResults: 1, Evaluate: () => [{}] });
    const other = { ...session(), SessionId: id(20) };
    const changes = { SessionId, ExpectedRevision: 0, Changes: [{ kind: 'AppendEntries' as const, Entries: [{
      EntryId, Role: ContextRole.User, CreatedAt: '1970-01-01T00:00:00Z', Content: new TextContent('admitted'),
    }] }] };
    const memory = { ExpectedRevision: 0, Upserts: [{
      MemoryId: id(21), Scope: { UserId }, Content: 'proposed', Revision: 0, Status: MemoryStatus.Proposed,
      ExpiresAt: null, Sources: [],
    }], Deletes: [] };
    try {
      rows.push({ label: 'resource/rejected', create: owner.CreateSession(other).Status,
        session: owner.Apply(changes).Status, memory: owner.ApplyMemory(memory).Status,
        revision: owner.TryFind(SessionId)?.Revision ?? -1, memoryRevision: owner.GetStatistics().MemoryRevision,
        oldRevision: old.Session.Revision, view: String(owner.GetStatistics().EstimatedViewBytes) });
    } finally { view.dispose(); }
    rows.push({ label: 'resource/admitted', create: owner.CreateSession(other).Status,
      session: owner.Apply(changes).Status, memory: owner.ApplyMemory(memory).Status,
      revision: owner.TryFind(SessionId)?.Revision ?? -1, memoryRevision: owner.GetStatistics().MemoryRevision,
      oldRevision: old.Session.Revision, oldMemoryRevision: old.MemoryRevision, oldEntries: old.ReadRange(0, 8).length });
    old.dispose();
    const released = owner.GetStatistics();
    rows.push({ label: 'resource/released', reads: released.RetainedReads, retained: String(released.EstimatedRetainedBytes),
      view: String(released.EstimatedViewBytes), revision: owner.TryFind(SessionId)?.Revision ?? -1 });
    const current = owner.OpenRead(SessionId);
    try {
      rows.push({ label: 'resource/current', revision: current.Session.Revision, memoryRevision: current.MemoryRevision,
        entries: current.ReadRange(0, 8).map((x) => x.EntryId) });
    } finally { current.dispose(); }
  } finally { old.dispose(); owner.dispose(); }
}
