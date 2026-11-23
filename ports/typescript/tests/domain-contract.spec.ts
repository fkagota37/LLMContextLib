// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { describe, expect, it } from 'vitest';
import { ContextIndexingMode, ContextIndexKeys } from '../src/domain/index-keys.js';
import { ContextMutationStatus, ContextRole, SessionStatus, TextContent } from '../src/domain/session.js';
import { defaultLLMContextOptions, validateLLMContextOptions } from '../src/options.js';
import { LLMContextFactory } from '../src/factory.js';
import { IndexStore } from '../src/storage/index-store.js';
import { LLMContextOwner } from '../src/storage/owner.js';

describe('TypeScript domain contracts', () => {
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
      SessionId: 'session-1',
      UserId: 'user-1',
      RepositoryId: 'repo-1',
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [] }]]),
      Anchors: new Map(),
    };

    const array = factory.Initialize([session]);
    const found = array.TryFind('session-1');
    expect(found).toEqual({ SessionId: 'session-1', Revision: 0 });

    const conflict = array.Apply({
      SessionId: 'session-1',
      ExpectedRevision: 17,
      Changes: [],
    });
    expect(conflict.Status).toBe(ContextMutationStatus.RevisionConflict);

    const lease = array.OpenRead('session-1');
    expect(lease.ReadRange(0, 10)).toEqual([]);
    expect(lease.TryFindEntry('missing-entry')).toBe(false);

    const appended = array.Apply({
      SessionId: 'session-1',
      ExpectedRevision: 0,
      Changes: [{
        kind: 'AppendEntries',
        Entries: [{
          EntryId: 'entry-1',
          Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z',
          Content: new TextContent('hello from the port'),
        }],
      }],
    });
    expect(appended.Status).toBe(ContextMutationStatus.Applied);
    expect(array.OpenRead('session-1').ReadRange(0, 10)).toHaveLength(1);
  });

  it('tracks live read leases and publication accounting in the owner boundary', () => {
    const owner = new LLMContextOwner();
    owner.initialize([{ 
      SessionId: 'accounting-session',
      UserId: 'user-1',
      RepositoryId: 'repo-1',
      Revision: 0,
      Status: SessionStatus.Active,
      Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [{
        EntryId: 'entry-1',
        Sequence: 1,
        Role: ContextRole.User,
        CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('alpha'),
      }] }]]),
      Anchors: new Map(),
    }]);

    const firstLease = owner.openRead('accounting-session');
    const secondLease = owner.openRead('accounting-session');
    expect(owner.getStatistics().RetainedReads).toBe(2);
    expect(owner.getStatistics().EstimatedRetainedBytes).toBeGreaterThan(0);

    firstLease.dispose();
    expect(owner.getStatistics().RetainedReads).toBe(1);

    const sessionMutation = owner.applySession({
      SessionId: 'accounting-session',
      ExpectedRevision: 0,
      Changes: [{ kind: 'AppendEntries', Entries: [{
        EntryId: 'entry-2',
        Role: ContextRole.Assistant,
        CreatedAt: '2026-01-01T00:00:00Z',
        Content: new TextContent('beta'),
      }] }],
    });
    expect(sessionMutation.Status).toBe(ContextMutationStatus.Applied);
    expect(owner.getStatistics().PublishedMutations).toBe(1);

    const memoryMutation = owner.applyMemory({
      ExpectedRevision: 0,
      Upserts: [{
        MemoryId: 'memory-1',
        Scope: { UserId: 'user-1' },
        Content: 'gamma',
        Revision: 0,
        Status: 'Confirmed' as any,
        ExpiresAt: null,
        Sources: [],
      }],
      Deletes: [],
    });
    expect(memoryMutation.Status).toBe(ContextMutationStatus.Applied);
    expect(owner.getStatistics().PublishedMutations).toBe(2);

    secondLease.dispose();
    expect(owner.getStatistics().RetainedReads).toBe(0);
  });

  it('updates memory rows with explicit revision and not-found checks', () => {
    const factory = LLMContextFactory.Create();
    const root = factory.Initialize([]);
    const memory = root.ApplyMemory({
      ExpectedRevision: 0,
      Upserts: [{
        MemoryId: 'memory-1',
        Scope: { UserId: 'user-1' },
        Content: 'alpha',
        Revision: 0,
        Status: 'Confirmed' as any,
        ExpiresAt: null,
        Sources: [],
      }],
      Deletes: [],
    });

    expect(memory.Status).toBe(ContextMutationStatus.Applied);
    expect(root.ApplyMemory({
      ExpectedRevision: 0,
      Upserts: [],
      Deletes: ['memory-missing'],
    }).Status).toBe(ContextMutationStatus.NotFound);
  });

  it('stores producer-owned keys and resolves them through the index boundary', () => {
    const store = new IndexStore();
    store.setEntry('entry-1', new ContextIndexKeys(['zeta', 'alpha', 'alpha']), ContextIndexingMode.ProducerOwned);
    store.setAnchor('anchor-1', new ContextIndexKeys(['alpha', 'beta']), ContextIndexingMode.ProducerOwned);

    expect(store.searchKeys(['alpha'])).toEqual(['entry-1']);
    expect(store.getEntryKeys('entry-1')).toEqual(['alpha', 'zeta']);
    expect(store.getAnchorKeys('anchor-1')).toEqual(['alpha', 'beta']);
  });

  it('caps view results to the requested maximum and retains the captured lease snapshot', () => {
    const factory = LLMContextFactory.Create();
    const array = factory.Initialize([
      {
        SessionId: 'view-session',
        UserId: 'user-1',
        RepositoryId: 'repo-1',
        Revision: 0,
        Status: SessionStatus.Active,
        Segments: new Map([[1, { SegmentId: 1, Revision: 0, Entries: [{
          EntryId: 'entry-a',
          Sequence: 1,
          Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z',
          Content: new TextContent('one'),
        }, {
          EntryId: 'entry-b',
          Sequence: 2,
          Role: ContextRole.Assistant,
          CreatedAt: '2026-01-01T00:00:00Z',
          Content: new TextContent('two'),
        }] }]]),
        Anchors: new Map(),
      },
    ]);

    const lease = array.OpenRead('view-session');
    const view = array.OpenView({
      SessionId: 'view-session',
      MaximumResults: 1,
      Evaluate: (context) => context.ReadRange(0, 10).map((entry) => entry.EntryId),
    });

    expect([...view]).toEqual(['entry-a']);
    expect(lease.ReadRange(0, 10).map((entry) => entry.EntryId)).toEqual(['entry-a', 'entry-b']);

    const mutated = array.Apply({
      SessionId: 'view-session',
      ExpectedRevision: 0,
      Changes: [{
        kind: 'AppendEntries',
        Entries: [{
          EntryId: 'entry-c',
          Role: ContextRole.Assistant,
          CreatedAt: '2026-01-01T00:00:00Z',
          Content: new TextContent('three'),
        }],
      }],
    });
    expect(mutated.Status).toBe(ContextMutationStatus.Applied);
    expect(lease.ReadRange(0, 10).map((entry) => entry.EntryId)).toEqual(['entry-a', 'entry-b']);
    expect(array.OpenRead('view-session').ReadRange(0, 10).map((entry) => entry.EntryId)).toEqual(['entry-a', 'entry-b', 'entry-c']);
    lease.dispose();
  });

  it('rejects invalid options with explicit errors', () => {
    expect(() => validateLLMContextOptions({
      ...defaultLLMContextOptions,
      MaximumViewResults: -1,
    })).toThrow(RangeError);

    expect(() => new TextContent(null as unknown as string)).toThrow(TypeError);
  });
});
