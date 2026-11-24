// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { randomUUID } from 'node:crypto';
import { advanceInt64, type Int64 } from '../../src/domain/int64.js';
import type { ILLMContextPolymorphicArray } from '../../src/domain/reads.js';
import {
  AnchorKind, AnchorTargetStatus, ContextMutationStatus, ContextRole, MemoryStatus,
  TextContent, ToolCallContent, ToolResultContent, type ContextEntryDraft, type ConversationAnchor,
  type Guid, type IContextMutationResult,
} from '../../src/domain/session.js';
import { ContextViews } from '../../src/views.js';

export interface BuildSettings {
  readonly Tool: string;
  readonly ToolVersion: string;
  readonly WorkloadKey: string;
  readonly Workers: number;
}

export interface BuildObservation {
  readonly Outcome: string;
}

export interface RecordedBuild {
  readonly Settings: BuildSettings;
  readonly Observation: BuildObservation;
  readonly CallEntryId: Guid;
  readonly ResultEntryId: Guid;
  readonly PublishedSessionRevision: Int64;
}

export interface InvestigationOutcome {
  readonly ExperimentAnchorId: Guid;
  readonly DecisionAnchorId: Guid;
  readonly PublishedSessionRevision: Int64;
  readonly RecommendedSettings: BuildSettings;
}

export interface ContextToolCall {
  readonly CallId: string;
  readonly Name: string;
  readonly Arguments: Readonly<Record<string, unknown>>;
}

export interface ContextToolReply {
  readonly CallId: string;
  readonly JsonContent: string;
}

export interface IBuildProfiler {
  Run(settings: BuildSettings): BuildObservation;
}

export interface IReasoningModel {
  ProposeTrial(baseline: BuildSettings, result: BuildObservation): BuildSettings;
  Explain(baseline: BuildObservation, trial: BuildObservation): string;
  SelectContextTool(request: string, activeSessionId: Guid): ContextToolCall;
}

export const Publication = {
  EnsureApplied(result: IContextMutationResult, operation: string): Int64 {
    if (result.Status !== ContextMutationStatus.Applied) {
      throw new Error(`${operation}: ${result.Status}; revision=${result.Revision}; ${result.Error ?? ''}`);
    }
    return result.Revision;
  },
};

const draft = (Role: ContextRole, Content: ContextEntryDraft['Content'], CreatedAt = new Date().toISOString()): ContextEntryDraft =>
  ({ EntryId: randomUUID(), Role, Content, CreatedAt });
const correlationId = () => randomUUID().replaceAll('-', '');

export class BuildRunnerWorker {
  constructor(private readonly contexts: ILLMContextPolymorphicArray, private readonly profiler: IBuildProfiler) {}

  RunAndRecord(SessionId: Guid, Settings: BuildSettings): RecordedBuild {
    const ExpectedRevision = this.contexts.WithCurrent(SessionId, (read) => read.Session.Revision);
    // The profiler runs outside the transaction. A conflict does not rerun it.
    const Observation = this.profiler.Run(Settings);
    const callId = correlationId();
    const timestamp = new Date().toISOString();
    const call = draft(ContextRole.Assistant, new ToolCallContent(callId, Settings.Tool, JSON.stringify(Settings)), timestamp);
    const result = draft(ContextRole.Tool, new ToolResultContent(callId, JSON.stringify(Observation), false), timestamp);
    const published = this.contexts.Apply({
      SessionId, ExpectedRevision, Changes: [{ kind: 'AppendEntries', Entries: [call, result] }],
    });
    return {
      Settings, Observation, CallEntryId: call.EntryId, ResultEntryId: result.EntryId,
      PublishedSessionRevision: Publication.EnsureApplied(published, 'Record completed build'),
    };
  }

  TryGetReusableSettings(sessionId: Guid, toolVersion: string, workloadKey: string): BuildSettings | null {
    const RepositoryId = this.contexts.WithCurrent(sessionId, (read) => read.Session.RepositoryId);
    if (RepositoryId == null) return null;
    const memories = this.contexts.OpenView(ContextViews.Memory(sessionId, [{ RepositoryId }], 16));
    try {
      for (const memory of memories) {
        let candidate: Partial<BuildSettings> | null;
        try {
          candidate = JSON.parse(memory.Content);
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
        if (candidate?.Tool !== 'build-profiler' || candidate.ToolVersion !== toolVersion ||
          candidate.WorkloadKey !== workloadKey || typeof candidate.Workers !== 'number' ||
          !Number.isInteger(candidate.Workers) || candidate.Workers < 1 || candidate.Workers > 32 ||
          memory.Sources.length !== 1) continue;
        const source = memory.Sources[0];
        const current = this.contexts.WithCurrent(source.SessionId,
          (read) => read.ResolveAnchor(source.AnchorId).Status === AnchorTargetStatus.Current);
        if (current) return { Tool: candidate.Tool, ToolVersion: toolVersion, WorkloadKey: workloadKey, Workers: candidate.Workers };
      }
      return null;
    } finally {
      memories.dispose();
    }
  }
}

export class InvestigationCoordinator {
  constructor(private readonly contexts: ILLMContextPolymorphicArray,
    private readonly runner: BuildRunnerWorker, private readonly model: IReasoningModel) {}

  Investigate(SessionId: Guid, ToolVersion: string, WorkloadKey: string): InvestigationOutcome {
    const revision = this.contexts.WithCurrent(SessionId, (read) => read.Session.Revision);
    const request = draft(ContextRole.User, new TextContent(`Investigate the slow build for ${WorkloadKey}.`));
    Publication.EnsureApplied(this.contexts.Apply({
      SessionId, ExpectedRevision: revision, Changes: [{ kind: 'AppendEntries', Entries: [request] }],
    }), 'Record investigation request');

    const baseline = this.runner.RunAndRecord(SessionId, { Tool: 'build-profiler', ToolVersion, WorkloadKey, Workers: 2 });
    const settings = this.model.ProposeTrial(baseline.Settings, baseline.Observation);
    const plan = draft(ContextRole.Assistant, new TextContent(`Try ${settings.Workers} workers for this workload.`));
    Publication.EnsureApplied(this.contexts.Apply({
      SessionId, ExpectedRevision: baseline.PublishedSessionRevision, Changes: [{ kind: 'AppendEntries', Entries: [plan] }],
    }), 'Record proposed experiment');

    const trial = this.runner.RunAndRecord(SessionId, settings);
    const explanation = this.model.Explain(baseline.Observation, trial.Observation);
    const conclusion = draft(ContextRole.Assistant, new TextContent(explanation));
    const experiment: ConversationAnchor = {
      AnchorId: randomUUID(), StartEntryId: baseline.CallEntryId, EndEntryId: conclusion.EntryId,
      Title: 'Worker-count experiment', Summary: 'Baseline, proposed trial, observed outcomes, and conclusion.',
      Topics: ['build', 'workers', 'profiling'], Kind: AnchorKind.Topic,
      SourceRevision: advanceInt64(trial.PublishedSessionRevision), PinnedRevision: null,
    };
    const decision: ConversationAnchor = {
      ...experiment, AnchorId: randomUUID(), StartEntryId: conclusion.EntryId, Kind: AnchorKind.Decision,
      Title: `Decision: use ${trial.Settings.Workers} workers`, Summary: explanation,
    };
    const result = this.contexts.Apply({
      SessionId, ExpectedRevision: trial.PublishedSessionRevision,
      Changes: [{ kind: 'AppendEntries', Entries: [conclusion] },
        { kind: 'PutAnchor', Anchor: experiment }, { kind: 'PutAnchor', Anchor: decision }],
    });
    return {
      ExperimentAnchorId: experiment.AnchorId, DecisionAnchorId: decision.AnchorId,
      PublishedSessionRevision: Publication.EnsureApplied(result, 'Publish conclusion and anchors'), RecommendedSettings: trial.Settings,
    };
  }
}

export class KnowledgeWorker {
  constructor(private readonly contexts: ILLMContextPolymorphicArray) {}

  PublishApproved(SessionId: Guid, outcome: InvestigationOutcome): Int64 {
    const { RepositoryId, ExpectedRevision } = this.contexts.WithCurrent(SessionId,
      (read) => ({ RepositoryId: read.Session.RepositoryId, ExpectedRevision: read.MemoryRevision }));
    if (RepositoryId == null) throw new Error('This example requires a repository.');
    const common = { Status: MemoryStatus.Confirmed, Revision: 0, Sources: [{ SessionId, AnchorId: outcome.ExperimentAnchorId }] };
    return Publication.EnsureApplied(this.contexts.ApplyMemory({
      ExpectedRevision,
      Upserts: [
        { ...common, MemoryId: randomUUID(), Scope: { SessionId }, ExpiresAt: null,
          Content: 'Keep verbose profiler traces for this investigation only.' },
        { ...common, MemoryId: randomUUID(), Scope: { RepositoryId }, ExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          Content: JSON.stringify(outcome.RecommendedSettings) },
      ],
      Deletes: [],
    }), 'Publish scoped knowledge');
  }
}

export class SimulatedBuildProfiler implements IBuildProfiler {
  private calls = 0;
  get RunCount(): number { return this.calls; }

  Run(_settings: BuildSettings): BuildObservation {
    this.calls++;
    return { Outcome: 'Completed' };
  }
}

export class ScriptedReasoningModel implements IReasoningModel {
  private calls = 0;
  get InvocationCount(): number { return this.calls; }

  ProposeTrial(baseline: BuildSettings, _result: BuildObservation): BuildSettings {
    this.calls++;
    return { ...baseline, Workers: 4 };
  }

  Explain(baseline: BuildObservation, trial: BuildObservation): string {
    this.calls++;
    return `Simulated outcomes: baseline=${baseline.Outcome}, trial=${trial.Outcome}. ` +
      'Reuse the trial configuration to demonstrate context sharing, not a measured improvement.';
  }

  SelectContextTool(_request: string, activeSessionId: Guid): ContextToolCall {
    this.calls++;
    return { CallId: correlationId(), Name: 'context_view',
      Arguments: { sessionId: activeSessionId, view: 'search', query: 'workers', limit: 8 } };
  }
}
