// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { testGuid } from './test-guid.js';
import { describe, expect, it } from 'vitest';
import { ContextRole, SummaryContent, TextContent, ToolCallContent, ToolResultContent, type ContextEntry, type ContextMemory } from '../src/domain/session.js';
import { BuildModelContext, Terms, ValidateScope } from '../src/policies/context.js';
import { LLMContextFactory } from '../src/factory.js';
import { defaultDeferredIndexingOptions, defaultLLMContextOptions } from '../src/options.js';
import { defaultPartitionedContextIndexOptions } from '../src/storage/partitioned-index.js';
import { estimateActiveByteRange, estimateProjectionBytes } from '../src/policies/estimation.js';
import { filterExactTextMatches, orderSearchMatches } from '../src/policies/search.js';
import { canonicalizeSearchText, lexCompareText, truncateForSnippet } from '../src/policies/text.js';

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
