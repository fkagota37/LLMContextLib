// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { expect, it } from 'vitest';
import { ContextMutationStatus, ContextRole, SessionStatus, TextContent } from '../src/domain/session.js';
import { defaultLLMContextOptions } from '../src/options.js';
import { MutationDiagnostics } from '../src/storage/mutation-diagnostics.js';
import { LLMContextOwner } from '../src/storage/owner.js';
import { testGuid } from './test-guid.js';

it.each([false, true])('attributes mutation terminals to their actual phases (serialized: %s)', (serialized) => {
  const SessionId = testGuid('session');
  const EntryId = testGuid('entry');
  const owner = new LLMContextOwner({ ...defaultLLMContextOptions, SerializeSessionPreparation: serialized,
    EstimatedResidentByteBudget: 32_768 });
  owner.initialize([{ SessionId, UserId: testGuid('user'), RepositoryId: null, Revision: 0,
    Status: SessionStatus.Active, Anchors: new Map(), Segments: new Map([[0, {
      SegmentId: 0, Revision: 0, Entries: [{ EntryId, Sequence: 0, Role: ContextRole.User,
        CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent('old') }],
    }]]) }]);

  const replace = (text: string, entryId = EntryId, ExpectedRevision = 0) => {
    const diagnostics = new MutationDiagnostics();
    const result = owner.applySession({ SessionId, ExpectedRevision,
      Changes: [{ kind: 'ReplaceEntry', EntryId: entryId, Content: new TextContent(text) }] }, diagnostics);
    return { status: result.Status, diagnostics };
  };
  try {
    const stale = replace('unused', EntryId, 17);
    expect(stale).toMatchObject({ status: ContextMutationStatus.RevisionConflict,
      diagnostics: { Disposition: 'InitialRevisionConflict', PreparationStarted: false, GateAttempted: false } });
    const invalid = replace('invalid', testGuid('absent'));
    expect(invalid).toMatchObject({ status: ContextMutationStatus.InvalidOperation,
      diagnostics: { Disposition: 'InvalidPreparation', PreparationStarted: true, Prepared: false, GateAttempted: serialized } });
    const rejected = replace('oversized '.repeat(4000));
    expect(rejected).toMatchObject({ status: ContextMutationStatus.AdmissionRejected,
      diagnostics: { Disposition: 'ResourceRejected', PreparationStarted: true, Prepared: true, GateAttempted: true } });
    const applied = replace('new');
    expect(applied).toMatchObject({ status: ContextMutationStatus.Applied,
      diagnostics: { Disposition: 'Applied', PreparationStarted: true, Prepared: true, GateAttempted: true } });
    expect(owner.tryFindSession(SessionId)?.Revision).toBe(1);
  } finally { owner.dispose(); }
});
