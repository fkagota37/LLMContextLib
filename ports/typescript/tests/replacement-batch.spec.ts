// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { testGuid } from './test-guid.js';
import { expect, it } from 'vitest';
import { LLMContextFactory } from '../src/factory.js';
import { ContextMutationStatus, ContextRole, SessionStatus, TextContent } from '../src/domain/session.js';

it('copies each touched segment once while validating intermediate replacements in command order', () => {
  const seen: string[] = [];
  const entry = (label: string, Sequence: number, text: string) => ({
    EntryId: testGuid(label), Sequence, Role: ContextRole.User,
    CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent(text),
  });
  const replace = (label: string, text: string) => ({ kind: 'ReplaceEntry' as const, EntryId: testGuid(label), Content: new TextContent(text) });
  const client = LLMContextFactory.Create({
    MaximumEstimatedBytesPerSegment: 300,
    EntrySizeEstimator: ({ Content }) => {
      const { Text } = Content as TextContent;
      seen.push(Text);
      return Text === 'oversized' ? 301 : 128 + Text.length;
    },
  }).Initialize([{
    SessionId: testGuid('session'), UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
    Segments: new Map([
      [0, { SegmentId: 0, Revision: 0, Entries: [entry('a', 0, 'old'), entry('b', 1, 'neighbor')] }],
      [1, { SegmentId: 1, Revision: 0, Entries: [entry('c', 2, 'untouched')] }],
    ]),
    Anchors: new Map(),
  }]);

  const old = client.OpenRead(testGuid('session'));
  try {
    const stats = client.GetStatistics();
    seen.length = 0;
    const apply = (...Changes: ReturnType<typeof replace>[]) =>
      client.Apply({ SessionId: testGuid('session'), ExpectedRevision: 0, Changes });
    expect(apply(replace('a', 'oversized'), replace('a', 'small')).Status).toBe(ContextMutationStatus.InvalidOperation);
    expect(client.GetStatistics()).toEqual(stats);
    seen.length = 0;
    expect(apply(replace('a', 'first'), replace('a', 'last')).Status).toBe(ContextMutationStatus.Applied);
    expect(seen).toEqual(['first', 'old', 'last', 'first']);
    expect(BigInt(client.GetStatistics().SegmentsRewritten)).toBe(BigInt(stats.SegmentsRewritten) + 1n);
    client.WithCurrent(testGuid('session'), (read) => {
      expect(read.Session.Segments.get(1)).toBe(old.Session.Segments.get(1));
      expect(read.TryFindEntry(testGuid('b'))).toBe(old.TryFindEntry(testGuid('b')));
      expect(read.Search('first', 10)).toEqual([]);
      expect(read.Search('last', 10)).toHaveLength(1);
    });
    expect(old.Search('old', 10)).toHaveLength(1);
  } finally {
    old.dispose();
    client.dispose();
  }
});
