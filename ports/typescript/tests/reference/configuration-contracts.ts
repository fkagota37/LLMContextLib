// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { WithBitFasterTermMemoization, defaultBitFasterTermMemoOptions } from '../../adapters/bitfaster/index.js';
import { WithLuceneTermCollection, LuceneTermCollection } from '../../adapters/lucene/index.js';
import { LLMContextFactory } from '../../src/factory.js';
import { ContextIndexingMode } from '../../src/domain/index-keys.js';
import { ContextIndexingStrategy, ContextPreparationStrategy } from '../../src/execution/strategy.js';
import { defaultDeferredIndexingOptions } from '../../src/options.js';
import { defaultPartitionedContextIndexOptions, ContextSynchronizationWriteBehavior } from '../../src/storage/partitioned-index.js';

export function configurationContracts() {
  const rows: object[] = [];
  const check = (label: string, action: () => unknown) => {
    let outcome = 'ok';
    try { action(); } catch (error) {
      if (error instanceof RangeError) outcome = /overflow/i.test(error.message) ? 'Overflow' : 'Range';
      else if (error instanceof TypeError) outcome = 'Argument';
      else throw error;
    }
    rows.push({ label, outcome });
  };
  for (const field of ['ForegroundWords', 'ForegroundCharacters', 'MaximumPendingEntries', 'MaximumEstimatedWorkBytes']) {
    for (const value of [-1, 0, 1, 2147483647]) check(`deferred/${field}/${value}`,
      () => LLMContextFactory.Create({ DeferredIndexing: { ...defaultDeferredIndexingOptions, [field]: value } }));
  }
  for (const field of ['MaximumEstimatedPartitionBytes', 'MaximumWorkingSetEntries', 'MaximumEstimatedWorkingSetBytes',
    'MaximumPendingSynchronizations', 'MaximumEstimatedPreparationBytes']) {
    for (const value of [-1, 0, 1, 2147483647, 9223372036854775807n]) {
      if (['MaximumWorkingSetEntries', 'MaximumPendingSynchronizations'].includes(field) && typeof value === 'bigint') continue;
      check(`partition/${field}/${value}`, () => LLMContextFactory.Create({
        IndexingMode: ContextIndexingMode.ProducerOwned,
        PartitionedIndex: { ...defaultPartitionedContextIndexOptions, [field]: value }, EstimatedResidentByteBudget: 9223372036854775807n,
      }));
    }
  }
  check('partition/unknown-behavior', () => LLMContextFactory.Create().WithPartitionedIndexing({
    ...defaultPartitionedContextIndexOptions, WriteBehavior: 'Unknown' as ContextSynchronizationWriteBehavior,
  }));
  for (const value of [-1, 0, .0001, 2147483647, 2147483648]) {
    check(`partition/timeout/${value}`, () => LLMContextFactory.Create().WithPartitionedIndexing({
      ...defaultPartitionedContextIndexOptions, SynchronizationWaitTimeoutMs: value,
    }));
  }
  for (const value of [-1, 0, 1, 2147483647]) check(`execution/threshold/${value}`,
    () => LLMContextFactory.Create().WithExecutionStrategies({ MinimumDeferredCharacters: value }));
  check('execution/null', () => LLMContextFactory.Create().WithExecutionStrategies(null!));
  check('execution/unknown-indexing', () => LLMContextFactory.Create().WithExecutionStrategies({ Indexing: 'Unknown' as ContextIndexingStrategy }));
  check('execution/unknown-preparation', () => LLMContextFactory.Create().WithExecutionStrategies({ Preparation: 'Unknown' as ContextPreparationStrategy }));
  check('execution/append-without-deferred', () => LLMContextFactory.Create().WithExecutionStrategies({ Indexing: ContextIndexingStrategy.AppendOptimized }));
  check('execution/synchronous-deferred', () => LLMContextFactory.Create({ DeferredIndexing: defaultDeferredIndexingOptions })
    .WithExecutionStrategies({ Indexing: ContextIndexingStrategy.Synchronous }).Initialize([]).dispose());
  for (const field of ['Capacity', 'MaximumTextCharacters', 'MaximumEstimatedBytes']) {
    for (const value of [-1, 0, 1, 3, 8192, 2147483647, 9223372036854775807n]) {
      if (field !== 'MaximumEstimatedBytes' && typeof value === 'bigint') continue;
      check(`memo/${field}/${value}`, () => WithBitFasterTermMemoization(
        LLMContextFactory.Create({ EstimatedResidentByteBudget: 9223372036854775807n }), { ...defaultBitFasterTermMemoOptions, [field]: value }));
    }
  }
  check('lucene/unknown', () => WithLuceneTermCollection(LLMContextFactory.Create(), 'Unknown' as LuceneTermCollection));
  check('lucene/null-builder', () => WithLuceneTermCollection(null!));
  check('memo/null-builder', () => WithBitFasterTermMemoization(null!));
  check('producer/collector', () => WithLuceneTermCollection(LLMContextFactory.Create()).WithProducerOwnedIndexing());
  check('producer/memo', () => WithBitFasterTermMemoization(LLMContextFactory.Create()).WithProducerOwnedIndexing());
  const owner = LLMContextFactory.Create().WithExecutionStrategies({ Preparation: ContextPreparationStrategy.Serialized })
    .WithExecutionStrategies({ Indexing: ContextIndexingStrategy.Synchronous }).Initialize([]);
  try {
    rows.push({ label: 'execution/replacement-recipe', preparation: owner.GetStatistics().Execution!.Preparation,
      indexing: owner.GetStatistics().Execution!.Indexing });
  } finally { owner.dispose(); }
  return { reference: '479d2612315cbd292da917bae6d8d3fec35fea24', rows };
}
