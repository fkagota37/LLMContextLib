// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextIndexingMode, type ContextIndexKeys } from '../domain/index-keys.js';
import { ContextError } from '../domain/errors.js';
import { advanceInt64, compareInt64, isInt64, type Int64 } from '../domain/int64.js';
import {
  AnchorTargetStatus,
  type ContextIndexStatus,
  type AnchorResolution,
  type ContextEntry,
  type ContextMemory,
  type ContextSearchHit,
  type Guid,
  type LLMSessionContext,
} from '../domain/session.js';
import type { ContextCursor, ContextPage, ILLMContextReadLease } from '../domain/reads.js';
import { ApplicableMemory, Terms } from '../policies/context.js';
import { canonicalGuid } from '../domain/guid.js';
import type { SessionIndex } from './session-index.js';

export class ContextReadLease implements ILLMContextReadLease {
  private session: LLMSessionContext | null;
  private memoryRecords: readonly ContextMemory[];
  private onDispose: (() => void) | null;
  private index: SessionIndex | null;
  private disposed = false;

  constructor(
    session: LLMSessionContext,
    private readonly memoryRevision: Int64,
    onDispose: () => void,
    private readonly indexingMode: ContextIndexingMode,
    memoryRecords: readonly ContextMemory[],
    index: SessionIndex,
    private readonly capturedTime: number | string,
  ) {
    this.session = session;
    this.onDispose = onDispose;
    this.memoryRecords = memoryRecords;
    this.index = index;
  }

  public get Session(): LLMSessionContext {
    this.ensureUsable();
    return this.session!;
  }

  public get MemoryRevision(): Int64 {
    this.ensureUsable();
    return this.memoryRevision;
  }

  public get IndexingMode(): ContextIndexingMode {
    this.ensureUsable();
    return this.indexingMode;
  }

  public get IndexStatus(): ContextIndexStatus {
    this.ensureUsable();
    return this.index!.Status;
  }

  public TryFindEntry(entryId: Guid): ContextEntry | null {
    this.ensureUsable();
    return this.index!.find(canonicalGuid(entryId));
  }

  public ReadRange(fromSequence: Int64, count: number): readonly ContextEntry[] {
    this.ensureUsable();
    if (!isInt64(fromSequence) || fromSequence < 0 || !Number.isInteger(count) || count < 0 || count > 0x7fff_ffff) {
      throw new RangeError('Range start and count must be non-negative integers.');
    }
    return this.index!.range(fromSequence, count);
  }

  public ReadPage(cursor: ContextCursor | null, count: number): ContextPage {
    this.ensureUsable();
    if (!Number.isInteger(count) || count <= 0 || count > 0x7fff_ffff) {
      throw new RangeError('Page count must be positive.');
    }
    if (cursor && (canonicalGuid(cursor.SessionId) !== this.Session.SessionId || !isInt64(cursor.Revision) ||
        compareInt64(cursor.Revision, this.Session.Revision) !== 0 || !isInt64(cursor.AfterSequence) || cursor.AfterSequence < 0)) {
      throw new TypeError('Cursor belongs to another session/revision.');
    }
    const fromSequence = cursor ? advanceInt64(cursor.AfterSequence) : 0;
    const entries = this.ReadRange(fromSequence, count);
    const nextSequence = entries.length > 0 ? entries[entries.length - 1].Sequence : null;
    const hasMore = nextSequence !== null && this.index!.hasAfter(nextSequence);
    return Object.freeze({
      Entries: entries,
      Next: hasMore && nextSequence !== null
        ? Object.freeze({ SessionId: this.Session.SessionId, Revision: this.Session.Revision, AfterSequence: nextSequence }) : null,
    });
  }

  public Search(query: string, limit: number): readonly ContextSearchHit[] {
    return this.searchText(query, limit, true);
  }

  public SearchKeys(keys: ContextIndexKeys | readonly string[], limit: number): readonly ContextSearchHit[] {
    if (keys == null) throw new TypeError('Keys must be initialized.');
    this.validateSearchLimit(limit);
    const terms = keys instanceof Array ? keys : keys.Keys;
    if (terms.some((term) => typeof term !== 'string')) throw new TypeError('Index keys must be strings.');
    return this.index!.search(terms, limit, true);
  }

  public SearchIndexed(query: string, limit: number): { readonly Hits: readonly ContextSearchHit[]; readonly IndexStatus: ContextIndexStatus } {
    return Object.freeze({ Hits: this.searchText(query, limit, false), IndexStatus: this.IndexStatus });
  }

  private searchText(query: string, limit: number, includePending: boolean): readonly ContextSearchHit[] {
    this.validateSearchLimit(limit);
    if (this.indexingMode === ContextIndexingMode.ProducerOwned) {
      throw new ContextError('InvalidOperation', 'Producer-owned indexes require SearchKeys; text queries are not interpreted.');
    }
    return this.index!.search(Terms(query), limit, includePending);
  }

  private validateSearchLimit(limit: number): void {
    this.ensureUsable();
    if (!Number.isInteger(limit) || limit < 0 || limit > 0x7fff_ffff) {
      throw new RangeError('Search limit must be a non-negative Int32.');
    }
  }

  public ResolveAnchor(anchorId: Guid): AnchorResolution {
    this.ensureUsable();
    const anchor = this.Session.Anchors.get(anchorId);
    if (!anchor) {
      throw new ContextError('NotFound', `Anchor ${anchorId} was not found.`);
    }
    const revision = this.Session.Revision;
    if (anchor.PinnedRevision != null && compareInt64(anchor.PinnedRevision, revision) !== 0) {
      return Object.freeze({ Anchor: anchor, Status: AnchorTargetStatus.HistoryUnavailable, Start: null, End: null, SessionRevision: revision });
    }
    const start = this.TryFindEntry(anchor.StartEntryId);
    const end = this.TryFindEntry(anchor.EndEntryId);
    const status = !start && !end ? AnchorTargetStatus.Missing :
      !start || !end ? AnchorTargetStatus.Partial :
        compareInt64(revision, anchor.SourceRevision) === 0 ? AnchorTargetStatus.Current : AnchorTargetStatus.Edited;
    return Object.freeze({ Anchor: anchor, Status: status, Start: start, End: end, SessionRevision: revision });
  }

  public GetApplicableMemory(scopes: readonly { readonly UserId?: Guid | null; readonly RepositoryId?: Guid | null; readonly SessionId?: Guid | null }[]): readonly ContextMemory[] {
    this.ensureUsable();
    return ApplicableMemory(this.memoryRecords, this.Session, scopes, this.capturedTime);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.session = null;
    this.index = null;
    this.memoryRecords = [];
    const release = this.onDispose;
    this.onDispose = null;
    release?.();
  }

  private ensureUsable(): void {
    if (this.disposed) {
      throw new ContextError('Disposed', 'This read lease has been disposed and cannot be used.');
    }
  }

}
