// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { ILLMContextViewDefinition } from './domain/reads.js';
import type { ContextIndexKeys } from './domain/index-keys.js';
import type { Int64 } from './domain/int64.js';
import type { ContextEntry, ContextMemory, ContextSearchHit, MemoryScope, ModelContextItem, Guid, AnchorResolution } from './domain/session.js';
import { ContextRole, TextContent, ToolCallContent, ToolResultContent } from './domain/session.js';
import { Entries, BuildModelContext } from './policies/context.js';

const definition = <T>(SessionId: Guid, MaximumResults: number,
  Evaluate: ILLMContextViewDefinition<T>['Evaluate']): ILLMContextViewDefinition<T> =>
  Object.freeze({ SessionId, MaximumResults, Evaluate });
const copyScopes = (scopes: readonly MemoryScope[]): readonly MemoryScope[] =>
  Array.isArray(scopes) ? Object.freeze(scopes.map((scope) => scope && Object.freeze({ ...scope }))) : scopes;

export const ContextViews = {
  Timeline(sessionId: Guid, fromSequence: Int64 = 0, limit = 64): ILLMContextViewDefinition<ContextEntry> {
    return definition(sessionId, limit, (read) => read.ReadRange(fromSequence, limit));
  },

  Conversation(sessionId: Guid, limit = 64): ILLMContextViewDefinition<ContextEntry> {
    return definition(sessionId, limit, function* (read) {
      for (const entry of Entries(read.Session)) {
        if ((entry.Role === ContextRole.User || entry.Role === ContextRole.Assistant) && entry.Content instanceof TextContent) yield entry;
      }
    });
  },

  Tool(sessionId: Guid, callId: string, limit = 64): ILLMContextViewDefinition<ContextEntry> {
    return definition(sessionId, limit, function* (read) {
      for (const entry of Entries(read.Session)) {
        const content = entry.Content;
        if ((content instanceof ToolCallContent || content instanceof ToolResultContent) && content.CallId === callId) yield entry;
      }
    });
  },

  Navigation(sessionId: Guid, limit = 64): ILLMContextViewDefinition<AnchorResolution> {
    return definition(sessionId, limit, function* (read) {
      for (const id of [...read.Session.Anchors.keys()].sort()) yield read.ResolveAnchor(id);
    });
  },

  Search(sessionId: Guid, query: string, limit = 64): ILLMContextViewDefinition<ContextSearchHit> {
    return definition(sessionId, limit, (read) => read.Search(query, limit));
  },

  SearchKeys(sessionId: Guid, keys: ContextIndexKeys | readonly string[], limit = 64): ILLMContextViewDefinition<ContextSearchHit> {
    const captured = Array.isArray(keys) ? Object.freeze([...keys]) : keys;
    return definition(sessionId, limit, (read) => read.SearchKeys(captured, limit));
  },

  Memory(sessionId: Guid, scopes: readonly MemoryScope[], limit = 64): ILLMContextViewDefinition<ContextMemory> {
    const captured = copyScopes(scopes);
    return definition(sessionId, limit, (read) => read.GetApplicableMemory(captured));
  },

  Model(
    sessionId: Guid,
    tokenBudget: number,
    estimateTokens: (text: string) => number,
    scopes: readonly MemoryScope[] = [],
    limit = 1024,
  ): ILLMContextViewDefinition<ModelContextItem> {
    const captured = copyScopes(scopes);
    return definition(sessionId, limit, (read) => BuildModelContext(
      Entries(read.Session), read.GetApplicableMemory(captured), tokenBudget, estimateTokens, limit,
    ));
  },

  Project<T>(
    sessionId: Guid,
    predicate: (entry: ContextEntry) => boolean,
    projection: (entry: ContextEntry) => T,
    limit = 64,
  ): ILLMContextViewDefinition<T> {
    if (typeof predicate !== 'function' || typeof projection !== 'function') throw new TypeError('Projection callbacks are required.');
    return definition(sessionId, limit, function* (read) {
      for (const entry of Entries(read.Session)) if (predicate(entry)) yield projection(entry);
    });
  },
};

export default ContextViews;
