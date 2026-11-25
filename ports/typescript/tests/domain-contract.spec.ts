// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { testGuid } from './test-guid.js';
import { describe, expect, it } from 'vitest';
import { ContextIndexingMode, ContextIndexKeys } from '../src/domain/index-keys.js';
import { AnchorKind, ContextMutationStatus, ContextRole, MemoryStatus, SessionStatus, TextContent } from '../src/domain/session.js';
import { defaultDeferredIndexingOptions, defaultLLMContextOptions, LLMContextOptions, validateLLMContextOptions, WriteOptimized } from '../src/options.js';
import { configureExecutionProviders, LLMContextFactory } from '../src/factory.js';
import { NativeTermCollector } from '../src/execution/collectors.js';
import { DeferredIndexLifecycle, DeferredIndexLifecycleStatus } from '../src/storage/indexing.js';
import { defaultPartitionedContextIndexOptions, PartitionCapacityException, PartitionedContextIndex, ContextSynchronizationWriteBehavior } from '../src/storage/partitioned-index.js';
import { ContextExecutionRecipe, ContextIndexingStrategy, ContextPreparationStrategy } from '../src/execution/strategy.js';
import { Terms } from '../src/policies/context.js';
import { LuceneTermCollection, WithLuceneTermCollection } from '../adapters/lucene/index.js';
import { WithBitFasterTermMemoization } from '../adapters/bitfaster/index.js';
import { validateRuntimeCompatibility } from '../src/runtime/compatibility.js';
import { IndexStore } from '../src/storage/index-store.js';
import { LLMContextOwner } from '../src/storage/owner.js';

describe('TypeScript domain contracts', () => {
  it('distinguishes operational failure categories without changing mutation statuses', async () => {
    const owner = LLMContextFactory.Create().Initialize([{
      SessionId: testGuid('live'), UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map(), Anchors: new Map(),
    }]);
    const category = (code: string) => expect.objectContaining({ name: 'ContextError', code });
    const read = owner.OpenRead(testGuid('live'));
    try {
      expect(() => owner.OpenRead(testGuid('missing'))).toThrow(category('NotFound'));
      expect(() => read.ResolveAnchor(testGuid('missing'))).toThrow(category('NotFound'));
      expect(() => read.ReadPage({ SessionId: testGuid('live'), Revision: 2, AfterSequence: 0 }, 1)).toThrow(TypeError);
      await expect(owner.WaitForIndexingAsync(testGuid('live'), 1)).rejects.toMatchObject({ code: 'InvalidOperation' });
      await expect(owner.SynchronizeIndexAsync(testGuid('live'))).rejects.toMatchObject({ code: 'NotSupported' });
      expect(owner.RemoveSession(testGuid('missing'), 0).Status).toBe(ContextMutationStatus.NotFound);
    } finally {
      read.dispose();
      owner.dispose();
    }
    expect(() => read.ReadRange(0, 1)).toThrow(category('Disposed'));
    expect(() => owner.GetStatistics()).toThrow(category('Disposed'));
  });

  it('preserves exact integers and UTF-16-sensitive text behavior', () => {
    const exact = 9007199254740991n;
    const text = 'A😀B';
    expect(exact).toBe(9007199254740991n);
    expect(text.length).toBe(4);
    expect('apple' < 'banana').toBe(true);
    expect('banana' > 'apple').toBe(true);
  });

  it('creates a producer-owned and text-mode factory without dropping public contract defaults', () => {
    const textFactory = LLMContextFactory.Create();
    const producerFactory = textFactory.WithProducerOwnedIndexing();

    expect(defaultLLMContextOptions.IndexingMode).toBe(ContextIndexingMode.Text);
    expect(LLMContextOptions.Default.IndexingMode).toBe(ContextIndexingMode.Text);
    expect(LLMContextOptions.WriteOptimized.IndexingMode).toBe(ContextIndexingMode.ProducerOwned);
    expect(producerFactory).toBeDefined();
    expect(ContextMutationStatus.Applied).toBe('Applied');
    expect(ContextRole.User).toBe('User');
    expect(SessionStatus.Active).toBe('Active');
  });

  it('deduplicates and orders index keys in ordinal order', () => {
    const keys = new ContextIndexKeys(['zeta', 'alpha', 'alpha', 'beta']);
    expect(keys.Keys).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('enforces revision guards and read leases over captured session roots', () => {
    const factory = LLMContextFactory.Create();
    const session = {
      SessionId: testGuid('session-1'),
      UserId: testGuid('user-1'),
      RepositoryId: testGuid('repo-1'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [] }]]),
      Anchors: new Map(),
    };

    const array = factory.Initialize([session]);
    const found = array.TryFind(testGuid('session-1'));
    expect(found).toMatchObject({ SessionId: testGuid('session-1'), Revision: 0 });

    const conflict = array.Apply({
      SessionId: testGuid('session-1'),
      ExpectedRevision: 17,
      Changes: [],
    });
    expect(conflict.Status).toBe(ContextMutationStatus.RevisionConflict);

    const lease = array.OpenRead(testGuid('session-1'));
    expect(lease.ReadRange(0, 10)).toEqual([]);
    expect(lease.TryFindEntry(testGuid('missing-entry'))).toBeNull();

    const appended = array.Apply({
      SessionId: testGuid('session-1'),
      ExpectedRevision: 0,
      Changes: [{
        kind: 'AppendEntries',
        Entries: [{
          EntryId: testGuid('entry-1'),
          Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z',
          Content: new TextContent('hello from the port'),
        }],
      }],
    });
    expect(appended.Status).toBe(ContextMutationStatus.Applied);
    expect(array.OpenRead(testGuid('session-1')).ReadRange(0, 10)).toHaveLength(1);
  });

  it('preserves session metadata on creation and applies ordered mutation changes', () => {
    const owner = new LLMContextOwner();
    owner.initialize([]);

    const created = owner.createSession({
      SessionId: testGuid('mutation-session'),
      UserId: testGuid('user-2'),
      RepositoryId: testGuid('repo-2'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map(),
      Anchors: new Map(),
    });
    expect(created.Status).toBe(ContextMutationStatus.Applied);
    expect(owner.tryFindSession(testGuid('mutation-session'))?.UserId).toBe(testGuid('user-2'));
    expect(owner.tryFindSession(testGuid('mutation-session'))?.RepositoryId).toBe(testGuid('repo-2'));

    const appended = owner.applySession({
      SessionId: testGuid('mutation-session'),
      ExpectedRevision: 0,
      Changes: [{
        kind: 'AppendEntries',
        Entries: [{
          EntryId: testGuid('entry-1'),
          Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z',
          Content: new TextContent('first'),
        }],
      }, {
        kind: 'PutAnchor',
        Anchor: {
          AnchorId: testGuid('anchor-1'),
          StartEntryId: testGuid('entry-1'),
          EndEntryId: testGuid('entry-1'),
          Title: 'first anchor',
          Summary: 'anchor summary',
          Topics: ['alpha'],
          Kind: 'Manual' as any,
          SourceRevision: 0,
          PinnedRevision: null,
        },
      }, {
        kind: 'ReplaceEntry',
        EntryId: testGuid('entry-1'),
        Content: new TextContent('updated'),
      }, {
        kind: 'SetSessionStatus',
        Status: SessionStatus.Suspended,
      }],
    });
    expect(appended.Status).toBe(ContextMutationStatus.Applied);
    expect(owner.tryFindSession(testGuid('mutation-session'))?.Status).toBe(SessionStatus.Suspended);
    expect(owner.tryFindSession(testGuid('mutation-session'))?.Segments.get(0)?.Entries[0].Content).toBeInstanceOf(TextContent);

    const removed = owner.applySession({
      SessionId: testGuid('mutation-session'),
      ExpectedRevision: 1,
      Changes: [{
        kind: 'SetSessionStatus',
        Status: SessionStatus.Active,
      }, {
        kind: 'DeleteEntry',
        EntryId: testGuid('entry-1'),
      }, {
        kind: 'RemoveAnchor',
        AnchorId: testGuid('anchor-1'),
      }],
    });
    expect(removed.Status).toBe(ContextMutationStatus.Applied);
    expect(owner.tryFindSession(testGuid('mutation-session'))?.Segments.get(0)?.Entries).toEqual([]);
    expect(owner.tryFindSession(testGuid('mutation-session'))?.Anchors.has(testGuid('anchor-1'))).toBe(false);
  });

  it('assigns monotonically increasing sequences across segments and page boundaries', () => {
    const owner = new LLMContextOwner();
    owner.initialize([{
      SessionId: testGuid('sequence-session'),
      UserId: testGuid('user-1'),
      RepositoryId: testGuid('repo-1'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [{
        EntryId: testGuid('entry-1'),
        Sequence: 1,
        Role: ContextRole.User,
        CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('initial'),
      }] }]]),
      Anchors: new Map(),
    }]);

    const published = owner.applySession({
      SessionId: testGuid('sequence-session'),
      ExpectedRevision: 0,
      Changes: [{
        kind: 'AppendEntries',
        Entries: [{
          EntryId: testGuid('entry-2'),
          Role: ContextRole.Assistant,
          CreatedAt: '2026-01-01T00:00:01Z',
          Content: new TextContent('second'),
        }, {
          EntryId: testGuid('entry-3'),
          Role: ContextRole.Assistant,
          CreatedAt: '2026-01-01T00:00:02Z',
          Content: new TextContent('third'),
        }],
      }],
    });

    expect(published.Status).toBe(ContextMutationStatus.Applied);
    const lease = owner.openRead(testGuid('sequence-session'));
    expect(lease.ReadRange(0, 10).map((entry) => entry.Sequence)).toEqual([1, 2, 3]);
    expect(lease.ReadPage(null, 2)).toMatchObject({ Entries: [{ Sequence: 1 }, { Sequence: 2 }], Next: { AfterSequence: 2 } });
  });

  it('publishes ordered session edits atomically and never reuses admitted identities', () => {
      const root = LLMContextFactory.Create({ MaximumEntriesPerSegment: 1 }).Initialize([]);
      const session = {
        SessionId: testGuid('identities'), UserId: testGuid('user'), RepositoryId: null, Revision: 5,
        Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
      };
      expect(root.CreateSession(session)).toMatchObject({ Status: ContextMutationStatus.Applied, Revision: 5 });
      const draft = { EntryId: testGuid('first'), Role: ContextRole.User, CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('first') };
      const apply = (revision: number, ...changes: Parameters<typeof root.Apply>[0]['Changes']) =>
        root.Apply({ SessionId: session.SessionId, ExpectedRevision: revision, Changes: changes });
      const append = { kind: 'AppendEntries' as const, Entries: [draft, { ...draft, EntryId: testGuid('second') }] };
      expect(apply(5, append, { kind: 'DeleteEntry', EntryId: testGuid('missing') })).toMatchObject({
        Status: ContextMutationStatus.InvalidOperation, Revision: 5,
      });
      expect(root.TryFind(session.SessionId)?.Segments.size).toBe(0);
      expect(apply(5, append).AppendedEntryIds).toEqual([testGuid('first'), testGuid('second')]);
      expect([...root.TryFind(session.SessionId)!.Segments.values()].map((segment) => segment.Entries[0].Sequence)).toEqual([0, 1]);
      expect(apply(6, { kind: 'DeleteEntry', EntryId: testGuid('second') }).Status).toBe(ContextMutationStatus.Applied);
      expect(apply(7, { kind: 'AppendEntries', Entries: [{ ...draft, EntryId: testGuid('second') }] }).Status)
        .toBe(ContextMutationStatus.InvalidOperation);
      expect(apply(7, { kind: 'AppendEntries', Entries: [{ ...draft, EntryId: testGuid('third') }] }).Status)
        .toBe(ContextMutationStatus.Applied);
      expect(root.TryFind(session.SessionId)?.Segments.get(1)?.Entries[0].Sequence).toBe(2);
      expect(root.RemoveSession(session.SessionId, 8).Status).toBe(ContextMutationStatus.Applied);
      expect(root.CreateSession(session).Status).toBe(ContextMutationStatus.InvalidOperation);
      root.dispose();
    });

    it('requires explicit complete keys on imports and replacements without changing the prior snapshot', () => {
      const content = new TextContent('source');
      const keys = ['opaque'];
      const entry = {
        EntryId: testGuid('entry'), Sequence: 0, Role: ContextRole.User, CreatedAt: '2026-01-01T00:00:00Z',
        Content: content, IndexKeys: keys,
      };
      const session = {
        SessionId: testGuid('keys'), UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
        Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [entry] }]]), Anchors: new Map(),
      };
      expect(() => LLMContextFactory.Create().Initialize([session])).toThrow(/Text does not accept supplied keys/);
      const owner = LLMContextFactory.Create().WithProducerOwnedIndexing().Initialize([session]);
      keys[0] = 'mutated';
      session.Segments.clear();
      const read = owner.OpenRead(testGuid('keys'));
      expect(read.SearchKeys(['opaque'], 1)).toHaveLength(1);
      expect(owner.Apply({
        SessionId: testGuid('keys'), ExpectedRevision: 0,
        Changes: [{ kind: 'ReplaceEntry', EntryId: testGuid('entry'), Content: new TextContent('replacement') }],
      }).Status).toBe(ContextMutationStatus.InvalidOperation);
      expect(owner.Apply({
        SessionId: testGuid('keys'), ExpectedRevision: 0,
        Changes: [{ kind: 'ReplaceEntry', EntryId: testGuid('entry'), Content: new TextContent('replacement'), IndexKeys: [] }],
      }).Status).toBe(ContextMutationStatus.Applied);
      expect(read.SearchKeys(['opaque'], 1)).toHaveLength(1);
      expect(owner.WithCurrent(testGuid('keys'), (current) => current.SearchKeys(['opaque'], 1))).toEqual([]);
      read.dispose();
      owner.dispose();
    });

    it('publishes and pages exact revisions and sequences above the JavaScript safe-integer limit', () => {
      const high = 9007199254740991n;
      const maximum = (1n << 63n) - 1n;
      const draft = { EntryId: testGuid('entry'), Role: ContextRole.User, Content: new TextContent('match'), CreatedAt: '2026-01-01T00:00:00Z' };
      const session = {
        SessionId: testGuid('exact'), UserId: testGuid('user'), RepositoryId: null, Revision: high, Status: SessionStatus.Active,
        Segments: new Map([[high, {
          SegmentId: high, Revision: high, Entries: [{ ...draft, Sequence: high }],
        }]]),
        Anchors: new Map(),
      };
      const client = LLMContextFactory.Create({ MaximumEntriesPerSegment: 1 }).Initialize([session]);
      const originalSegments = client.TryFind(testGuid('exact'))!.Segments;
      expect(client.Apply({
        SessionId: testGuid('exact'), ExpectedRevision: high,
        Changes: [{ kind: 'AppendEntries', Entries: [{ ...draft, EntryId: testGuid('new') }] }],
      })).toMatchObject({ Status: ContextMutationStatus.Applied, Revision: high + 1n });
      expect(client.TryFind(testGuid('exact'))?.Segments.get(high + 1n)?.Entries[0].Sequence).toBe(high + 1n);
      client.WithCurrent(testGuid('exact'), (lease) => {
        expect([...lease.Session.Segments.keys()]).toEqual([Number(high), high + 1n]);
        expect([...originalSegments.keys()]).toEqual([Number(high)]);
        expect(lease.Session.Segments.get(high)).toBe(originalSegments.get(Number(high)));
        const first = lease.ReadPage(null, 1);
        expect(first.Next).toMatchObject({ AfterSequence: Number(high), Revision: high + 1n });
        expect(lease.ReadPage(first.Next, 1).Entries[0].Sequence).toBe(high + 1n);
        expect(lease.Search('match', 2).map((hit) => hit.EntryId)).toEqual([testGuid('entry'), testGuid('new')]);
      });
      expect(client.CreateSession({ ...session, SessionId: testGuid('overflow'), Revision: maximum }).Status).toBe(ContextMutationStatus.Applied);
      expect(client.Apply({
        SessionId: testGuid('overflow'), ExpectedRevision: maximum,
        Changes: [{ kind: 'SetSessionStatus', Status: SessionStatus.Closed }],
      })).toMatchObject({ Status: ContextMutationStatus.InvalidOperation, Revision: maximum });
      expect(client.TryFind(testGuid('overflow'))?.Status).toBe(SessionStatus.Active);
      client.dispose();
    });

  it('tracks live read leases and publication accounting in the owner boundary', () => {
    const owner = new LLMContextOwner();
    owner.initialize([{
      SessionId: testGuid('accounting-session'),
      UserId: testGuid('user-1'),
      RepositoryId: testGuid('repo-1'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [{
        EntryId: testGuid('entry-1'),
        Sequence: 1,
        Role: ContextRole.User,
        CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('alpha'),
      }] }]]),
      Anchors: new Map(),
    }]);

    const firstLease = owner.openRead(testGuid('accounting-session'));
    const firstRetention = owner.getStatistics().EstimatedRetainedBytes;
    const secondLease = owner.openRead(testGuid('accounting-session'));
    expect(owner.getStatistics().RetainedReads).toBe(2);
    expect(firstRetention).toBeGreaterThan(0);
    expect(owner.getStatistics().EstimatedRetainedBytes).toBe(firstRetention);

    firstLease.dispose();
    expect(owner.getStatistics().RetainedReads).toBe(1);

    const sessionMutation = owner.applySession({
      SessionId: testGuid('accounting-session'),
      ExpectedRevision: 0,
      Changes: [{ kind: 'AppendEntries', Entries: [{
        EntryId: testGuid('entry-2'),
        Role: ContextRole.Assistant,
        CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('beta'),
      }] }],
    });
    expect(sessionMutation.Status).toBe(ContextMutationStatus.Applied);
    expect(owner.getStatistics().PublishedMutations).toBe(2);

    const memoryMutation = owner.applyMemory({
      ExpectedRevision: 0,
      Upserts: [{
        MemoryId: testGuid('memory-1'),
        Scope: { UserId: testGuid('user-1') },
        Content: 'gamma',
        Revision: 0,
        Status: MemoryStatus.Proposed,
        ExpiresAt: null,
        Sources: [],
      }],
      Deletes: [],
    });
    expect(memoryMutation.Status).toBe(ContextMutationStatus.Applied);
    expect(owner.getStatistics().PublishedMutations).toBe(3);

    secondLease.dispose();
    expect(owner.getStatistics().RetainedReads).toBe(0);
  });

  it('requires an exact catalog revision and rolls back an invalid memory batch', () => {
    const factory = LLMContextFactory.Create();
    const root = factory.Initialize([]);
    const memory = root.ApplyMemory({
      ExpectedRevision: 0,
      Upserts: [{
        MemoryId: testGuid('memory-1'),
        Scope: { UserId: testGuid('user-1') },
        Content: 'alpha',
        Revision: 0,
        Status: MemoryStatus.Proposed,
        ExpiresAt: null,
        Sources: [],
      }],
      Deletes: [],
    });

    expect(memory.Status).toBe(ContextMutationStatus.Applied);
    expect(root.ApplyMemory({
      ExpectedRevision: 0,
      Upserts: [],
      Deletes: [testGuid('memory-missing')],
    }).Status).toBe(ContextMutationStatus.RevisionConflict);
    expect(root.ApplyMemory({
      ExpectedRevision: 1,
      Upserts: [],
      Deletes: [testGuid('memory-1'), testGuid('memory-missing')],
    }).Status).toBe(ContextMutationStatus.InvalidOperation);
    expect(root.ApplyMemory({
      ExpectedRevision: 1, Upserts: [], Deletes: [testGuid('memory-1')],
    })).toMatchObject({ Status: ContextMutationStatus.Applied, Revision: 2 });
  });

  it('captures memory and expiry time independently and requires resolvable confirmation evidence', () => {
    let now = '2026-01-01T00:00:00.0000001Z';
    const client = LLMContextFactory.Create({ TimeProvider: { now: () => now } }).Initialize([{
      SessionId: testGuid('session'), UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [{
        EntryId: testGuid('entry'), Sequence: 0, Role: ContextRole.User,
        CreatedAt: now, Content: new TextContent('evidence'),
      }] }]]),
      Anchors: new Map([[testGuid('anchor'), {
        AnchorId: testGuid('anchor'), StartEntryId: testGuid('entry'), EndEntryId: testGuid('entry'), Title: 'Evidence',
        Summary: '', Topics: [], Kind: AnchorKind.Manual, SourceRevision: 0, PinnedRevision: null,
      }]]),
    }]);
    const memory = {
      MemoryId: testGuid('memory'), Scope: { UserId: testGuid('user'), SessionId: testGuid('session') },
      Content: 'confirmed', Revision: 12, Status: MemoryStatus.Confirmed,
      ExpiresAt: '2026-01-01T01:00:00.0000002+01:00',
    };
    const before = client.OpenRead(testGuid('session'));
    expect(client.ApplyMemory({ ExpectedRevision: 0, Deletes: [], Upserts: [{
      ...memory, Sources: [{ SessionId: testGuid('session'), AnchorId: testGuid('missing') }],
    }] }).Status).toBe(ContextMutationStatus.InvalidOperation);
    expect(client.ApplyMemory({ ExpectedRevision: 0, Deletes: [], Upserts: [{
      ...memory, ExpiresAt: '2026-02-29T00:00:00Z', Sources: [{ SessionId: testGuid('session'), AnchorId: testGuid('anchor') }],
    }] }).Status).toBe(ContextMutationStatus.InvalidOperation);
    expect(client.ApplyMemory({ ExpectedRevision: 0, Deletes: [], Upserts: [{
      ...memory, Sources: [{ SessionId: testGuid('session'), AnchorId: testGuid('anchor') }],
    }] }).Status).toBe(ContextMutationStatus.Applied);
    const captured = client.OpenRead(testGuid('session'));
    const scopes = [{ SessionId: testGuid('session'), RepositoryId: null, UserId: testGuid('user') }];
    now = '2026-01-01T00:00:00.0000002Z';
    expect(before.GetApplicableMemory(scopes)).toEqual([]);
    expect(captured.GetApplicableMemory(scopes)).toMatchObject([{ MemoryId: testGuid('memory'), Revision: 1 }]);
    expect(client.WithCurrent(testGuid('session'), (read) => read.GetApplicableMemory(scopes))).toEqual([]);
    before.dispose();
    captured.dispose();
    client.dispose();
  });

  it('stores producer-owned keys and resolves them through the index boundary', () => {
    const store = new IndexStore();
    store.setEntry('entry-1', new ContextIndexKeys(['zeta', 'alpha', 'alpha']), ContextIndexingMode.ProducerOwned);
    store.setAnchor('anchor-1', new ContextIndexKeys(['alpha', 'beta']), ContextIndexingMode.ProducerOwned);

    expect(store.searchKeys(['alpha'])).toEqual(['entry-1']);
    expect(store.getEntryKeys('entry-1')).toEqual(['alpha', 'zeta']);
    expect(store.getAnchorKeys('anchor-1')).toEqual(['alpha', 'beta']);
  });

  it('accepts producer-owned key objects for exact key lookup on read leases', () => {
    const owner = new LLMContextOwner(ContextIndexingMode.ProducerOwned);
    owner.initialize([{
      SessionId: testGuid('producer-read-session'),
      UserId: testGuid('user-1'),
      RepositoryId: testGuid('repo-1'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [{
        EntryId: testGuid('entry-1'),
        Sequence: 1,
        Role: ContextRole.User,
        CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('alpha beta'),
        IndexKeys: ['alpha', 'beta'],
      }] }]]),
      Anchors: new Map(),
    }]);

    const lease = owner.openRead(testGuid('producer-read-session'));
    expect(lease.SearchKeys(new ContextIndexKeys(['alpha']), 10)).toHaveLength(1);
    expect(lease.SearchKeys(new ContextIndexKeys([]), 10)).toEqual([]);
  });

  it('reindexes producer-owned keys after session mutation without retaining stale matches', () => {
    const owner = new LLMContextOwner(ContextIndexingMode.ProducerOwned);
    owner.initialize([{
      SessionId: testGuid('index-session'),
      UserId: testGuid('user-1'),
      RepositoryId: testGuid('repo-1'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [{
        EntryId: testGuid('entry-1'),
        Sequence: 1,
        Role: ContextRole.User,
        CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('alpha'),
        IndexKeys: ['alpha'],
      }] }]]),
      Anchors: new Map([[testGuid('anchor-1'), {
        AnchorId: testGuid('anchor-1'),
        StartEntryId: testGuid('entry-1'),
        EndEntryId: testGuid('entry-1'),
        Title: 'alpha anchor',
        Summary: 'alpha summary',
        Topics: ['alpha'],
        Kind: 'Manual' as any,
        SourceRevision: 0,
        PinnedRevision: null,
        IndexKeys: ['beta'],
      }]]),
    }]);

    const previous = owner.openRead(testGuid('index-session'));
    expect(previous.SearchKeys(['alpha'], 5)).toMatchObject([{ EntryId: testGuid('entry-1'), AnchorId: null }]);
    expect(previous.SearchKeys(['beta'], 5)).toMatchObject([{ AnchorId: testGuid('anchor-1') }]);
    expect(previous.SearchKeys(['alpha', 'beta'], 5)).toEqual([]);

    const result = owner.applySession({
      SessionId: testGuid('index-session'),
      ExpectedRevision: 0,
      Changes: [{
        kind: 'ReplaceEntry',
        EntryId: testGuid('entry-1'),
        Content: new TextContent('gamma'),
        IndexKeys: ['gamma'],
      }, {
        kind: 'RemoveAnchor',
        AnchorId: testGuid('anchor-1'),
      }],
    });

    expect(result.Status).toBe(ContextMutationStatus.Applied);
    const current = owner.openRead(testGuid('index-session'));
    expect(current.SearchKeys(['alpha'], 5)).toEqual([]);
    expect(current.SearchKeys(['gamma'], 5)).toMatchObject([{ EntryId: testGuid('entry-1') }]);
    expect(current.SearchKeys(['beta'], 5)).toEqual([]);
    expect(previous.SearchKeys(['beta'], 5)).toHaveLength(1);
    previous.dispose();
    current.dispose();
  });

  it('caps view results to the requested maximum and retains the captured lease snapshot', () => {
    const factory = LLMContextFactory.Create();
    const array = factory.Initialize([
      {
        SessionId: testGuid('view-session'),
        UserId: testGuid('user-1'),
        RepositoryId: testGuid('repo-1'),
        Revision: 0,
        Status: SessionStatus.Active,
        Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [{
          EntryId: testGuid('entry-a'),
          Sequence: 1,
          Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z',
          Content: new TextContent('one'),
        }, {
          EntryId: testGuid('entry-b'),
          Sequence: 2,
          Role: ContextRole.Assistant,
          CreatedAt: '2026-01-01T00:00:00Z',
          Content: new TextContent('two'),
        }] }]]),
        Anchors: new Map(),
      },
    ]);

    const lease = array.OpenRead(testGuid('view-session'));
    const view = array.OpenView({
      SessionId: testGuid('view-session'),
      MaximumResults: 1,
      Evaluate: (context) => context.ReadRange(0, 10).map((entry) => entry.EntryId),
    });

    expect([...view]).toEqual([testGuid('entry-a')]);
    expect(lease.ReadRange(0, 10).map((entry) => entry.EntryId)).toEqual([testGuid('entry-a'), testGuid('entry-b')]);

    const mutated = array.Apply({
      SessionId: testGuid('view-session'),
      ExpectedRevision: 0,
      Changes: [{
        kind: 'AppendEntries',
        Entries: [{
          EntryId: testGuid('entry-c'),
          Role: ContextRole.Assistant,
          CreatedAt: '2026-01-01T00:00:00Z',
          Content: new TextContent('three'),
        }],
      }],
    });
    expect(mutated.Status).toBe(ContextMutationStatus.Applied);
    expect(lease.ReadRange(0, 10).map((entry) => entry.EntryId)).toEqual([testGuid('entry-a'), testGuid('entry-b')]);
    expect(array.OpenRead(testGuid('view-session')).ReadRange(0, 10).map((entry) => entry.EntryId)).toEqual([testGuid('entry-a'), testGuid('entry-b'), testGuid('entry-c')]);
    lease.dispose();
  });

  it('captures a single current read across the callback scope and releases it afterward', () => {
    const factory = LLMContextFactory.Create();
    const array = factory.Initialize([{
      SessionId: testGuid('current-read-session'),
      UserId: testGuid('user-1'),
      RepositoryId: testGuid('repo-1'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [{
        EntryId: testGuid('entry-a'),
        Sequence: 1,
        Role: ContextRole.User,
        CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('current read value'),
      }] }]]),
      Anchors: new Map(),
    }]);

    const unused = array.WithCurrent(testGuid('missing-session'), (lease) => lease);
    expect(() => unused.Session).toThrow(/scope has ended/);
    const result = array.WithCurrent(testGuid('current-read-session'), (lease) => ({
      ids: lease.ReadRange(0, 10).map((entry) => entry.EntryId),
      found: lease.TryFindEntry(testGuid('entry-a')),
    }));

    expect(result.ids).toEqual([testGuid('entry-a')]);
    expect(result.found?.EntryId).toBe(testGuid('entry-a'));
    expect(array.GetStatistics().RetainedReads).toBe(0);
    expect(() => array.WithCurrent(testGuid('current-read-session'), (lease) => {
      expect(array.GetStatistics().RetainedReads).toBe(0);
      expect(lease.Session.Revision).toBe(0);
      expect(array.GetStatistics().RetainedReads).toBe(1);
      throw new Error('consumer failed');
    })).toThrow('consumer failed');
    expect(array.GetStatistics().RetainedReads).toBe(0);
  });

  it('rejects operations on disposed read leases and cleans owner state', () => {
    const owner = new LLMContextOwner();
    owner.initialize([{
      SessionId: testGuid('disposed-read-session'),
      UserId: testGuid('user-1'),
      RepositoryId: testGuid('repo-1'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [{
        EntryId: testGuid('entry-a'),
        Sequence: 1,
        Role: ContextRole.User,
        CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('read me'),
      }] }]]),
      Anchors: new Map(),
    }]);

    const lease = owner.openRead(testGuid('disposed-read-session'));
    lease.dispose();
    expect(() => lease.TryFindEntry(testGuid('entry-a'))).toThrow(Error);
    expect(() => lease.ReadRange(0, 10)).toThrow(Error);

    expect(() => lease.Session).toThrow(/disposed/);
    const escaped = owner.openRead(testGuid('disposed-read-session'));
    owner.dispose();
    expect(() => owner.getStatistics()).toThrow(/disposed/);
    expect(escaped.TryFindEntry(testGuid('entry-a'))?.EntryId).toBe(testGuid('entry-a'));
    escaped.dispose();
  });

  it('charges only admitted view output and keeps admitted views usable after owner disposal', () => {
    const array = LLMContextFactory.Create({
      MaximumEstimatedRetainedBytes: 800,
      ProjectionSizeEstimator: (value) => value === 'oversized' ? 1000 : 32,
    }).Initialize([{
      SessionId: testGuid('snapshot'), UserId: testGuid('user'), RepositoryId: null,
      Revision: 0, Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
    }]);
    const definition = { SessionId: testGuid('snapshot'), MaximumResults: 1 };
    expect(() => array.OpenView({
      ...definition, Evaluate: () => { throw new Error('projection failed'); },
    })).toThrow('projection failed');
    expect(() => array.OpenView({
      ...definition, Evaluate: () => ['oversized'],
    })).toThrow(/Projected-view budget/);
    expect(array.GetStatistics()).toMatchObject({ RetainedReads: 0, EstimatedViewBytes: 0 });

    const empty = array.OpenView({
      ...definition, MaximumResults: 0,
      *Evaluate() { throw new Error('a zero-cap result must not pull the iterator'); },
    });
    expect([...empty]).toEqual([]);
    empty.dispose();

    const view = array.OpenView({ ...definition, Evaluate: () => ['first', 'second'] });
    expect(array.GetStatistics()).toMatchObject({ RetainedReads: 1, EstimatedViewBytes: 32 });
    array.dispose();
    expect([...view]).toEqual(['first']);
    expect(view.SessionRevision).toBe(0);
    view.dispose();
    expect(() => view.length).toThrow(/disposed/);
  });

  it('honors native collector and memoization builder settings through the execution recipe', () => {
    const base = LLMContextFactory.Create();
    const standard = base.Initialize([]);
    expect(standard.GetStatistics().Execution).toBeNull();
    const optional = WithBitFasterTermMemoization(WithLuceneTermCollection(base));
    expect(() => optional.WithProducerOwnedIndexing()).toThrow(/Producer-owned indexing/);
    const native = optional.WithNativeTermCollection().WithoutTermMemoization();
    const owner = native.Initialize([]);
    expect(owner.GetStatistics()).toMatchObject({
      EstimatedActiveBytes: 512, Execution: { TermCollector: 'Native', TermMemo: 'None', EstimatedReservedBytes: 512 },
    });
    expect(() => WithBitFasterTermMemoization(LLMContextFactory.Create({ EstimatedResidentByteBudget: 512 }))).toThrow(RangeError);
    standard.dispose();
    owner.dispose();
  });

  it('rejects invalid options with explicit errors and fences optional execution providers', () => {
    expect(() => validateLLMContextOptions({
      ...defaultLLMContextOptions,
      MaximumViewResults: -1,
    })).toThrow(RangeError);

    expect(() => LLMContextFactory.Create({
      Execution: {
        ...defaultLLMContextOptions.Execution,
        MinimumDeferredCharacters: -1,
      },
    })).toThrow(RangeError);

    expect(() => new NativeTermCollector(false)).toThrow(Error);
    expect(new NativeTermCollector().entries).toEqual([]);
    expect(() => new TextContent(null as unknown as string)).toThrow(TypeError);
  });

  it('marks deferred index work from the execution strategy when large payloads are published', () => {
    const owner = new LLMContextOwner({
      ...defaultLLMContextOptions,
      DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundCharacters: 64 },
      Execution: {
        ...defaultLLMContextOptions.Execution,
        Indexing: ContextIndexingStrategy.AppendOptimized,
        Preparation: ContextPreparationStrategy.Speculative,
        MinimumDeferredCharacters: 128,
      },
    });

    owner.initialize([]);
    owner.createSession({
      SessionId: testGuid('execution-deferred-session'),
      UserId: testGuid('user-1'),
      RepositoryId: testGuid('repo-1'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map(),
      Anchors: new Map(),
    });

    const result = owner.applySession({
      SessionId: testGuid('execution-deferred-session'),
      ExpectedRevision: 0,
      Changes: [{
        kind: 'AppendEntries',
        Entries: [{
          EntryId: testGuid('entry-long'),
          Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z',
          Content: new TextContent('x'.repeat(256)),
        }],
      }],
    });

    expect(result.Status).toBe(ContextMutationStatus.Applied);
    const pending = owner.openRead(testGuid('execution-deferred-session'));
    expect(pending.IndexStatus.PendingEntries).toBe(1);
    pending.dispose();
    owner.dispose();
  });

  it('tracks deferred index lifecycle states without entering deeper parity implementation', () => {
    const lifecycle = new DeferredIndexLifecycle();
    const pending = lifecycle.markPending('session-2', 3, 2048);
    expect(pending.Status).toBe(DeferredIndexLifecycleStatus.Pending);
    expect(pending.PendingEntryCount).toBe(3);
    expect(pending.PendingCharacterCount).toBe(2048);
    expect(pending.FailedEntries).toBe(0);
    expect(pending.Error).toBeNull();
    expect(lifecycle.validateThreshold('session-2', 1024)).toBe(true);

    const failed = lifecycle.markFailed('session-2', 2, 'rebuild failed');
    expect(failed.Status).toBe(DeferredIndexLifecycleStatus.Pending);
    expect(failed.FailedEntries).toBe(2);
    expect(failed.Error).toBe('rebuild failed');

    const reindexing = lifecycle.markReindexing('session-2');
    expect(reindexing.Status).toBe(DeferredIndexLifecycleStatus.Reindexing);

    const complete = lifecycle.complete('session-2');
    expect(complete.Status).toBe(DeferredIndexLifecycleStatus.Ready);
    expect(complete.PendingEntryCount).toBe(0);
    expect(complete.PendingCharacterCount).toBe(0);
    expect(complete.FailedEntries).toBe(0);
    expect(complete.Error).toBeNull();
    expect(complete.IsComplete).toBe(true);
    expect(lifecycle.validateThreshold('session-2', 1)).toBe(false);
  });

    it('keeps superseded deferred work charged until it leaves the queue', async () => {
      const client = LLMContextFactory.Create({
        DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundCharacters: 5, MaximumPendingEntries: 1 },
      }).Initialize([{
        SessionId: testGuid('session'), UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
        Segments: new Map([[0, {
          SegmentId: 0, Revision: 0, Entries: [{
            EntryId: testGuid('entry'), Sequence: 0, Role: ContextRole.User,
            CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('prefix suffix'),
          }],
        }]]), Anchors: new Map(),
      }]);
      const before = client.WaitForIndexingAsync(testGuid('session'), 0);
      const replace = (text: string) => client.Apply({
        SessionId: testGuid('session'), ExpectedRevision: 0,
        Changes: [{ kind: 'ReplaceEntry', EntryId: testGuid('entry'), Content: new TextContent(text) }],
      });
      expect(replace('another suffix').Status).toBe(ContextMutationStatus.AdmissionRejected);
      expect(replace('tiny').Status).toBe(ContextMutationStatus.Applied);
      await expect(before).rejects.toThrow(/revision changed/);
      expect(client.WithCurrent(testGuid('session'), (read) => read.IndexStatus.IsComplete)).toBe(true);
      expect(client.GetStatistics().PendingIndexWork).toBe(1);
      await client.WaitForIndexingAsync(testGuid('session'), 1);
      expect(client.GetStatistics()).toMatchObject({
        PendingIndexWork: 0, EstimatedIndexWorkBytes: 0, CompletedIndexJobs: 0, DiscardedIndexJobs: 1,
      });
      client.dispose();
    });

    it('publishes background indexing failures without weakening exact search or leaking work reservations', async () => {
      const client = LLMContextFactory.Create({
        DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundCharacters: 5 },
      })[configureExecutionProviders](new ContextExecutionRecipe(() => ({
        Name: 'FailingTestCollector', Collect: Terms, Complete: () => { throw new Error('test completion failed'); },
      }), true)).Initialize([{
        SessionId: testGuid('failure'), UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
        Segments: new Map([[0, {
          SegmentId: 0, Revision: 0, Entries: [{
            EntryId: testGuid('entry'), Sequence: 0, Role: ContextRole.User,
            CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('alpha omega'),
          }],
        }]]), Anchors: new Map(),
      }]);
      await expect(client.WaitForIndexingAsync(testGuid('failure'), 0)).rejects.toThrow('test completion failed');
      expect(client.GetStatistics()).toMatchObject({ PendingIndexWork: 0, EstimatedIndexWorkBytes: 0, CompletedIndexJobs: 0 });
      client.WithCurrent(testGuid('failure'), (read) => {
        expect(read.IndexStatus).toMatchObject({ PendingEntries: 1, FailedEntries: 1, IndexGeneration: 1 });
        expect(read.Search('omega', 1)).toHaveLength(1);
        expect(read.SearchIndexed('omega', 1).Hits).toEqual([]);
      });
      client.dispose();
    });

  it('reports exact and indexed-only coverage separately and never refreshes old leases', async () => {
    const owner = new LLMContextOwner({
      ...defaultLLMContextOptions,
      DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundCharacters: 8 },
    });
    owner.initialize([{
      SessionId: testGuid('deferred-session'),
      UserId: testGuid('user-1'),
      RepositoryId: testGuid('repo-1'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [{
        EntryId: testGuid('entry-1'),
        Sequence: 1,
        Role: ContextRole.User,
        CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('alpha bÉta'),
      }] }]]),
      Anchors: new Map(),
    }]);

    const lease = owner.openRead(testGuid('deferred-session'));
    expect(lease.IndexStatus.PendingEntries).toBe(1);
    expect(lease.SearchIndexed('alpha', 10).Hits).toHaveLength(1);
    expect(lease.SearchIndexed('bÉta', 10).Hits).toEqual([]);
    expect(lease.SearchIndexed('bé', 10).Hits).toEqual([]);
    expect(lease.Search('bÉta', 10)).toHaveLength(1);
    expect(owner.getStatistics().PendingIndexWork).toBe(1);

    const controller = new AbortController();
    const canceled = owner.waitForIndexingAsync(testGuid('deferred-session'), 0, controller.signal);
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    await owner.waitForIndexingAsync(testGuid('deferred-session'), 0);
    const completedLease = owner.openRead(testGuid('deferred-session'));
    expect(completedLease.IndexStatus).toMatchObject({ SessionRevision: 0, IndexGeneration: 1, IsComplete: true, PendingEntries: 0 });
    expect(completedLease.SearchIndexed('bÉta', 10).Hits).toHaveLength(1);
    expect(lease.IndexStatus.PendingEntries).toBe(1);
    expect(lease.SearchIndexed('bÉta', 10).Hits).toEqual([]);
    expect(owner.getStatistics()).toMatchObject({ PendingIndexWork: 0, EstimatedIndexWorkBytes: 0, CompletedIndexJobs: 1 });
    lease.dispose();
    completedLease.dispose();
    owner.dispose();
  });

  it('exposes a write-optimized producer-owned preset and validates partitioned index constraints', () => {
    expect(WriteOptimized.IndexingMode).toBe(ContextIndexingMode.ProducerOwned);
    expect(WriteOptimized.PartitionedIndex?.WriteBehavior).toBe(ContextSynchronizationWriteBehavior.Reject);
    expect(WriteOptimized.MaximumEntriesPerSegment).toBe(8);
    expect(WriteOptimized.MaximumEstimatedBytesPerSegment).toBe(32 * 1024);
    expect(WriteOptimized.MaximumEstimatedRetainedBytes).toBe(256 * 1024 * 1024);
    expect(WriteOptimized.MaximumRetainedReads).toBe(2048);
    expect(WriteOptimized.AdmissionTimeoutMs).toBe(5);
    expect(Reflect.set(WriteOptimized.PartitionedIndex!, 'MaximumWorkingSetEntries', 1)).toBe(false);
    expect(Reflect.set(defaultLLMContextOptions.TimeProvider, 'now', () => 0)).toBe(false);

    expect(() => validateLLMContextOptions({
      ...WriteOptimized,
      IndexingMode: ContextIndexingMode.Text,
    })).toThrow(Error);

    expect(() => validateLLMContextOptions({
      ...WriteOptimized,
      DeferredIndexing: defaultDeferredIndexingOptions,
    })).toThrow(Error);
  });

  it('waits for indexing and exposes synchronization completion metadata', async () => {
    const owner = new LLMContextOwner();
    owner.initialize([{
      SessionId: testGuid('sync-session'),
      UserId: testGuid('user-1'),
      RepositoryId: testGuid('repo-1'),
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map(),
      Anchors: new Map(),
    }]);

    await owner.waitForIndexingAsync(testGuid('sync-session'), 0);
    await expect(owner.synchronizeIndexAsync(testGuid('sync-session'))).rejects.toThrow(/Enable partitioned indexing/);
  });

  it('enforces partition working-set capacity and compaction rules', () => {
    const options = {
      MaximumEstimatedPartitionBytes: 2048,
      MaximumWorkingSetEntries: 1,
      MaximumEstimatedWorkingSetBytes: 512,
      MaximumPendingSynchronizations: 8,
      MaximumEstimatedPreparationBytes: 1024,
      WriteBehavior: ContextSynchronizationWriteBehavior.Reject,
      SynchronizationWaitTimeoutMs: 1000,
      InfrastructureBytes: 4096 + 512 * 8,
      RecoveryBytes: 2 * 2048,
    };

    const index = new PartitionedContextIndex(options);
    const first = index.override('session-3', 'entry-1', ['alpha'], 32, options);
    expect(first.EstimatedBytes).toBeGreaterThan(0);

    expect(() => index.override('session-3', 'entry-2', ['beta'], 256, options)).toThrow(PartitionCapacityException);

    const compacted = index.compact('session-3');
    expect(compacted.Overrides.size).toBe(0);
    expect(compacted.Search.get('alpha')).toEqual(['entry-1']);
  });

  it('routes deferred completion through the selected collector and memoizes only complete exact text', async () => {
    const builder = LLMContextFactory.Create({
      DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundCharacters: 6, MaximumPendingEntries: 1 },
    }).WithExecutionStrategies({
      Indexing: ContextIndexingStrategy.AppendOptimized,
      MinimumDeferredCharacters: 8,
      Preparation: ContextPreparationStrategy.Serialized,
    });
    const recipe = WithBitFasterTermMemoization(WithLuceneTermCollection(builder, LuceneTermCollection.CharTerm));
    const session = {
      SessionId: testGuid('recipe'), UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map(), Anchors: new Map(),
    };
    const owner = recipe.Initialize([session]);
    const otherOwner = recipe.Initialize([session]);
    const append = (revision: number, entry: string, text: string) => owner.Apply({
      SessionId: session.SessionId, ExpectedRevision: revision, Changes: [{
        kind: 'AppendEntries', Entries: [{
          EntryId: testGuid(entry), CreatedAt: '2026-01-01T00:00:00Z', Role: ContextRole.User, Content: new TextContent(text),
        }],
      }],
    });
    expect(append(0, 'first', 'alpha bÉta gamma').Status).toBe(ContextMutationStatus.Applied);
    expect(owner.GetStatistics().Execution).toMatchObject({ DeferredEntries: 1, MemoEntries: 0 });
    expect(append(1, 'second', 'other bÉta gamma').Status).toBe(ContextMutationStatus.Applied);
    expect(owner.GetStatistics().Execution).toMatchObject({ DeferredCapacityFallbacks: 1, MemoEntries: 1 });
    await owner.WaitForIndexingAsync(testGuid('recipe'), 2);
    expect(append(2, 'third', 'alpha bÉta gamma').Status).toBe(ContextMutationStatus.Applied);
    expect(owner.GetStatistics().Execution).toMatchObject({
      TermCollector: 'LuceneCharTerm', TermMemo: 'BitFasterConcurrentLru',
      MemoHits: 1, MemoEntries: 2, DeferredEntries: 1, SerializedPreparations: 3,
    });
    expect(owner.WithCurrent(testGuid('recipe'), (lease) => lease.Search('BÉTA', 4))).toHaveLength(3);
    expect(otherOwner.GetStatistics().Execution).toMatchObject({ MemoHits: 0, MemoEntries: 0 });
    owner.dispose();
    otherOwner.dispose();
    expect(() => validateLLMContextOptions({
      ...defaultLLMContextOptions,
      Execution: {
        ...defaultLLMContextOptions.Execution,
        Indexing: ContextIndexingStrategy.AppendOptimized,
      },
      DeferredIndexing: null,
    })).toThrow(Error);
  });

  it('prepares intermediate replacements without publishing their terms or queuing their jobs', async () => {
    const makeSession = () => ({
      SessionId: testGuid('index-order'), UserId: testGuid('owner'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, {
        SegmentId: 0, Revision: 0, Entries: [{
          EntryId: testGuid('first'), Sequence: 0, Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('initial'),
        }],
      }]]),
      Anchors: new Map(),
    });
    const replace = (text: string) => ({
      kind: 'ReplaceEntry' as const, EntryId: testGuid('first'), Content: new TextContent(text),
    });
    const owner = LLMContextFactory.Create().WithExecutionStrategies().Initialize([makeSession()]);
    try {
      expect(owner.Apply({
        SessionId: testGuid('index-order'), ExpectedRevision: 0,
        Changes: [replace('intermediate'), { ...replace('invalid'), EntryId: testGuid('missing') }],
      }).Status).toBe(ContextMutationStatus.InvalidOperation);
      expect(owner.GetStatistics().Execution?.TermCollections).toBe(2);
      expect(owner.WithCurrent(testGuid('index-order'), (read) => read.Search('initial', 1))).toHaveLength(1);
      expect(owner.Apply({
        SessionId: testGuid('index-order'), ExpectedRevision: 0,
        Changes: [replace('intermediate'), replace('terminal')],
      }).Status).toBe(ContextMutationStatus.Applied);
      expect(owner.GetStatistics().Execution?.TermCollections).toBe(4);
      expect(owner.WithCurrent(testGuid('index-order'), (read) => read.Search('intermediate', 1))).toHaveLength(0);
      const current = owner.WithCurrent(testGuid('index-order'), (read) => read.ReadRange(0, 1)[0]);
      expect(Object.isFrozen(current.Content)).toBe(true);
      expect(owner.Apply({
        SessionId: testGuid('index-order'), ExpectedRevision: 1,
        Changes: [{ ...replace('ignored'), Content: current.Content }],
      }).Status).toBe(ContextMutationStatus.Applied);
      expect(owner.GetStatistics().Execution?.TermCollections).toBe(4);
    } finally {
      owner.dispose();
    }

    const deferred = LLMContextFactory.Create({
      DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundWords: 1, MaximumPendingEntries: 1 },
    }).WithExecutionStrategies().Initialize([makeSession()]);
    try {
      await deferred.WaitForIndexingAsync(testGuid('index-order'), 0);
      const before = Number(deferred.GetStatistics().Execution?.DeferredEntries);
      expect(deferred.Apply({
        SessionId: testGuid('index-order'), ExpectedRevision: 0,
        Changes: [replace('prefix superseded'), replace('prefix winner')],
      }).Status).toBe(ContextMutationStatus.Applied);
      expect(deferred.GetStatistics().Execution?.DeferredEntries).toBe(before + 2);
      await deferred.WaitForIndexingAsync(testGuid('index-order'), 1);
      expect(deferred.WithCurrent(testGuid('index-order'), (read) => read.Search('winner', 1))).toHaveLength(1);
      expect(deferred.WithCurrent(testGuid('index-order'), (read) => read.Search('superseded', 1))).toHaveLength(0);
    } finally {
      deferred.dispose();
    }
  });

  it('releases failed deferred work while exact search still covers its unindexed suffix', async () => {
    const owner = LLMContextFactory.Create({
      DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundWords: 1, MaximumPendingEntries: 1 },
    })[configureExecutionProviders](new ContextExecutionRecipe(() => ({
      Name: 'FailingCompletion', Collect: Terms, Complete() { throw null; },
    }), true)).Initialize([{
      SessionId: testGuid('failed-index'), UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, {
        SegmentId: 0, Revision: 0, Entries: [{
          EntryId: testGuid('entry'), Sequence: 0, CreatedAt: '2026-01-01T00:00:00Z',
          Role: ContextRole.User, Content: new TextContent('prefix suffix'),
        }],
      }]]),
      Anchors: new Map(),
    }]);
    try {
      await expect(owner.WaitForIndexingAsync(testGuid('failed-index'), 0)).rejects.toThrow('null');
      expect(owner.GetStatistics()).toMatchObject({ PendingIndexWork: 0, EstimatedIndexWorkBytes: 0 });
      owner.WithCurrent(testGuid('failed-index'), (read) => {
        expect(read.SearchIndexed('suffix', 1)).toMatchObject({ Hits: [], IndexStatus: { FailedEntries: 1, IsComplete: false } });
        expect(read.Search('suffix', 1)).toHaveLength(1);
      });
      expect(owner.Apply({
        SessionId: testGuid('failed-index'), ExpectedRevision: 0,
        Changes: [{ kind: 'ReplaceEntry', EntryId: testGuid('entry'), Content: new TextContent('recovered') }],
      }).Status).toBe(ContextMutationStatus.Applied);
      await expect(owner.WaitForIndexingAsync(testGuid('failed-index'), 1)).resolves.toBeUndefined();
    } finally { owner.dispose(); }
  });

  it('preserves unrebuilt overrides and reopens writes after partial partition synchronization fails', async () => {
    let injected = false;
    const owner = new LLMContextOwner({
      ...defaultLLMContextOptions, IndexingMode: ContextIndexingMode.ProducerOwned,
      MaximumEntriesPerSegment: 1, PartitionedIndex: defaultPartitionedContextIndexOptions,
    }, undefined, undefined, (_session, segment) => {
      if (segment === 1 && !injected) {
        injected = true;
        throw new Error('injected partition failure');
      }
    });
    const sessionId = testGuid('partial');
    const entries = ['first', 'second'].map((label, Sequence) => ({
      EntryId: testGuid(label), Sequence, Role: ContextRole.User, CreatedAt: '2026-01-01T00:00:00Z',
      Content: new TextContent('old'), IndexKeys: ['base'],
    }));
    try {
      expect(owner.createSession({
        SessionId: sessionId, UserId: testGuid('owner'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
        Segments: new Map(entries.map((entry, SegmentId) => [SegmentId, { SegmentId, Revision: 0, Entries: [entry] }])),
        Anchors: new Map(),
      }).Status).toBe(ContextMutationStatus.Applied);
      expect(owner.applySession({ SessionId: sessionId, ExpectedRevision: 0, Changes: entries.map(({ EntryId }) => ({
        kind: 'ReplaceEntry', EntryId, Content: new TextContent('new'), IndexKeys: ['override'],
      })) }).Status).toBe(ContextMutationStatus.Applied);
      const dirty = owner.openRead(sessionId);
      try {
        await expect(owner.synchronizeIndexAsync(sessionId)).resolves.toMatchObject({
          Succeeded: false, Error: 'injected partition failure', PartitionsCompacted: 1, ContentRevision: 1, Generation: 1,
        });
        const partial = owner.openRead(sessionId);
        try {
          expect(partial.IndexStatus.IndexGeneration).toBe(1);
          expect(dirty.IndexStatus.IndexGeneration).toBe(0);
          expect(partial.SearchKeys(['override'], 2)).toEqual(dirty.SearchKeys(['override'], 2));
          expect(partial.SearchKeys(['base'], 2)).toHaveLength(0);
        } finally { partial.dispose(); }
        expect(owner.applySession({ SessionId: sessionId, ExpectedRevision: 1,
          Changes: [{ kind: 'SetSessionStatus', Status: SessionStatus.Active }] }).Status).toBe(ContextMutationStatus.Applied);
        await expect(owner.synchronizeIndexAsync(sessionId)).resolves.toMatchObject({
          Succeeded: true, PartitionsCompacted: 1, ContentRevision: 2, Generation: 2,
        });
      } finally { dirty.dispose(); }
      expect(owner.getStatistics()).toMatchObject({ RetainedReads: 0, PendingSynchronizations: 0 });
    } finally { owner.dispose(); }
  });

  it('queues real partition maintenance, fences writes, and preserves snapshots and revisions', async () => {
    const makeSession = (id: string) => ({
      SessionId: testGuid(id), UserId: testGuid('owner'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, {
        SegmentId: 0, Revision: 0, Entries: ['first', 'second'].map((entryId, sequence) => ({
          EntryId: testGuid(entryId), Sequence: sequence, Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent(entryId), IndexKeys: ['base'],
        })),
      }]]),
      Anchors: new Map(),
    });
    const client = LLMContextFactory.Create().WithPartitionedIndexing({
      ...defaultPartitionedContextIndexOptions, MaximumWorkingSetEntries: 1, MaximumPendingSynchronizations: 1,
    }).Initialize([makeSession('primary'), makeSession('secondary')]);
    const replace = (session: string, revision: number, entry: string) => client.Apply({
      SessionId: testGuid(session), ExpectedRevision: revision, Changes: [{
        kind: 'ReplaceEntry', EntryId: testGuid(entry), Content: new TextContent('updated'), IndexKeys: ['override'],
      }],
    });
    const original = client.OpenRead(testGuid('primary'));
    expect(await client.SynchronizeIndexAsync(testGuid('primary'))).toMatchObject({ Generation: 0, PartitionsCompacted: 0 });
    expect(replace('primary', 0, 'first').Status).toBe(ContextMutationStatus.Applied);
    expect(replace('secondary', 0, 'first').Status).toBe(ContextMutationStatus.Applied);
    const dirty = client.OpenRead(testGuid('primary'));
    expect(dirty.SearchKeys(['base'], 1)).toMatchObject([{ EntryId: testGuid('second') }]);
    expect(dirty.SearchKeys(['base', 'override'], 1)).toEqual([]);
    expect(original.SearchKeys(['base'], 1)).toMatchObject([{ EntryId: testGuid('first') }]);
    expect(replace('primary', 1, 'second').Status).toBe(ContextMutationStatus.SynchronizationRequired);
    const controller = new AbortController();
    const canceled = client.SynchronizeIndexAsync(testGuid('primary'), controller.signal);
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.GetStatistics().PendingSynchronizations).toBe(1);
    expect(await client.SynchronizeIndexAsync(testGuid('secondary'))).toMatchObject({ Succeeded: false, Error: 'Synchronization backlog is full.' });
    expect(replace('primary', 1, 'second').Status).toBe(ContextMutationStatus.Synchronizing);
    expect(replace('primary', 0, 'second')).toMatchObject({ Status: ContextMutationStatus.Synchronizing, Revision: 0 });
    expect(await client.SynchronizeIndexAsync(testGuid('primary'))).toMatchObject({
      Succeeded: true, ContentRevision: 1, Generation: 1, PartitionsCompacted: 1,
    });
    expect(client.GetStatistics().PendingSynchronizations).toBe(0);
    expect(client.WithCurrent(testGuid('primary'), (lease) => lease.IndexStatus)).toMatchObject({
      SessionRevision: 1, IndexGeneration: 1,
    });
    expect(dirty.IndexStatus.IndexGeneration).toBe(0);
    expect(replace('primary', 0, 'second').Status).toBe(ContextMutationStatus.RevisionConflict);
    expect(replace('primary', 1, 'second').Status).toBe(ContextMutationStatus.Applied);
    original.dispose();
    dirty.dispose();
    client.dispose();
  });

  it('checks runtime compatibility against the port’s minimum Node profile', () => {
    expect(() => validateRuntimeCompatibility()).not.toThrow();
    expect(() => validateRuntimeCompatibility({ MinNodeMajorVersion: 999 })).toThrow(Error);
  });
});
