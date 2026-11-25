// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { testGuid } from './test-guid.js';
import { describe, expect, it } from 'vitest';
import { ContextRole, SessionStatus, SummaryContent, TextContent, ToolCallContent, ToolResultContent, type ContextEntry, type ContextMemory } from '../src/domain/session.js';
import { BuildModelContext, Terms, ValidateScope } from '../src/policies/context.js';
import { LLMContextFactory } from '../src/factory.js';
import { defaultDeferredIndexingOptions, defaultLLMContextOptions } from '../src/options.js';
import { defaultPartitionedContextIndexOptions } from '../src/storage/partitioned-index.js';
import { estimateActiveByteRange, estimateProjectionBytes } from '../src/policies/estimation.js';
import { filterExactTextMatches, filterKeyMatches, orderSearchMatches } from '../src/policies/search.js';
import { canonicalizeSearchText, getEntryText, lexCompareText, truncateForSnippet } from '../src/policies/text.js';

const entries: readonly ContextEntry[] = [
  {
    EntryId: testGuid('entry-2'),
    Sequence: 2,
    Role: 'User' as any,
    CreatedAt: '2026-01-01T00:00:00Z',
    Content: new TextContent('Alpha feature discussion'),
    IndexKeys: ['feature', 'alpha'],
  },
  {
    EntryId: testGuid('entry-1'),
    Sequence: 1,
    Role: 'Assistant' as any,
    CreatedAt: '2026-01-01T00:00:00Z',
    Content: new TextContent('Beta release summary'),
    IndexKeys: ['beta'],
  },
];

describe('Runtime policy contracts', () => {
  it('uses the pinned .NET lexical classes and simple lowercase mappings', () => {
    expect(Terms('A\u088fB \u1c89 \u0130 \u{10400}')).toEqual(['a', 'b', '\u0130']);
  });

  it('rejects invalid limits and a deferred worker reservation that cannot fit at construction', () => {
    expect(() => LLMContextFactory.Create({ MaximumRetainedReads: NaN })).toThrow(RangeError);
    expect(() => LLMContextFactory.Create({ MaximumViewResults: 0x8000_0000 })).toThrow(RangeError);
    expect(() => LLMContextFactory.Create({ AdmissionTimeoutMs: Infinity })).toThrow(RangeError);
    const deferred = { ...defaultDeferredIndexingOptions, MaximumPendingEntries: 1 };
    expect(() => LLMContextFactory.Create({ DeferredIndexing: deferred, EstimatedResidentByteBudget: 1151 })).toThrow(/infrastructure/);
    expect(() => LLMContextFactory.Create({ DeferredIndexing: deferred, EstimatedResidentByteBudget: 1152 })).not.toThrow();
  });

  it('keeps reusable partition recipes independent of later caller changes', () => {
    const partitions = { ...defaultPartitionedContextIndexOptions };
    const builder = LLMContextFactory.Create(null, null).WithPartitionedIndexing(partitions);
    partitions.MaximumPendingSynchronizations++;
    const first = builder.Initialize([]);
    const second = LLMContextFactory.Create().WithPartitionedIndexing(null).Initialize([]);
    try {
      expect(first.GetStatistics().EstimatedActiveBytes).toBe(second.GetStatistics().EstimatedActiveBytes);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('charges built-in projection payloads rather than a fixed object fallback', () => {
    const estimate = defaultLLMContextOptions.ProjectionSizeEstimator;
    expect(estimate(entries[0])).toBe(128 + 2 * 'Alpha feature discussion'.length);
    expect(estimate({ EntryId: testGuid('entry'), SessionRevision: 0, Snippet: 'hit' })).toBe(102);
    expect(estimate({ MemoryId: testGuid('memory'), Scope: { SessionId: testGuid('session') }, Content: 'note' })).toBe(136);
    expect(estimate({ EntryId: testGuid('entry'), MemoryId: null, Text: 'model' })).toBe(106);
    expect(estimate({ Text: 'arbitrary projection' })).toBe(128);
  });

  it('trims search text and maintains lexical order for deterministic comparisons', () => {
    expect(canonicalizeSearchText('  alpha  ')).toBe('alpha');
    expect(canonicalizeSearchText(null as any)).toBe('');
    expect(lexCompareText('alpha', 'beta')).toBeLessThan(0);
    expect(truncateForSnippet('a'.repeat(200), 120).length).toBeLessThanOrEqual(120);
    expect(truncateForSnippet('abc', 0)).toBe('');
  });

  it('filters exact text matches without silently modifying the query semantics', () => {
    const alphaMatches = filterExactTextMatches(entries, 'alpha', 10);
    expect(alphaMatches).toHaveLength(1);
    expect(alphaMatches[0]?.EntryId).toBe(testGuid('entry-2'));
    expect(orderSearchMatches(alphaMatches)[0]?.Sequence).toBe(2);

    const multiTermMatches = filterExactTextMatches(entries, 'feature discussion', 10);
    expect(multiTermMatches).toHaveLength(1);
    expect(multiTermMatches[0]?.EntryId).toBe(testGuid('entry-2'));
  });

  it('matches read-lease Unicode search without ASCII-prefix false positives', () => {
    const source: readonly ContextEntry[] = ['\u4f60\u597d', 'caf\u00e9', 'caf', '\u0130'].map((text, Sequence) => ({
      EntryId: testGuid(`unicode-${Sequence}`), Sequence, Role: ContextRole.User,
      CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent(text),
    }));
    const SessionId = testGuid('unicode-session');
    const owner = LLMContextFactory.Create().Initialize([{
      SessionId, UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: source }]]), Anchors: new Map(),
    }]);
    try {
      owner.WithCurrent(SessionId, (read) => {
        for (const [query, index] of [['\u4f60\u597d', 0], ['CAF\u00c9', 1], ['caf', 2], ['\u0130', 3]] as const) {
          const expected = [source[index].EntryId];
          expect(read.Search(query, 10).map((hit) => hit.EntryId)).toEqual(expected);
          expect(filterExactTextMatches(source, query, 10).map((hit) => hit.EntryId)).toEqual(expected);
        }
        expect(filterExactTextMatches(source, '!!!', 10)).toEqual([]);
      });
    } finally {
      owner.dispose();
    }
  });

  it('requires all opaque query keys on the same entry like read-lease SearchKeys', () => {
    const source: readonly ContextEntry[] = [['alpha'], ['alpha', 'beta'], ['beta'], []].map((IndexKeys, Sequence) => ({
      EntryId: testGuid(`keys-${Sequence}`), Sequence, Role: ContextRole.User,
      CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('opaque keys'), IndexKeys,
    }));
    const SessionId = testGuid('keys-session');
    const owner = LLMContextFactory.Create().WithProducerOwnedIndexing().Initialize([{
      SessionId, UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: source }]]), Anchors: new Map(),
    }]);
    try {
      owner.WithCurrent(SessionId, (read) => {
        for (const keys of [['alpha', 'beta'], ['alpha', 'alpha', 'beta']]) {
          const expected = [source[1].EntryId];
          expect(read.SearchKeys(keys, 10).map((hit) => hit.EntryId)).toEqual(expected);
          expect(filterKeyMatches(source, keys, 10).map((hit) => hit.EntryId)).toEqual(expected);
        }
        for (const keys of [[], ['ALPHA'], ['missing']]) {
          expect(filterKeyMatches(source, keys, 10)).toEqual([]);
          expect(read.SearchKeys(keys, 10)).toEqual([]);
        }
      });
    } finally {
      owner.dispose();
    }
  });

  it('retains tool correlation IDs in text and exact-search policy results', () => {
    const contents = [
      new ToolCallContent('call-42', 'lookup', '{"query":"alpha"}'),
      new ToolResultContent('call-42', '{"result":"ok"}', false),
    ];
    const source: readonly ContextEntry[] = contents.map((Content, Sequence) => ({
      EntryId: testGuid(`tool-${Sequence}`), Sequence,
      Role: Sequence === 0 ? ContextRole.Assistant : ContextRole.Tool,
      CreatedAt: '2026-01-01T00:00:00Z', Content,
    }));
    const SessionId = testGuid('tool-session');
    const owner = LLMContextFactory.Create().Initialize([{
      SessionId, UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: source }]]), Anchors: new Map(),
    }]);
    try {
      expect(source.map(getEntryText)).toEqual([
        'lookup call-42 {"query":"alpha"}', 'call-42 {"result":"ok"}',
      ]);
      const expected = source.map((entry) => entry.EntryId);
      expect(owner.WithCurrent(SessionId, (read) => read.Search('call-42', 10).map((hit) => hit.EntryId))).toEqual(expected);
      expect(filterExactTextMatches(source, 'call-42', 10).map((hit) => hit.EntryId)).toEqual(expected);
    } finally {
      owner.dispose();
    }
  });

  it('keeps projection estimation conservative and integer-safe for bounded runtime accounting', () => {
    expect(estimateProjectionBytes([1, 2, 3], (value) => Number(value) * 2)).toBe(12);
    expect(estimateProjectionBytes([1, Number.NaN, -2], (value) => Number(value))).toBe(1);
    expect(estimateActiveByteRange(2, 3, 10)).toBe(2048 + 768 + 640);
    expect(estimateActiveByteRange(-2, 3, -10)).toBe(768);
  });

  it('rejects empty scope identities and explicit GUID empties for memory applicability', () => {
    expect(() => ValidateScope({ UserId: '00000000-0000-0000-0000-000000000000' })).toThrow(Error);
    expect(() => ValidateScope({ UserId: '' })).toThrow(Error);
    expect(() => ValidateScope({ UserId: testGuid('user-1'), RepositoryId: '00000000-0000-0000-0000-000000000000' })).toThrow(Error);
  });

  it('builds bounded model context with summary coverage and paired tool calls', () => {
    const entries: readonly ContextEntry[] = [
      { EntryId: testGuid('e-1'), Sequence: 1, Role: ContextRole.User, CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('Old summary line') },
      { EntryId: testGuid('e-2'), Sequence: 2, Role: ContextRole.System, CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('System instruction') },
      { EntryId: testGuid('e-3'), Sequence: 3, Role: ContextRole.Assistant, CreatedAt: '2026-01-01T00:00:00Z', Content: new SummaryContent('Summary of older work', 2) },
      { EntryId: testGuid('e-4'), Sequence: 4, Role: ContextRole.User, CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('What changed?') },
      { EntryId: testGuid('e-5'), Sequence: 5, Role: ContextRole.Assistant, CreatedAt: '2026-01-01T00:00:00Z', Content: new ToolCallContent('call-1', 'lookup', '{"query":"alpha"}') },
      { EntryId: testGuid('e-6'), Sequence: 6, Role: ContextRole.Tool, CreatedAt: '2026-01-01T00:00:00Z', Content: new ToolResultContent('call-1', '{"result":"ok"}', false) },
    ];

    const memories: readonly ContextMemory[] = [{
      MemoryId: testGuid('m-1'),
      Scope: { UserId: testGuid('user-1') },
      Content: 'Memory record',
      Revision: 1,
      Status: 'Confirmed' as any,
      ExpiresAt: null,
      Sources: [],
    }];

    const model = BuildModelContext(entries, memories, 1024, (text) => text.length, 10);
    const ids = model.map((item) => item.EntryId ?? item.MemoryId);

    expect(ids).toContain(testGuid('e-2'));
    expect(ids).toContain(testGuid('m-1'));
    expect(ids).toContain(testGuid('e-3'));
    expect(ids).toContain(testGuid('e-5'));
    expect(ids).toContain(testGuid('e-6'));
    expect(ids).not.toContain(testGuid('e-1'));
  });
});
