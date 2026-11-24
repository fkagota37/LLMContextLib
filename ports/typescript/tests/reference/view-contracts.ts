// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { LLMContextFactory } from '../../src/factory.js';
import { ContextError } from '../../src/domain/errors.js';
import type { ILLMContextViewDefinition } from '../../src/domain/reads.js';
import { AnchorKind, ContextRole, MemoryStatus, SessionStatus, SummaryContent, TextContent, ToolCallContent, ToolResultContent,
  type AnchorResolution, type ContextEntry, type ContextMemory, type ContextSearchHit, type LLMSessionContext,
  type MemoryScope, type ModelContextItem } from '../../src/domain/session.js';
import { ContextViews } from '../../src/views.js';
import { Text } from '../../src/policies/context.js';

const id = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
function format(value: unknown): string {
  if (typeof value === 'string') return value;
  const item = value as ContextEntry | ContextSearchHit | AnchorResolution | ContextMemory | ModelContextItem;
  if ('CreatedAt' in item) return `entry/${item.Sequence}/${item.EntryId}/${item.Role}/${Text(item.Content)}`;
  if ('Snippet' in item) return `hit/${item.EntryId}/${item.AnchorId ?? ''}/${item.Sequence}/${item.SessionRevision}/${item.Snippet}`;
  if ('Anchor' in item) return `anchor/${item.Anchor.AnchorId}/${item.Status}/${item.Start?.EntryId ?? ''}/${item.End?.EntryId ?? ''}/${item.SessionRevision}`;
  if ('Scope' in item) return `memory/${item.MemoryId}/${item.Content}/${item.Revision}/${item.Status}`;
  return `model/${item.EntryId ?? ''}/${item.MemoryId ?? ''}/${item.Role}/${item.Text}`;
}

export function viewContracts() {
  const rows: object[] = [];
  const contents = [new TextContent('system'), new TextContent('hello build'), new ToolCallContent('call', 'build', '{}'),
    new ToolResultContent('call', '{"ok":true}', false), new SummaryContent('summary', 1),
    new TextContent('assistant build'), new TextContent('internal')];
  const roles = [ContextRole.System, ContextRole.User, ContextRole.Assistant, ContextRole.Tool, ContextRole.Internal,
    ContextRole.Assistant, ContextRole.Internal];
  const entries = contents.map((Content, Sequence) => ({ EntryId: id(Sequence + 10), Sequence, Role: roles[Sequence],
    CreatedAt: '1970-01-01T00:00:00.0000000+00:00', Content }));
  const anchor = { AnchorId: id(50), StartEntryId: id(11), EndEntryId: id(15), Title: 'build anchor', Summary: 'build summary',
    Topics: ['build'], Kind: AnchorKind.Manual, SourceRevision: 0, PinnedRevision: null };
  const session: LLMSessionContext = { SessionId: id(1), UserId: id(2), RepositoryId: null, Revision: 0,
    Status: SessionStatus.Active, Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: entries }]]),
    Anchors: new Map([[id(50), anchor]]) };
  const owner = LLMContextFactory.Create().Initialize([session]);
  const memory = owner.ApplyMemory({ ExpectedRevision: 0, Deletes: [], Upserts: [{ MemoryId: id(60), Scope: { UserId: id(2) },
    Content: 'memory', Revision: 0, Status: MemoryStatus.Confirmed, ExpiresAt: null, Sources: [{ SessionId: id(1), AnchorId: id(50) }] }] });
  assert.equal(memory.Status, 'Applied');
  const observe = <T>(label: string, definition: ILLMContextViewDefinition<T>) => {
    const view = owner.OpenView(definition);
    try { rows.push({ label, maximum: definition.MaximumResults, revision: view.SessionRevision, values: [...view].map(format) }); }
    finally { view.dispose(); }
  };
  const check = (label: string, action: () => unknown) => {
    let outcome = 'ok';
    try { action(); } catch (error) {
      if (error instanceof ContextError) outcome = error.code;
      else if (error instanceof RangeError) outcome = 'Range';
      else if (error instanceof TypeError) outcome = 'Argument';
      else if (error instanceof Error && error.message === 'callback') outcome = 'Callback';
      else throw error;
    }
    const stats = owner.GetStatistics();
    rows.push({ label, outcome, reads: stats.RetainedReads, view: String(stats.EstimatedViewBytes) });
  };
  try {
    observe('timeline/default', ContextViews.Timeline(id(1)));
    observe('timeline/from', ContextViews.Timeline(id(1), 3, 2));
    observe('conversation/default', ContextViews.Conversation(id(1)));
    observe('tool/default', ContextViews.Tool(id(1), 'call'));
    observe('tool/truncated', ContextViews.Tool(id(1), 'call', 1));
    observe('navigation/default', ContextViews.Navigation(id(1)));
    observe('search/default', ContextViews.Search(id(1), 'build'));
    observe('keys/default', ContextViews.SearchKeys(id(1), ['build']));
    observe('memory/default', ContextViews.Memory(id(1), [{ UserId: id(2) }]));
    observe('memory/empty', ContextViews.Memory(id(1), []));
    observe('model/default', ContextViews.Model(id(1), 100, () => 1));
    observe('model/memory', ContextViews.Model(id(1), 100, () => 1, [{ UserId: id(2) }]));
    observe('model/pair-limit', ContextViews.Model(id(1), 100, () => 1, [], 3));
    observe('model/budget', ContextViews.Model(id(1), 3, () => 1));
    observe('project/default', ContextViews.Project(id(1), entry => entry.Role === ContextRole.Assistant,
      entry => `${entry.Sequence}/${Text(entry.Content)}`));
    check('project/null-predicate', () => ContextViews.Project(id(1), null!, () => ''));
    check('project/null-projection', () => ContextViews.Project(id(1), () => true, null!));
    check('project/callback', () => owner.OpenView(ContextViews.Project(id(1), () => { throw new Error('callback'); }, () => '')));
    check('model/null-estimator', () => owner.OpenView(ContextViews.Model(id(1), 1, null!)));
    check('model/negative-estimator', () => owner.OpenView(ContextViews.Model(id(1), 1, () => -1)));
    check('model/negative-budget', () => owner.OpenView(ContextViews.Model(id(1), -1, () => 1)));
    check('memory/default-array', () => owner.OpenView(ContextViews.Memory(id(1), undefined as unknown as MemoryScope[])));
    for (const limit of [-1, 0, 1, 4097]) {
      check(`timeline/limit/${limit}`, () => owner.OpenView(ContextViews.Timeline(id(1), 0, limit)).dispose());
      check(`model/limit/${limit}`, () => owner.OpenView(ContextViews.Model(id(1), 10, () => 1, [], limit)).dispose());
    }
    const disposed = owner.OpenView(ContextViews.Conversation(id(1)));
    disposed.dispose();
    check('disposed/view/index', () => disposed.at(0));
    check('disposed/view/negative-index', () => disposed.at(-1));
    check('disposed/view/count', () => disposed.length);
    check('disposed/view/session-revision', () => disposed.SessionRevision);
    check('disposed/view/memory-revision', () => disposed.MemoryRevision);
    check('disposed/view/enumeration', () => [...disposed]);
    const disposedRead = owner.OpenRead(id(1));
    disposedRead.dispose();
    check('disposed/read/range', () => disposedRead.ReadRange(-1, -1));
    check('disposed/read/page', () => disposedRead.ReadPage(null, 0));
    check('disposed/read/text', () => disposedRead.Search(null!, -1));
    check('disposed/read/indexed', () => disposedRead.SearchIndexed(null!, -1));
    check('disposed/read/null-keys', () => disposedRead.SearchKeys(null!, -1));
    check('disposed/read/keys', () => disposedRead.SearchKeys([], -1));
    check('disposed/read/memory', () => disposedRead.GetApplicableMemory(undefined!));
    const recipe = ContextViews.Conversation(id(1));
    const old = owner.OpenView(recipe);
    try {
      rows.push({ label: 'reopen/mutation', status: owner.Apply({ SessionId: id(1), ExpectedRevision: 0,
        Changes: [{ kind: 'ReplaceEntry', EntryId: id(11), Content: new TextContent('changed') }] }).Status });
      observe('reopen/current', recipe);
      owner.RemoveSession(id(1), 1);
      owner.dispose();
      rows.push({ label: 'reopen/retained', revision: old.SessionRevision, values: [...old].map(format) });
    } finally { old.dispose(); }
  } finally { owner.dispose(); }
  return { reference: '479d2612315cbd292da917bae6d8d3fec35fea24', rows };
}
