// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import {
  AnchorTargetStatus,
  SummaryContent,
  TextContent,
  ToolCallContent,
  ToolResultContent,
  type AnchorResolution,
  type ContextEntry,
  type ContextMemory,
  type ContextSearchHit,
  type Guid,
  type LLMSessionContext,
} from '../domain/session.js';
import type { ContextCursor, ContextPage, ILLMContextReadLease } from '../domain/reads.js';

export class ContextReadLease implements ILLMContextReadLease {
  public readonly Session: LLMSessionContext;
  public readonly MemoryRevision: number;
  private readonly onDispose: (() => void) | null;
  private disposed = false;

  constructor(session: LLMSessionContext, memoryRevision: number, onDispose: (() => void) | null = null) {
    this.Session = session;
    this.MemoryRevision = memoryRevision;
    this.onDispose = onDispose;
  }

  public TryFindEntry(entryId: Guid): boolean {
    for (const segment of this.Session.Segments.values()) {
      for (const entry of segment.Entries) {
        if (entry.EntryId === entryId) {
          return true;
        }
      }
    }
    return false;
  }

  public ReadRange(fromSequence: number, count: number): readonly ContextEntry[] {
    if (count < 0) {
      throw new RangeError('ReadRange count must be non-negative.');
    }
    const entries: ContextEntry[] = [];
    for (const segment of this.Session.Segments.values()) {
      for (const entry of segment.Entries) {
        if (entry.Sequence >= fromSequence) {
          entries.push(entry);
          if (entries.length >= count) {
            return entries;
          }
        }
      }
    }
    return entries;
  }

  public ReadPage(cursor: ContextCursor | null, count: number): ContextPage {
    if (count < 0) {
      throw new RangeError('Page count must be non-negative.');
    }
    const fromSequence = cursor?.AfterSequence ?? 0;
    const entries = this.ReadRange(fromSequence, count);
    return {
      Entries: entries,
      Next: entries.length === count ? { SessionId: this.Session.SessionId, Revision: this.Session.Revision, AfterSequence: fromSequence + entries.length } : null,
    };
  }

  public Search(query: string, limit: number): readonly ContextSearchHit[] {
    if (limit < 0) {
      throw new RangeError('Search limit must be non-negative.');
    }
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }
    const lower = normalized.toLowerCase();
    const results: ContextSearchHit[] = [];
    for (const segment of this.Session.Segments.values()) {
      for (const entry of segment.Entries) {
        if (this.entryText(entry).toLowerCase().includes(lower)) {
          const hit: ContextSearchHit = {
            EntryId: entry.EntryId,
            AnchorId: null,
            Snippet: this.entryText(entry).slice(0, 120),
            Sequence: entry.Sequence,
            SessionRevision: this.Session.Revision,
          };
          results.push(hit);
          if (results.length >= limit) {
            return results;
          }
        }
      }
    }
    return results;
  }

  public SearchKeys(keys: readonly string[], limit: number): readonly ContextSearchHit[] {
    if (limit < 0) {
      throw new RangeError('SearchKeys limit must be non-negative.');
    }
    if (!keys.length) {
      return [];
    }
    const results: ContextSearchHit[] = [];
    for (const segment of this.Session.Segments.values()) {
      for (const entry of segment.Entries) {
        const entryKeys = entry.IndexKeys ?? [];
        if (entryKeys.some((key) => keys.includes(key))) {
          results.push({
            EntryId: entry.EntryId,
            AnchorId: null,
            Snippet: this.entryText(entry).slice(0, 120),
            Sequence: entry.Sequence,
            SessionRevision: this.Session.Revision,
          });
          if (results.length >= limit) {
            return results;
          }
        }
      }
    }
    return results;
  }

  public ResolveAnchor(anchorId: Guid): AnchorResolution {
    const anchor = this.Session.Anchors.get(anchorId);
    if (!anchor) {
      throw new Error(`Anchor ${anchorId} was not found.`);
    }
    return {
      Anchor: anchor,
      Status: AnchorTargetStatus.Current,
      Start: null,
      End: null,
      SessionRevision: this.Session.Revision,
    };
  }

  public GetApplicableMemory(scopes: readonly { readonly UserId?: Guid | null; readonly RepositoryId?: Guid | null; readonly SessionId?: Guid | null }[]): readonly ContextMemory[] {
    if (!scopes.length) {
      return [];
    }
    return [];
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.onDispose?.();
  }

  private entryText(entry: ContextEntry): string {
    if (entry.Content instanceof TextContent) {
      return entry.Content.text;
    }
    if (entry.Content instanceof ToolCallContent) {
      return `${entry.Content.toolName} ${entry.Content.argumentsJson}`;
    }
    if (entry.Content instanceof ToolResultContent) {
      return entry.Content.resultJson;
    }
    if (entry.Content instanceof SummaryContent) {
      return entry.Content.text;
    }
    return '';
  }
}
