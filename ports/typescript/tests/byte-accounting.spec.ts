// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { testGuid } from './test-guid.js';
import { expect, it } from 'vitest';
import { ContextMutationStatus, ContextRole, SessionStatus, TextContent } from '../src/domain/session.js';
import { LLMContextFactory } from '../src/factory.js';
import { defaultDeferredIndexingOptions } from '../src/options.js';
import { defaultPartitionedContextIndexOptions } from '../src/storage/partitioned-index.js';
import { ContextViews } from '../src/views.js';

const maximum = (1n << 63n) - 1n;
const large = 9007199254740993n;
const session = {
  SessionId: testGuid('session'), UserId: testGuid('user'), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
  Segments: new Map([[0, {
    SegmentId: 0, Revision: 0, Entries: [{
      EntryId: testGuid('entry'), Sequence: 0, Role: ContextRole.User,
      CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('original'),
    }],
  }]]), Anchors: new Map(),
};

it('preserves exact large estimates through mutation, retention, projection and release', () => {
  const owner = LLMContextFactory.Create({
    EstimatedResidentByteBudget: maximum,
    MaximumEstimatedRetainedBytes: maximum,
    MaximumEstimatedBytesPerSegment: maximum,
    EntrySizeEstimator: ({ Content }) => (Content as TextContent).Text === 'overflow' ? maximum : large,
    ProjectionSizeEstimator: () => large,
  }).Initialize([session]);
  try {
    expect(typeof owner.GetStatistics().EstimatedActiveBytes).toBe('bigint');
    const replace = (text: string) => owner.Apply({
      SessionId: testGuid('session'), ExpectedRevision: 0,
      Changes: [{ kind: 'ReplaceEntry', EntryId: testGuid('entry'), Content: new TextContent(text) }],
    });
    const before = owner.GetStatistics();
    expect(replace('overflow').Status).toBe(ContextMutationStatus.InvalidOperation);
    expect(owner.GetStatistics()).toEqual(before);
    expect(replace('updated').Status).toBe(ContextMutationStatus.Applied);
    expect(owner.GetStatistics().EstimatedSegmentBytesRewritten).toBe(large);

    const read = owner.OpenRead(testGuid('session'));
    try {
      expect(() => read.ReadRange(0, 0x8000_0000)).toThrow(RangeError);
      expect(() => read.Search('updated', 0x8000_0000)).toThrow(RangeError);
      expect(() => (read.ReadRange(0, 1) as unknown[]).pop()).toThrow(TypeError);
      const hit = read.Search('updated', 1)[0];
      expect(Reflect.set(hit, 'Snippet', 'forged')).toBe(false);
      expect(hit.Snippet).toBe('updated');
      const retained = BigInt(owner.GetStatistics().EstimatedRetainedBytes);
      expect(retained > large).toBe(true);
      const view = owner.OpenView(ContextViews.Timeline(testGuid('session')));
      try {
        expect(owner.GetStatistics()).toMatchObject({
          EstimatedRetainedBytes: retained + large, EstimatedViewBytes: large, RetainedReads: 2,
        });
      } finally {
        view.dispose();
      }
      expect(owner.GetStatistics()).toMatchObject({ EstimatedRetainedBytes: retained, EstimatedViewBytes: 0 });
    } finally {
      read.dispose();
    }
    expect(owner.GetStatistics()).toMatchObject({ EstimatedRetainedBytes: 0, EstimatedViewBytes: 0, RetainedReads: 0 });
  } finally {
    owner.dispose();
  }
});

it('compares resident budgets exactly at neighboring values above Number.MAX_SAFE_INTEGER', () => {
  const options = { MaximumEstimatedBytesPerSegment: maximum, EntrySizeEstimator: () => large };
  const measure = LLMContextFactory.Create({ ...options, EstimatedResidentByteBudget: maximum }).Initialize([session]);
  const bytes = BigInt(measure.GetStatistics().EstimatedActiveBytes);
  measure.dispose();

  const enough = LLMContextFactory.Create({ ...options, EstimatedResidentByteBudget: bytes }).Initialize([]);
  const short = LLMContextFactory.Create({ ...options, EstimatedResidentByteBudget: bytes - 1n }).Initialize([]);
  try {
    expect(enough.CreateSession(session).Status).toBe(ContextMutationStatus.Applied);
    expect(short.CreateSession(session).Status).toBe(ContextMutationStatus.AdmissionRejected);
    expect(short.GetStatistics()).toMatchObject({ Sessions: 0, EstimatedActiveBytes: 0 });
  } finally {
    enough.dispose();
    short.dispose();
  }
});

it('preserves wide indexing budgets and rejects partition recovery reserve overflow', async () => {
  const options = { EstimatedResidentByteBudget: maximum };
  const partitions = {
    ...defaultPartitionedContextIndexOptions,
    MaximumEstimatedPartitionBytes: large,
    MaximumEstimatedWorkingSetBytes: large,
    MaximumEstimatedPreparationBytes: large,
  };
  const partitioned = LLMContextFactory.Create(options).WithPartitionedIndexing(partitions).Initialize([]);
  try {
    expect(partitioned.GetStatistics().EstimatedSynchronizationReserveBytes).toBe(2n * large);
    expect(() => LLMContextFactory.Create(options).WithPartitionedIndexing({
      ...partitions, MaximumEstimatedPartitionBytes: maximum,
    })).toThrow(RangeError);
  } finally {
    partitioned.dispose();
  }
  const deferred = LLMContextFactory.Create({
    ...options,
    DeferredIndexing: { ...defaultDeferredIndexingOptions, ForegroundCharacters: 3, MaximumEstimatedWorkBytes: maximum },
  }).Initialize([session]);
  try {
    expect(deferred.GetStatistics().PendingIndexWork).toBe(1);
    await deferred.WaitForIndexingAsync(testGuid('session'), 0);
    expect(deferred.GetStatistics().PendingIndexWork).toBe(0);
  } finally {
    deferred.dispose();
  }
});
