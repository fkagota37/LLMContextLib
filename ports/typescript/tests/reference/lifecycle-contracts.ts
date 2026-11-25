// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { WithBitFasterTermMemoization } from '../../adapters/bitfaster/index.js';
import { LuceneTermCollection, WithLuceneTermCollection } from '../../adapters/lucene/index.js';
import { configureExecutionProviders, LLMContextFactory } from '../../src/factory.js';
import { ContextExecutionRecipe } from '../../src/execution/strategy.js';
import { ContextRole, SessionStatus, TextContent, type LLMSessionContext } from '../../src/domain/session.js';
import { defaultDeferredIndexingOptions, defaultLLMContextOptions, WriteOptimized } from '../../src/options.js';
import { LLMContextOwner } from '../../src/storage/owner.js';
import { stopped } from '../../src/runtime/index-maintenance-worker.js';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const SessionId = id(1), EntryId = id(3);
const session = (keys: boolean): LLMSessionContext => ({
  SessionId, UserId: id(2), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
  Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [{
    EntryId, Sequence: 0, Role: ContextRole.User, CreatedAt: '1970-01-01T00:00:00Z',
    Content: new TextContent('base suffix'), ...(keys ? { IndexKeys: ['base'] } : {}),
  }] }]]), Anchors: new Map(),
});

export async function lifecycleContracts() {
  const rows: object[] = [];
  for (const fail of [false, true]) {
    let inject = fail;
    const owner = new LLMContextOwner(WriteOptimized, undefined, undefined, () => {
      if (inject) throw new Error('injected synchronization failure');
    });
    owner.initialize([session(true)]);
    try {
      const mutation = owner.applySession({ SessionId, ExpectedRevision: 0, Changes: [
        { kind: 'ReplaceEntry', EntryId, Content: new TextContent('working'), IndexKeys: ['working'] },
      ] });
      const old = owner.openRead(SessionId);
      try {
        const cancel = new AbortController();
        const waiting = owner.synchronizeIndexAsync(SessionId, cancel.signal);
        const durable = owner.synchronizeIndexAsync(SessionId);
        cancel.abort();
        let cancelled = 'ok';
        try { await waiting; } catch (error) {
          assert(error instanceof DOMException && error.name === 'AbortError');
          cancelled = 'Cancelled';
        }
        const blocked = owner.applySession({ SessionId, ExpectedRevision: 1,
          Changes: [{ kind: 'SetSessionStatus', Status: SessionStatus.Active }] });
        const completed = await durable;
        rows.push({ label: `synchronization/${fail ? 'True' : 'False'}`, applied: mutation.Status, cancelled,
          blocked: blocked.Status, Generation: completed.Generation, ContentRevision: completed.ContentRevision,
          PartitionsCompacted: completed.PartitionsCompacted, Succeeded: completed.Succeeded, hasError: completed.Error !== null,
          oldGeneration: old.IndexStatus.IndexGeneration, oldHits: old.SearchKeys(['working'], 1).map((x) => x.EntryId),
          pending: owner.getStatistics().PendingSynchronizations,
          preparation: String(owner.getStatistics().EstimatedPreparationBytes) });
        inject = false;
        const followOn = owner.applySession({ SessionId, ExpectedRevision: 1,
          Changes: [{ kind: 'SetSessionStatus', Status: SessionStatus.Active }] });
        const recovered = await owner.synchronizeIndexAsync(SessionId);
        const current = owner.openRead(SessionId);
        try {
          rows.push({ label: `synchronization/recovery/${fail ? 'True' : 'False'}`, status: followOn.Status,
            Generation: recovered.Generation, ContentRevision: recovered.ContentRevision,
            PartitionsCompacted: recovered.PartitionsCompacted, Succeeded: recovered.Succeeded,
            revision: current.Session.Revision, indexGeneration: current.IndexStatus.IndexGeneration,
            hits: current.SearchKeys(['working'], 1).map((x) => x.EntryId), pending: owner.getStatistics().PendingSynchronizations });
        } finally { current.dispose(); }
      } finally { old.dispose(); }
    } finally { owner.dispose(); }
  }
  for (const provider of ['Native', 'LuceneRangeBuffer', 'LuceneCharTerm']) {
    for (const memo of [false, true]) {
      let builder = LLMContextFactory.Create({
        DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundWords: 1 },
      }).WithExecutionStrategies();
      if (provider !== 'Native') builder = WithLuceneTermCollection(builder,
        provider === 'LuceneRangeBuffer' ? LuceneTermCollection.RangeBuffer : LuceneTermCollection.CharTerm);
      if (memo) builder = WithBitFasterTermMemoization(builder);
      const owner = builder.Initialize([session(false)]);
      try {
        await owner.WaitForIndexingAsync(SessionId, 0);
        const old = owner.OpenRead(SessionId);
        try {
          const replace = owner.Apply({ SessionId, ExpectedRevision: 0,
            Changes: [{ kind: 'ReplaceEntry', EntryId, Content: new TextContent('changed suffix') }] });
          await owner.WaitForIndexingAsync(SessionId, 1);
          const current = owner.OpenRead(SessionId);
          try {
            const stats = owner.GetStatistics();
            owner.RemoveSession(SessionId, 1);
            owner.dispose();
            rows.push({ label: `shutdown/${provider}/${memo ? 'True' : 'False'}`, status: replace.Status,
              oldRevision: old.Session.Revision, currentRevision: current.Session.Revision,
              oldHits: old.Search('base', 1).map((x) => x.EntryId),
              currentHits: current.SearchIndexed('changed', 1).Hits.map((x) => x.EntryId),
              PendingIndexWork: stats.PendingIndexWork, work: String(stats.EstimatedIndexWorkBytes),
              collector: stats.Execution!.TermCollector, termMemo: stats.Execution!.TermMemo, memoEntries: stats.Execution!.MemoEntries });
          } finally { current.dispose(); }
        } finally { old.dispose(); }
      } finally { owner.dispose(); }
    }
  }
  for (const provider of ['Native', 'LuceneRangeBuffer', 'LuceneCharTerm']) {
    let recipe: ContextExecutionRecipe | undefined;
    let maintenanceStop: Int32Array | undefined;
    let stoppedBeforeReturn = false;
    let builder = WithBitFasterTermMemoization(LLMContextFactory.Create()).WithExecutionStrategies();
    if (provider !== 'Native') builder = WithLuceneTermCollection(builder,
      provider === 'LuceneRangeBuffer' ? LuceneTermCollection.RangeBuffer : LuceneTermCollection.CharTerm);
    builder[configureExecutionProviders]((value) => {
      recipe = new ContextExecutionRecipe(value.Collector, value.HasCustomCollector, () => {
        const memo = value.Memo!();
        return {
          Name: memo.Name, MaximumTextCharacters: memo.MaximumTextCharacters,
          get Count() { return memo.Count; },
          TryGet: (text) => memo.TryGet(text), TryAdd: (text, terms) => memo.TryAdd(text, terms),
          dispose() {
            assert(maintenanceStop, 'Supported deferred work must have started.');
            assert.equal(Atomics.load(maintenanceStop, 0), stopped, 'Worker must quiesce before memo teardown.');
            stoppedBeforeReturn = true;
            memo.dispose();
            assert.equal(memo.Count, 0);
          },
        };
      }, value.MemoReservation);
      return value;
    });
    const owner = new LLMContextOwner({
      ...defaultLLMContextOptions, DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundWords: 1 },
    }, undefined, recipe);
    owner.initialize([session(false)]);
    const old = owner.openRead(SessionId);
    try {
      const waiting = owner.waitForIndexingAsync(SessionId, 0).then(() => 'ok', (error: unknown) => {
        assert(error instanceof Error && 'code' in error && error.code === 'Disposed');
        return 'Disposed';
      });
      // Observe only the internal lifecycle signal; no custom collector changes provider behavior.
      await setImmediate();
      const thread = (owner as unknown as { nativeIndexThread?: { stop: Int32Array } }).nativeIndexThread;
      assert(thread);
      maintenanceStop = thread.stop;
      owner.dispose();
      rows.push({ label: `shutdown/pending/${provider}`, outcome: await waiting, stoppedBeforeReturn,
        revision: old.Session.Revision, complete: old.IndexStatus.IsComplete,
        exact: old.Search('suffix', 1).map((x) => x.EntryId),
        indexed: old.SearchIndexed('suffix', 1).Hits.map((x) => x.EntryId) });
    } finally { old.dispose(); owner.dispose(); }
  }
  return { reference: '479d2612315cbd292da917bae6d8d3fec35fea24', rows };
}
