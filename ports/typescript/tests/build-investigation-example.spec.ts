// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { BuildInvestigationAssistant } from '../examples/BuildInvestigation/assistant.js';
import { ContextToolAdapter } from '../examples/BuildInvestigation/context-tool-adapter.js';
import {
  BuildRunnerWorker, InvestigationCoordinator, KnowledgeWorker, Publication, ScriptedReasoningModel, SimulatedBuildProfiler,
} from '../examples/BuildInvestigation/workers.js';
import { AnchorKind, ContextRole, SessionStatus, TextContent, ToolCallContent, ToolResultContent } from '../src/domain/session.js';
import { LLMContextFactory } from '../src/factory.js';
import type { ILLMContextPolymorphicArray } from '../src/index.js';

const newSession = (UserId = randomUUID(), RepositoryId = randomUUID()) => ({
  SessionId: randomUUID(), UserId, RepositoryId, Revision: 0, Status: SessionStatus.Active,
  Segments: new Map(), Anchors: new Map(),
});

it('runs the complete example with scoped knowledge and no extra reasoning for direct reads or reuse', () => {
  const output: string[] = [];
  const example = new BuildInvestigationAssistant((message) => output.push(message));
  try {
    expect(example.RunDemonstration()).toEqual({
      InvestigationRevision: 5, FollowupRevision: 1, MemoryRevision: 1,
      InvestigationMemories: 2, FollowupMemories: 1,
      ModelAdapterInvocations: 3, SimulatedBuildRuns: 3,
      DirectUiModelAdapterInvocations: 0, FollowupModelAdapterInvocations: 0, ReusedConfiguration: true,
    });
    const source = output.find((message) => message.startsWith('Source passage: '))!;
    expect(JSON.parse(source.slice('Source passage: '.length))).toMatchObject({ status: 'Current', sessionRevision: 5 });
  } finally {
    example.dispose();
  }
});

it('records a correlated pair atomically and never reruns an already executed build on conflict', () => {
  const session = newSession();
  const owner = LLMContextFactory.Create().Initialize([session]);
  const { SessionId } = session;
  const compete = (ExpectedRevision: number) => Publication.EnsureApplied(owner.Apply({
    SessionId, ExpectedRevision, Changes: [{ kind: 'AppendEntries', Entries: [{
      EntryId: randomUUID(), Role: ContextRole.User, CreatedAt: new Date().toISOString(), Content: new TextContent('Competing write.'),
    }] }],
  }), 'Competing writer');
  let runs = 0;
  const runner = new BuildRunnerWorker(owner, {
    Run: () => {
      if (++runs === 2) compete(1);
      return { Outcome: 'Completed' };
    },
  });
  const settings = { Tool: 'build-profiler', ToolVersion: 'example-v1', WorkloadKey: 'example-build', Workers: 4 };
  try {
    const recorded = runner.RunAndRecord(SessionId, settings);
    owner.WithCurrent(SessionId, (read) => {
      const entries = read.ReadRange(0, 8);
      expect(entries.map((entry) => entry.EntryId)).toEqual([recorded.CallEntryId, recorded.ResultEntryId]);
      expect(entries[0].Content).toBeInstanceOf(ToolCallContent);
      expect(entries[1].Content).toBeInstanceOf(ToolResultContent);
      expect((entries[0].Content as ToolCallContent).CallId).toBe((entries[1].Content as ToolResultContent).CallId);
      expect(JSON.parse((entries[1].Content as ToolResultContent).ResultJson)).toEqual(recorded.Observation);
    });
    expect(() => runner.RunAndRecord(SessionId, settings)).toThrow(/RevisionConflict/);
    expect(runs).toBe(2);
    owner.WithCurrent(SessionId, (read) => {
      expect(read.Session.Revision).toBe(2);
      expect(read.ReadRange(0, 8)).toHaveLength(3);
    });
  } finally {
    owner.dispose();
  }
});

it('reuses only compatible repository settings with current provenance', () => {
  const first = newSession();
  const second = newSession(first.UserId, first.RepositoryId);
  const owner: ILLMContextPolymorphicArray = LLMContextFactory.Create().Initialize([first, second]);
  const runner = new BuildRunnerWorker(owner, new SimulatedBuildProfiler());
  const model = new ScriptedReasoningModel();
  try {
    const outcome = new InvestigationCoordinator(owner, runner, model).Investigate(first.SessionId, 'example-v1', 'example-build');
    new KnowledgeWorker(owner).PublishApproved(first.SessionId, outcome);
    expect(runner.TryGetReusableSettings(second.SessionId, 'example-v1', 'example-build')).toEqual(outcome.RecommendedSettings);
    expect(runner.TryGetReusableSettings(second.SessionId, 'different-version', 'example-build')).toBeNull();
    expect(runner.TryGetReusableSettings(second.SessionId, 'example-v1', 'other-workload')).toBeNull();
    const tools = new ContextToolAdapter(owner, first.SessionId, second.SessionId);
    const query = (sessionId: string, memoryScope: string) =>
      JSON.parse(tools.Execute('context_view', { sessionId, view: 'memory', memoryScope, limit: 8 })).items;
    expect(query(first.SessionId, 'session')).toHaveLength(1);
    expect(query(second.SessionId, 'session')).toHaveLength(0);
    const shared = query(second.SessionId, 'repository');
    expect(shared).toHaveLength(1);
    expect(shared[0].sources).toEqual([{ sessionId: first.SessionId, anchorId: outcome.ExperimentAnchorId }]);
    const passage = JSON.parse(tools.Execute('context_read_anchor', { ...shared[0].sources[0], limit: 32 }));
    expect(passage.status).toBe('Current');
    expect(passage.items).toHaveLength(6);
    Publication.EnsureApplied(owner.Apply({
      SessionId: first.SessionId, ExpectedRevision: outcome.PublishedSessionRevision,
      Changes: [{ kind: 'AppendEntries', Entries: [{
        EntryId: randomUUID(), Role: ContextRole.User, CreatedAt: new Date().toISOString(), Content: new TextContent('Later edit.'),
      }] }],
    }), 'Advance source');
    expect(runner.TryGetReusableSettings(second.SessionId, 'example-v1', 'example-build')).toBeNull();
    expect(model.InvocationCount).toBe(2);
  } finally {
    owner.dispose();
  }
});

it('materializes a bounded authorized passage and releases the example tool captures', () => {
  const sessionId = randomUUID();
  const anchorId = randomUUID();
  const entries = ['workers', 'build', 'outside the passage'].map((text, index) => ({
    EntryId: randomUUID(), Sequence: 9007199254740993n + BigInt(index), Role: ContextRole.User,
    CreatedAt: '2026-01-01T00:00:00Z', Content: new TextContent(text),
  }));
  const owner = LLMContextFactory.Create({ MaximumRetainedReads: 1 }).Initialize([{
    SessionId: sessionId, UserId: randomUUID(), RepositoryId: randomUUID(), Revision: 0, Status: SessionStatus.Active,
    Segments: new Map([[0, { SegmentId: 0, Revision: 0, Entries: entries }]]),
    Anchors: new Map([[anchorId, {
      AnchorId: anchorId, StartEntryId: entries[0].EntryId, EndEntryId: entries[1].EntryId,
      Title: 'Workers', Summary: 'Build', Topics: [], Kind: AnchorKind.Topic, SourceRevision: 0, PinnedRevision: null,
    }]]),
  }]);

  try {
    const tools = new ContextToolAdapter(owner, sessionId);
    const view = (args: object) => JSON.parse(tools.Execute('context_view', { sessionId, limit: 8, ...args }));
    expect(view({ view: 'memory', memoryScope: 'sessionAndRepository' }).items).toEqual([]);
    expect(view({ view: 'navigation' }).items).toEqual([{ anchorId, title: 'Workers', summary: 'Build', status: 'Current' }]);
    expect(view({ view: 'search', query: 'workers' }).items).toContainEqual(expect.objectContaining({ anchorId }));

    const passage = tools.Execute('context_read_anchor', { sessionId, anchorId, limit: 32 });
    expect(passage).toContain('"sequence":9007199254740993');
    expect(JSON.parse(passage)).toMatchObject({
      sessionId, sessionRevision: 0, memoryRevision: 0, status: 'Current',
      items: [{ text: 'workers' }, { text: 'build' }],
    });
    expect(() => view({ sessionId: randomUUID(), view: 'navigation' })).toThrow(/unavailable/);
    expect(() => view({ view: 'navigation', limit: 33 })).toThrow(RangeError);
    expect(owner.GetStatistics()).toMatchObject({ RetainedReads: 0, EstimatedViewBytes: 0 });
  } finally {
    owner.dispose();
  }
});
