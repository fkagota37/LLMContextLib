// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { describe, expect, it } from 'vitest';
import { TextContent, type ContextEntry } from '../src/domain/session.js';
import { estimateActiveByteRange, estimateProjectionBytes } from '../src/policies/estimation.js';
import { filterExactTextMatches, orderSearchMatches } from '../src/policies/search.js';
import { canonicalizeSearchText, lexCompareText, truncateForSnippet } from '../src/policies/text.js';

const entries: readonly ContextEntry[] = [
  {
    EntryId: 'entry-2',
    Sequence: 2,
    Role: 'User' as any,
    CreatedAt: '2026-01-01T00:00:00Z',
    Content: new TextContent('Alpha feature discussion'),
    IndexKeys: ['feature', 'alpha'],
  },
  {
    EntryId: 'entry-1',
    Sequence: 1,
    Role: 'Assistant' as any,
    CreatedAt: '2026-01-01T00:00:00Z',
    Content: new TextContent('Beta release summary'),
    IndexKeys: ['beta'],
  },
];

describe('Runtime policy contracts', () => {
  it('trims search text and maintains lexical order for deterministic comparisons', () => {
    expect(canonicalizeSearchText('  alpha  ')).toBe('alpha');
    expect(lexCompareText('alpha', 'beta')).toBeLessThan(0);
    expect(truncateForSnippet('a'.repeat(200), 120).length).toBeLessThanOrEqual(120);
  });

  it('filters exact text matches without silently modifying the query semantics', () => {
    const matches = filterExactTextMatches(entries, 'alpha', 10);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.EntryId).toBe('entry-2');
    expect(orderSearchMatches(matches)[0]?.Sequence).toBe(2);
  });

  it('keeps projection estimation conservative and integer-safe for bounded runtime accounting', () => {
    expect(estimateProjectionBytes([1, 2, 3], (value) => Number(value) * 2)).toBe(12);
    expect(estimateActiveByteRange(2, 3, 10)).toBe(2048 + 768 + 640);
  });
});
