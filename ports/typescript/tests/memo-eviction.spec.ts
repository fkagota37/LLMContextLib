// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { testGuid } from './test-guid.js';
import { expect, it } from 'vitest';
import { defaultBitFasterTermMemoOptions, WithBitFasterTermMemoization } from '../adapters/bitfaster/index.js';
import { ContextMutationStatus, ContextRole, SessionStatus, TextContent } from '../src/domain/session.js';
import { LLMContextFactory } from '../src/factory.js';

it('matches the pinned BitFaster eviction trace rather than ordinary LRU', () => {
  const maximumBytes = 9007199254740993n;
  const owner = WithBitFasterTermMemoization(LLMContextFactory.Create({
    EstimatedResidentByteBudget: maximumBytes + 65536n,
  }), {
    ...defaultBitFasterTermMemoOptions, Capacity: 3, MaximumEstimatedBytes: maximumBytes,
  }).Initialize([{
    SessionId: testGuid('session'), UserId: testGuid('user'), RepositoryId: null, Revision: 0,
    Status: SessionStatus.Active, Segments: new Map(), Anchors: new Map(),
  }]);

  try {
    expect(owner.GetStatistics().Execution?.EstimatedReservedBytes).toBe(maximumBytes + 512n);
    const observed = ['word2', 'word3', 'word0', 'word4', 'word2', 'word0', 'word0'].map((text, index) => {
      expect(owner.Apply({
        SessionId: testGuid('session'), ExpectedRevision: index, Changes: [{ kind: 'AppendEntries', Entries: [{
          EntryId: testGuid(`entry-${index}`), Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent(text),
        }] }],
      }).Status).toBe(ContextMutationStatus.Applied);
      const { MemoHits, MemoEntries } = owner.GetStatistics().Execution!;
      return [MemoHits, MemoEntries];
    });
    expect(observed).toEqual([[0, 1], [0, 2], [0, 3], [0, 3], [0, 3], [0, 3], [1, 3]]);
  } finally {
    owner.dispose();
  }
});
