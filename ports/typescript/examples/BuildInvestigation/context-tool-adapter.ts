// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { Int64 } from '../../src/domain/int64.js';
import type { ILLMContextPolymorphicArray, ILLMContextViewDefinition } from '../../src/domain/reads.js';
import type { Guid, MemoryScope } from '../../src/domain/session.js';
import { Text } from '../../src/policies/context.js';
import { ContextViews } from '../../src/views.js';

const guidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const asGuid = (value: unknown): Guid => {
  if (typeof value !== 'string' || !guidPattern.test(value)) throw new TypeError('Expected a GUID.');
  return value.toLowerCase();
};

function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return (JSON as typeof JSON & { rawJSON(value: string): unknown }).rawJSON(value.toString());
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key[0].toLowerCase() + key.slice(1), jsonValue(child)]));
  }
  return value;
}

export class ContextToolAdapter {
  private readonly allowedSessions: ReadonlySet<Guid>;

  constructor(private readonly contexts: ILLMContextPolymorphicArray, ...allowedSessions: Guid[]) {
    this.allowedSessions = new Set(allowedSessions.map(asGuid));
  }

  Execute(name: string, args: Readonly<Record<string, unknown>>): string {
    const sessionId = asGuid(args.sessionId);
    if (!this.allowedSessions.has(sessionId)) throw new Error('Session unavailable to this caller.');
    const limit = args.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 32) {
      throw new RangeError('Limit must be an integer from 1 through 32.');
    }

    if (name === 'context_read_anchor') return this.readAnchor(sessionId, asGuid(args.anchorId), limit);
    if (name !== 'context_view') throw new TypeError('Unknown tool.');
    switch (args.view) {
      case 'navigation':
        return this.view(ContextViews.Navigation(sessionId, limit), ({ Anchor, Status }) => ({
          AnchorId: Anchor.AnchorId, Title: Anchor.Title, Summary: Anchor.Summary, Status,
        }));
      case 'search':
        if (typeof args.query !== 'string') throw new TypeError('Search needs a query.');
        return this.view(ContextViews.Search(sessionId, args.query, limit), (item) => item);
      case 'memory':
        return this.view(ContextViews.Memory(sessionId, this.memoryScopes(sessionId, args.memoryScope), limit), (item) => item);
      default:
        throw new TypeError('Unknown view.');
    }
  }

  private memoryScopes(sessionId: Guid, requestedScope: unknown): readonly MemoryScope[] {
    const repositoryId = this.contexts.WithCurrent(sessionId, (read) => read.Session.RepositoryId);
    const own = { SessionId: sessionId };
    if (requestedScope === 'session') return [own];
    if (repositoryId != null) {
      const repository = { RepositoryId: repositoryId };
      if (requestedScope === 'repository') return [repository];
      if (requestedScope === 'sessionAndRepository') return [own, repository];
    }
    throw new TypeError('Requested scope unavailable.');
  }

  private view<T>(definition: ILLMContextViewDefinition<T>, project: (item: T) => unknown): string {
    const view = this.contexts.OpenView(definition);
    try {
      return this.reply(definition.SessionId, view.SessionRevision, view.MemoryRevision, Array.from(view, project));
    } finally {
      view.dispose();
    }
  }

  private readAnchor(sessionId: Guid, anchorId: Guid, limit: number): string {
    return this.contexts.WithCurrent(sessionId, (read) => {
      const { Start, End, Status } = read.ResolveAnchor(anchorId);
      const passage = Start && End ? read.ReadRange(Start.Sequence, limit)
        .filter((entry) => entry.Sequence <= End.Sequence) : [];
      const items = passage.map(({ EntryId, Sequence, Role, Content }) => ({
        EntryId, Sequence, Role, Text: Text(Content),
      }));
      return this.reply(sessionId, read.Session.Revision, read.MemoryRevision, items, Status);
    });
  }

  private reply(sessionId: Guid, sessionRevision: Int64, memoryRevision: Int64, items: unknown, status: string | null = null): string {
    return JSON.stringify(jsonValue({ sessionId, sessionRevision, memoryRevision, items, status }));
  }
}
