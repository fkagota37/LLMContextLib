// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import {
  SummaryContent, TextContent, ToolCallContent, ToolResultContent,
  type ContextSegment, type ConversationAnchor, type LLMSessionContext,
} from '../src/domain/session.js';

export type WireSession = Omit<LLMSessionContext, 'Anchors' | 'Segments'> & {
  Segments: Record<string, ContextSegment>;
  Anchors: Record<string, ConversationAnchor>;
};

export function readReferenceFixture<T>(json: string): T {
  return JSON.parse(json, (key, value: TextContent | SummaryContent | ToolCallContent | ToolResultContent) => {
    if (key === 'IndexKeys' && value === null) return undefined;
    switch (value?.kind) {
      case 'TextContent': return new TextContent(value.Text);
      case 'SummaryContent': return new SummaryContent(value.Text, value.ThroughSequence);
      case 'ToolCallContent': return new ToolCallContent(value.CallId, value.ToolName, value.ArgumentsJson);
      case 'ToolResultContent': return new ToolResultContent(value.CallId, value.ResultJson, value.IsError);
      default: return value;
    }
  }) as T;
}

export function restoreSession(session: WireSession): LLMSessionContext {
  return { ...session, Anchors: new Map(Object.entries(session.Anchors)),
    Segments: new Map(Object.entries(session.Segments).map(([key, segment]) => [Number(key), segment])) };
}
