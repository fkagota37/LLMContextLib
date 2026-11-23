// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { SummaryContent, TextContent, ToolCallContent, ToolResultContent, type ContextEntry } from '../domain/session.js';

export function getEntryText(entry: ContextEntry): string {
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

export function canonicalizeSearchText(value: string): string {
  return value.trim();
}

export function lexCompareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function estimateTextBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function truncateForSnippet(value: string, maxLength = 120): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}
