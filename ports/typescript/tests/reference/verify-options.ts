// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultContextExecutionOptions } from '../../src/execution/strategy.js';
import { defaultDeferredIndexingOptions, defaultLLMContextOptions, WriteOptimized } from '../../src/options.js';
import { defaultPartitionedContextIndexOptions } from '../../src/storage/partitioned-index.js';

const skip = new Set(['TimeProvider', 'EntrySizeEstimator', 'ProjectionSizeEstimator', 'Execution']);
const coreSnapshot = (options: typeof defaultLLMContextOptions) =>
  Object.fromEntries(Object.entries(options).filter(([key]) => !skip.has(key)));

const expected = JSON.parse(readFileSync(0, 'utf8'));
assert.deepEqual({
  Core: coreSnapshot(defaultLLMContextOptions),
  WriteOptimized: coreSnapshot(WriteOptimized),
  Deferred: defaultDeferredIndexingOptions,
  Partitioned: defaultPartitionedContextIndexOptions,
  Execution: defaultContextExecutionOptions,
}, expected);
console.log('Matched scalar defaults and nested limits across five option profiles.');
