// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextIndexingMode } from './domain/index-keys.js';
import { SessionStatus, type Guid, type LLMSessionContext } from './domain/session.js';
import type { ILLMContextPolymorphicArray, ILLMContextViewDefinition, ILLMContextView } from './domain/reads.js';
import { defaultLLMContextOptions, type LLMContextOptions, validateLLMContextOptions } from './options.js';
import { LLMContextOwner } from './storage/owner.js';
import { ContextReadLease } from './storage/lease.js';

class SimpleContextView<T> implements ILLMContextView<T> {
  private readonly values: readonly T[];

  constructor(sessionId: Guid, lease: ContextReadLease, definition: ILLMContextViewDefinition<T>) {
    const evaluated = Array.from(definition.Evaluate(lease));
    this.values = evaluated;
    this.SessionRevision = lease.Session.Revision;
    this.MemoryRevision = lease.MemoryRevision;
    this.SessionId = sessionId;
  }

  public readonly SessionId: Guid;
  public readonly SessionRevision: number;
  public readonly MemoryRevision: number;

  public at(index: number): T {
    return this.values[index];
  }

  public [Symbol.iterator](): Iterator<T> {
    return this.values[Symbol.iterator]();
  }

  public get length(): number {
    return this.values.length;
  }

  public dispose(): void {
    // The bootstrap view captures a read-only slice and releases immediately when it drops.
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public static create<T>(sessionId: Guid, lease: ContextReadLease, definition: ILLMContextViewDefinition<T>): SimpleContextView<T> {
    return new SimpleContextView(sessionId, lease, definition);
  }
}

/**
 * Builder for the owning client boundary. The port preserves the C# invariant that workers share
 * one owner and never receive a mutable top-level session array or writable storage handle.
 */
export class LLMContextFactoryBuilder {
  constructor(
    private readonly options: LLMContextOptions = defaultLLMContextOptions,
    private readonly sessionIdSelector: (session: LLMSessionContext) => Guid = (session) => session.SessionId,
  ) {
    validateLLMContextOptions(options);
  }

  WithExecutionStrategies(): LLMContextFactoryBuilder {
    return this;
  }

  WithNativeTermCollection(): LLMContextFactoryBuilder {
    return this;
  }

  WithProducerOwnedIndexing(): LLMContextFactoryBuilder {
    return new LLMContextFactoryBuilder({
      ...this.options,
      IndexingMode: ContextIndexingMode.ProducerOwned,
    }, this.sessionIdSelector);
  }

  WithPartitionedIndexing(): LLMContextFactoryBuilder {
    return new LLMContextFactoryBuilder({
      ...this.options,
      IndexingMode: ContextIndexingMode.ProducerOwned,
      PartitionedIndex: this.options.PartitionedIndex ?? { InfrastructureBytes: 1024, RecoveryBytes: 1024 },
    }, this.sessionIdSelector);
  }

  WithoutTermMemoization(): LLMContextFactoryBuilder {
    return this;
  }

  /**
   * Initialize loads the complete immutable session graph before the owner becomes usable.
   * A partial or invalid graph must fail the whole initialization and cleanly abandon the owner.
   */
  Initialize(sessions: readonly LLMSessionContext[]): ILLMContextPolymorphicArray {
    for (const session of sessions) {
      if (this.sessionIdSelector(session) !== session.SessionId) {
        throw new Error('Session identity selector must preserve each canonical SessionId.');
      }
    }

    const owner = new LLMContextOwner();
    owner.initialize(sessions);

    return {
      TryFind: (sessionId) => {
        const found = owner.tryFindSession(sessionId);
        return found ? { SessionId: found.SessionId, Revision: found.Revision } : null;
      },
      CreateSession: (session) => {
        const result = owner.createSession({
          ...session,
          SessionId: session.SessionId,
          UserId: session.SessionId,
          RepositoryId: null,
          Revision: session.Revision,
          Status: SessionStatus.Active,
          Segments: new Map(),
          Anchors: new Map(),
        });
        return { Status: result.Status, Revision: result.Revision };
      },
      RemoveSession: (sessionId, expectedRevision) => {
        const result = owner.removeSession(sessionId, expectedRevision);
        return { Status: result.Status, Revision: result.Revision };
      },
      Apply: (changes) => {
        const result = owner.applySession({
          SessionId: changes.SessionId,
          ExpectedRevision: changes.ExpectedRevision,
          Changes: changes.Changes as any,
        });
        return { Status: result.Status, Revision: result.Revision };
      },
      ApplyMemory: (changes) => {
        const result = owner.applyMemory({
          ExpectedRevision: changes.ExpectedRevision,
          Upserts: changes.Upserts,
          Deletes: changes.Deletes,
        });
        return { Status: result.Status, Revision: result.Revision };
      },
      OpenRead: (sessionId) => owner.openRead(sessionId),
      OpenView: <T>(definition: ILLMContextViewDefinition<T>): ILLMContextView<T> => {
        const lease = owner.openRead(definition.SessionId);
        const values: T[] = [];
        for (const item of definition.Evaluate(lease)) {
          values.push(item);
          if (values.length >= definition.MaximumResults) {
            break;
          }
        }
        return {
          SessionRevision: lease.Session.Revision,
          MemoryRevision: lease.MemoryRevision,
          length: values.length,
          at: (index: number) => values[index],
          [Symbol.iterator]: () => values[Symbol.iterator](),
          dispose: () => lease.dispose(),
        };
      },
      GetStatistics: () => owner.getStatistics(),
      dispose: () => owner.dispose(),
    };
  }
}

export class LLMContextFactory {
  static Create(options: Partial<LLMContextOptions> = {}, sessionIdSelector?: (session: LLMSessionContext) => Guid): LLMContextFactoryBuilder {
    const selected: LLMContextOptions = {
      ...defaultLLMContextOptions,
      ...options,
    };
    validateLLMContextOptions(selected);
    return new LLMContextFactoryBuilder(selected, sessionIdSelector ?? ((session) => session.SessionId));
  }
}
