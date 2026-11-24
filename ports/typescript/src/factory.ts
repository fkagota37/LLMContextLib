// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextIndexingMode } from './domain/index-keys.js';
import { ContextError } from './domain/errors.js';
import { checkedInt64, isPositiveInt64, type Int64 } from './domain/int64.js';
import type { Guid, LLMSessionContext } from './domain/session.js';
import type { ILLMContextPolymorphicArray, ILLMContextViewDefinition, ILLMContextView } from './domain/reads.js';
import { defaultLLMContextOptions, type LLMContextOptions, validateLLMContextOptions } from './options.js';
import { ContextExecutionRecipe, type ContextExecutionOptions, defaultContextExecutionOptions, nativeCollector } from './execution/strategy.js';
import { defaultPartitionedContextIndexOptions, freezePartitionedContextIndexOptions } from './storage/partitioned-index.js';
import { LLMContextOwner } from './storage/owner.js';
import { ContextReadLease } from './storage/lease.js';
import { withCurrentRead } from './runtime/current-read.js';
import type { WorkerContextEndpoint, WorkerContextEndpointOptions } from './runtime/worker-context-peer.js';

export const configureExecutionProviders = Symbol('configureExecutionProviders');

const clients = new WeakMap<ILLMContextPolymorphicArray, LLMContextOwner>();

class ContextView<T> implements ILLMContextView<T> {
  constructor(
    private lease: ContextReadLease | null,
    private values: readonly T[],
    private releaseOutput: (() => void) | null,
  ) {}

  private get read(): ContextReadLease {
    if (!this.lease) throw new ContextError('Disposed', 'This context view has been disposed.');
    return this.lease;
  }

  get SessionRevision(): Int64 { return this.read.Session.Revision; }
  get MemoryRevision(): Int64 { return this.read.MemoryRevision; }
  get length(): number { this.read; return this.values.length; }

  public at(index: number): T {
    const length = this.length;
    if (!Number.isInteger(index) || index < 0 || index >= length) {
      throw new RangeError('Context view index is out of range.');
    }
    return this.values[index];
  }

  public *[Symbol.iterator](): Iterator<T> {
    for (let index = 0; index < this.length; index++) yield this.values[index];
  }

  public dispose(): void {
    const lease = this.lease;
    if (!lease) return;
    this.lease = null;
    this.values = [];
    try { this.releaseOutput?.(); }
    finally {
      this.releaseOutput = null;
      lease.dispose();
    }
  }
}

/**
 * Builder for the owning client boundary. The port preserves the C# invariant that workers share
 * one owner and never receive a mutable top-level session array or writable storage handle.
 */
export class LLMContextFactoryBuilder {
  private readonly options: LLMContextOptions;

  constructor(
    options: LLMContextOptions = defaultLLMContextOptions,
    private readonly sessionIdSelector: (session: LLMSessionContext) => Guid = (session) => session.SessionId,
    private readonly recipe?: ContextExecutionRecipe,
  ) {
    validateLLMContextOptions(options);
    recipe?.Validate(options);
    this.options = Object.freeze({
      ...options,
      DeferredIndexing: options.DeferredIndexing && Object.freeze({ ...options.DeferredIndexing }),
      PartitionedIndex: options.PartitionedIndex && freezePartitionedContextIndexOptions(options.PartitionedIndex),
      Execution: Object.freeze({ ...options.Execution }),
    });
  }

  WithExecutionStrategies(execution: Partial<ContextExecutionOptions> = {}): LLMContextFactoryBuilder {
    if (execution === null) throw new TypeError('Execution options are required.');
    return new LLMContextFactoryBuilder({
      ...this.options,
      Execution: {
        ...defaultContextExecutionOptions,
        ...execution,
      },
    }, this.sessionIdSelector, this.recipe ?? new ContextExecutionRecipe());
  }

  WithNativeTermCollection(): LLMContextFactoryBuilder {
    return this[configureExecutionProviders](new ContextExecutionRecipe(nativeCollector, false, this.recipe?.Memo, this.recipe?.MemoReservation));
  }

  WithProducerOwnedIndexing(): LLMContextFactoryBuilder {
    return new LLMContextFactoryBuilder({
      ...this.options,
      IndexingMode: ContextIndexingMode.ProducerOwned,
    }, this.sessionIdSelector, this.recipe);
  }

  WithPartitionedIndexing(partitions: typeof defaultPartitionedContextIndexOptions | null = null): LLMContextFactoryBuilder {
    return new LLMContextFactoryBuilder({
      ...this.options,
      IndexingMode: ContextIndexingMode.ProducerOwned,
      PartitionedIndex: partitions ?? defaultPartitionedContextIndexOptions,
    }, this.sessionIdSelector, this.recipe);
  }

  WithoutTermMemoization(): LLMContextFactoryBuilder {
    return this[configureExecutionProviders](new ContextExecutionRecipe(this.recipe?.Collector, this.recipe?.HasCustomCollector));
  }

  [configureExecutionProviders](replacement: ContextExecutionRecipe | ((recipe: ContextExecutionRecipe) => ContextExecutionRecipe)): LLMContextFactoryBuilder {
    const recipe = typeof replacement === 'function' ? replacement(this.recipe ?? new ContextExecutionRecipe()) : replacement;
    return new LLMContextFactoryBuilder(this.options, this.sessionIdSelector, recipe);
  }

  /**
   * Initialize loads the complete immutable session graph before the owner becomes usable.
   * A partial or invalid graph must fail the whole initialization and cleanly abandon the owner.
   */
  Initialize(sessions: Iterable<LLMSessionContext>): ILLMContextPolymorphicArray {
    const owner = new LLMContextOwner(this.options, this.sessionIdSelector, this.recipe);
    try { owner.initialize(sessions); }
    catch (error) {
      owner.dispose();
      throw error;
    }

    const client: ILLMContextPolymorphicArray = {
      TryFind: (sessionId) => owner.tryFindSession(sessionId),
      CreateSession: (session) => owner.createSession(session),
      RemoveSession: (sessionId, expectedRevision) => owner.removeSession(sessionId, expectedRevision),
      Apply: (changes) => owner.applySession(changes),
      ApplyMemory: (changes) => owner.applyMemory(changes),
      OpenRead: (sessionId) => owner.openRead(sessionId),
      WithCurrent: (sessionId, consume) => withCurrentRead(() => owner.openRead(sessionId), consume),
      OpenView: <T>(definition: ILLMContextViewDefinition<T>): ILLMContextView<T> => {
        const limit = definition.MaximumResults;
        if (!Number.isSafeInteger(limit) || limit < 0 || limit > this.options.MaximumViewResults) {
          throw new RangeError('Invalid maximum view results.');
        }
        const lease = owner.openRead(definition.SessionId);
        try {
          const evaluated = definition.Evaluate(lease);
          if (evaluated == null || typeof evaluated[Symbol.iterator] !== 'function') {
            throw new TypeError('View evaluation must return an iterable.');
          }
          const values: T[] = [];
          if (limit > 0) {
            for (const item of evaluated) {
              values.push(item);
              if (values.length === limit) break;
            }
          }
          let bytes = 0n;
          for (const item of values) {
            const estimate = this.options.ProjectionSizeEstimator(item);
            if (!isPositiveInt64(estimate)) {
              throw new TypeError('Invalid projection size estimate.');
            }
            bytes = checkedInt64(bytes + BigInt(estimate));
          }
          return new ContextView(lease, values, owner.retainOutput(bytes));
        } catch (error) {
          lease.dispose();
          throw error;
        }
      },
      WaitForIndexingAsync: (sessionId, expectedRevision, signal) => owner.waitForIndexingAsync(sessionId, expectedRevision, signal),
      SynchronizeIndexAsync: (sessionId, signal) => owner.synchronizeIndexAsync(sessionId, signal),
      GetStatistics: () => owner.getStatistics(),
      dispose: () => owner.dispose(),
    };
    clients.set(client, owner);
    return client;
  }
}

export class LLMContextFactory {
  static CreateWorkerEndpoint(client: ILLMContextPolymorphicArray, options?: WorkerContextEndpointOptions): WorkerContextEndpoint {
    const owner = clients.get(client);
    if (!owner) throw new ContextError('NotSupported', 'A worker endpoint requires an owning native context client.');
    return owner.connectWorker(options?.AllowWorkerProjectionEstimator === true);
  }

  static Create(options: Partial<LLMContextOptions> | null = null,
    sessionIdSelector?: ((session: LLMSessionContext) => Guid) | null): LLMContextFactoryBuilder {
    if (sessionIdSelector != null && typeof sessionIdSelector !== 'function') throw new TypeError('Session selector must be a function.');
    const selected: LLMContextOptions = {
      ...defaultLLMContextOptions,
      ...options,
      Execution: {
        ...defaultContextExecutionOptions,
        ...defaultLLMContextOptions.Execution,
        ...(options?.Execution ?? {}),
      },
    };
    const execution = selected.Execution;
    const configured = execution.Indexing !== defaultContextExecutionOptions.Indexing ||
      execution.Preparation !== defaultContextExecutionOptions.Preparation ||
      execution.MinimumDeferredCharacters !== defaultContextExecutionOptions.MinimumDeferredCharacters;
    return new LLMContextFactoryBuilder(selected, sessionIdSelector ?? undefined,
      configured ? new ContextExecutionRecipe() : undefined);
  }
}
