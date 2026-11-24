// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { SummaryContent, TextContent, ToolCallContent, ToolResultContent, type ContextContent } from '../domain/session.js';

export function restoreWireContent(content: ContextContent): ContextContent {
  const wire = content as TextContent | ToolCallContent | ToolResultContent | SummaryContent;
  switch (wire?.kind) {
    case 'TextContent': return new TextContent(wire.Text);
    case 'ToolCallContent': return new ToolCallContent(wire.CallId, wire.ToolName, wire.ArgumentsJson);
    case 'ToolResultContent': return new ToolResultContent(wire.CallId, wire.ResultJson, wire.IsError);
    case 'SummaryContent': return new SummaryContent(wire.Text, wire.ThroughSequence);
    default: return content;
  }
}
