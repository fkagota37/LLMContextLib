// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { randomUUID } from 'node:crypto';
import type { Int64 } from '../../src/domain/int64.js';
import type { ILLMContextPolymorphicArray } from '../../src/domain/reads.js';
import { SessionStatus, type Guid, type LLMSessionContext } from '../../src/domain/session.js';
import { LLMContextFactory } from '../../src/factory.js';
import { ContextToolAdapter } from './context-tool-adapter.js';
import {
  BuildRunnerWorker, InvestigationCoordinator, KnowledgeWorker, ScriptedReasoningModel, SimulatedBuildProfiler,
  type ContextToolReply,
} from './workers.js';

export interface ExampleRunSummary {
  readonly InvestigationRevision: Int64;
  readonly FollowupRevision: Int64;
  readonly MemoryRevision: Int64;
  readonly InvestigationMemories: number;
  readonly FollowupMemories: number;
  readonly ModelAdapterInvocations: number;
  readonly SimulatedBuildRuns: number;
  readonly DirectUiModelAdapterInvocations: number;
  readonly FollowupModelAdapterInvocations: number;
  readonly ReusedConfiguration: boolean;
}

const toolVersion = 'example-v1';
const workloadKey = 'example-build';

export class BuildInvestigationAssistant {
  private readonly contexts: ILLMContextPolymorphicArray;
  private readonly investigationId = randomUUID();
  private readonly followupId = randomUUID();
  private readonly model = new ScriptedReasoningModel();
  private readonly profiler = new SimulatedBuildProfiler();
  private readonly runner: BuildRunnerWorker;
  private readonly coordinator: InvestigationCoordinator;
  private readonly knowledge: KnowledgeWorker;
  private readonly tools: ContextToolAdapter;

  constructor(private readonly output: (message: string) => void = console.log) {
    const UserId = randomUUID();
    const RepositoryId = randomUUID();
    const session = (SessionId: Guid): LLMSessionContext => ({
      SessionId, UserId, RepositoryId, Revision: 0, Status: SessionStatus.Active,
      Segments: new Map(), Anchors: new Map(),
    });
    this.contexts = LLMContextFactory.Create().Initialize([session(this.investigationId), session(this.followupId)]);
    this.runner = new BuildRunnerWorker(this.contexts, this.profiler);
    this.coordinator = new InvestigationCoordinator(this.contexts, this.runner, this.model);
    this.knowledge = new KnowledgeWorker(this.contexts);
    this.tools = new ContextToolAdapter(this.contexts, this.investigationId, this.followupId);
  }

  RunDemonstration(): ExampleRunSummary {
    const sessionId = this.investigationId;
    const outcome = this.coordinator.Investigate(sessionId, toolVersion, workloadKey);
    const MemoryRevision = this.knowledge.PublishApproved(sessionId, outcome);
    this.output(`Workers sharing one owner: 3; memory revision: ${MemoryRevision}`);

    // Direct UI actions never call the reasoning adapter.
    const beforeUi = this.model.InvocationCount;
    this.output(`Navigation result: ${this.tools.Execute('context_view', { sessionId, view: 'navigation', limit: 8 })}`);
    this.output(`Source passage: ${this.tools.Execute('context_read_anchor', {
      sessionId, anchorId: outcome.ExperimentAnchorId, limit: 32,
    })}`);
    const DirectUiModelAdapterInvocations = this.model.InvocationCount - beforeUi;
    this.output(`Direct UI model-adapter invocations added: ${DirectUiModelAdapterInvocations}`);

    const selected = this.model.SelectContextTool('Find the decision about workers.', sessionId);
    const reply: ContextToolReply = {
      CallId: selected.CallId, JsonContent: this.tools.Execute(selected.Name, selected.Arguments),
    };
    this.output(`Chat-selected search result: ${reply.JsonContent}`);

    const beforeFollowup = this.model.InvocationCount;
    const cached = this.runner.TryGetReusableSettings(this.followupId, toolVersion, workloadKey);
    if (cached) {
      this.runner.RunAndRecord(this.followupId, cached);
      this.output(`Follow-up reused cached workers: ${cached.Workers}`);
    } else {
      const fresh = this.coordinator.Investigate(this.followupId, toolVersion, workloadKey);
      this.knowledge.PublishApproved(this.followupId, fresh);
    }
    const FollowupModelAdapterInvocations = this.model.InvocationCount - beforeFollowup;
    this.output(`Follow-up model-adapter invocations added: ${FollowupModelAdapterInvocations}`);

    const capture = (SessionId: Guid) => this.contexts.WithCurrent(SessionId, (read) => ({
      revision: read.Session.Revision,
      memories: read.GetApplicableMemory([{ SessionId }, { RepositoryId: read.Session.RepositoryId }]).length,
    }));
    const first = capture(sessionId);
    const second = capture(this.followupId);
    this.output(`Applicable memories: investigation=${first.memories}, follow-up=${second.memories}`);
    this.output(`Session revisions: investigation=${first.revision}, follow-up=${second.revision}`);
    this.output(`Model-adapter invocations total: ${this.model.InvocationCount}; simulated build runs: ${this.profiler.RunCount}`);
    return {
      InvestigationRevision: first.revision, FollowupRevision: second.revision, MemoryRevision,
      InvestigationMemories: first.memories, FollowupMemories: second.memories,
      ModelAdapterInvocations: this.model.InvocationCount, SimulatedBuildRuns: this.profiler.RunCount,
      DirectUiModelAdapterInvocations, FollowupModelAdapterInvocations, ReusedConfiguration: cached !== null,
    };
  }

  dispose(): void { this.contexts.dispose(); }
}
