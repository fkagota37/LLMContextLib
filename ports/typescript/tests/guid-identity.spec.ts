// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { expect, it } from 'vitest';
import { AnchorKind, ContextMutationStatus, ContextRole, MemoryStatus, SessionStatus, TextContent } from '../src/domain/session.js';
import { LLMContextFactory } from '../src/factory.js';
import { ContextViews } from '../src/views.js';

it('treats different spellings of a GUID as one identity through lookup, provenance, and tombstones', async () => {
  const sessionId = 'abcdef00-1234-5678-0000-000000000001';
  const userId = 'abcdef00-1234-5678-0000-000000000002';
  const entryId = 'abcdef00-1234-5678-0000-000000000003';
  const anchorId = 'abcdef00-1234-5678-0000-000000000004';
  const memoryId = 'abcdef00-1234-5678-0000-000000000005';
  const shout = (value: string) => value.toUpperCase();
  const entry = {
    EntryId: shout(entryId), Sequence: 0, Role: ContextRole.User,
    CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('source'),
  };
  const session = {
    SessionId: shout(sessionId), UserId: shout(userId), RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
    Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: [entry] }]]),
    Anchors: new Map([[anchorId, {
      AnchorId: shout(anchorId), StartEntryId: entryId, EndEntryId: shout(entryId),
      Title: 'Evidence', Summary: '', Topics: [], Kind: AnchorKind.Manual, SourceRevision: 0, PinnedRevision: null,
    }]]),
  };
  const owner = LLMContextFactory.Create({}, ({ SessionId }) => SessionId.toLowerCase()).Initialize([session]);
  try {
    expect(owner.TryFind(shout(sessionId))?.SessionId).toBe(sessionId);
    await owner.WaitForIndexingAsync(shout(sessionId), 0);
    const memory = {
      MemoryId: shout(memoryId), Scope: { SessionId: shout(sessionId), UserId: shout(userId) },
      Content: 'confirmed', Revision: 0, Status: MemoryStatus.Confirmed, ExpiresAt: null,
      Sources: [{ SessionId: shout(sessionId), AnchorId: shout(anchorId) }],
    };
    expect(owner.ApplyMemory({ ExpectedRevision: 0, Upserts: [memory], Deletes: [] }).Status).toBe(ContextMutationStatus.Applied);
    owner.WithCurrent(shout(sessionId), (read) => {
      expect(read.TryFindEntry(shout(entryId))?.EntryId).toBe(entryId);
      expect(read.ResolveAnchor(shout(anchorId)).Anchor.AnchorId).toBe(anchorId);
      expect(read.GetApplicableMemory([{ SessionId: sessionId, UserId: userId }])).toMatchObject([
        { MemoryId: memoryId, Sources: [{ SessionId: sessionId, AnchorId: anchorId }] },
      ]);
    });

    const scopes = [{ SessionId: shout(sessionId), UserId: userId }];
    const definition = ContextViews.Memory(sessionId, scopes);
    scopes[0].SessionId = userId;
    scopes.length = 0;
    expect(Reflect.set(definition, 'MaximumResults', 0)).toBe(false);
    const view = owner.OpenView(definition);
    try {
      expect([...view].map((item) => item.MemoryId)).toEqual([memoryId]);
    } finally {
      view.dispose();
    }
    expect(owner.ApplyMemory({
      ExpectedRevision: 1, Upserts: [memory], Deletes: [memoryId],
    }).Status).toBe(ContextMutationStatus.InvalidOperation);
    expect(owner.Apply({
      SessionId: shout(sessionId), ExpectedRevision: 0, Changes: [{ kind: 'DeleteEntry', EntryId: shout(entryId) }],
    }).Status).toBe(ContextMutationStatus.Applied);
    expect(owner.Apply({
      SessionId: sessionId, ExpectedRevision: 1, Changes: [{ kind: 'AppendEntries', Entries: [{ ...entry, EntryId: entryId }] }],
    }).Status).toBe(ContextMutationStatus.InvalidOperation);
    expect(owner.RemoveSession(shout(sessionId), 1).Status).toBe(ContextMutationStatus.Applied);
    expect(owner.CreateSession({ ...session, SessionId: sessionId }).Status).toBe(ContextMutationStatus.InvalidOperation);
  } finally {
    owner.dispose();
  }
});

it('rejects malformed GUIDs before lookup or publication without changing revisions', () => {
  const SessionId = 'abcdef00-1234-5678-0000-000000000001';
  const UserId = 'abcdef00-1234-5678-0000-000000000002';
  const session = { SessionId, UserId, RepositoryId: null, Revision: 0, Status: SessionStatus.Active,
    Segments: new Map(), Anchors: new Map() };
  const owner = LLMContextFactory.Create().Initialize([session]);
  try {
    for (const invalid of ['session-alias', `${SessionId}\n`, SessionId.replace(/-/g, ''), SessionId.replace('abcdef', 'abcdeg')]) {
      expect(() => owner.TryFind(invalid)).toThrow('Expected a dashed GUID.');
      expect(() => owner.OpenRead(invalid)).toThrow(TypeError);
      expect(() => owner.RemoveSession(invalid, 0)).toThrow(TypeError);
      expect(owner.Apply({
        SessionId, ExpectedRevision: 0, Changes: [{ kind: 'AppendEntries', Entries: [{
          EntryId: invalid, Role: ContextRole.User,
          CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('unpublished'),
        }] }],
      }).Status).toBe(ContextMutationStatus.InvalidOperation);
      expect(owner.WithCurrent(invalid, () => 42)).toBe(42);
      owner.WithCurrent(SessionId, (read) => {
        expect(() => read.TryFindEntry(invalid)).toThrow(TypeError);
        expect(() => read.GetApplicableMemory([{ SessionId: invalid }])).toThrow(TypeError);
      });
    }
    expect(owner.TryFind(SessionId)).toMatchObject({ Revision: 0 });
    expect(owner.GetStatistics()).toMatchObject({ Sessions: 1, RetainedReads: 0, MemoryRevision: 0 });
  } finally { owner.dispose(); }
});
