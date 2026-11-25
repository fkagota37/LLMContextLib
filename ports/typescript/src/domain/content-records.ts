// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { canonicalInt64, type Int64 } from './int64.js';
import { isNativePayload } from './payload-identity.js';
import { ContextContent, SummaryContent, TextContent, ToolCallContent, ToolResultContent } from './session.js';

type BuiltInContent = TextContent | SummaryContent | ToolCallContent | ToolResultContent;
type Field = string | Int64 | boolean;

function builtIn(value: ContextContent): BuiltInContent {
  if (!isNativePayload(value)) throw new TypeError('Expected a built-in context content record.');
  return value as BuiltInContent;
}

function fields(value: BuiltInContent): readonly Field[] {
  switch (value.kind) {
    case 'TextContent': return [value.Text];
    case 'SummaryContent': return [value.Text, canonicalInt64(value.ThroughSequence)];
    case 'ToolCallContent': return [value.CallId, value.ToolName, value.ArgumentsJson];
    case 'ToolResultContent': return [value.CallId, value.ResultJson, value.IsError];
  }
}

function equals(left: ContextContent | null, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || typeof right !== 'object' || right === null || !isNativePayload(left) || !isNativePayload(right)) return false;
  const first = left as BuiltInContent;
  const second = right as BuiltInContent;
  if (first.kind !== second.kind) return false;
  const other = fields(second);
  return fields(first).every((field, index) => field === other[index]);
}

function hash(content: ContextContent): number {
  const value = builtIn(content);
  let result = 0x811c9dc5;
  for (const field of [value.kind, ...fields(value)]) {
    const text = `${typeof field}:${String(field)}`;
    result = Math.imul(result ^ text.length, 0x01000193);
    for (let index = 0; index < text.length; index++) result = Math.imul(result ^ text.charCodeAt(index), 0x01000193);
  }
  return result;
}

function format(content: ContextContent): string {
  const value = builtIn(content);
  const names = {
    TextContent: ['Text'],
    SummaryContent: ['Text', 'ThroughSequence'],
    ToolCallContent: ['CallId', 'ToolName', 'ArgumentsJson'],
    ToolResultContent: ['CallId', 'ResultJson', 'IsError'],
  }[value.kind];
  const members = fields(value).map((field, index) =>
    `${names[index]} = ${typeof field === 'boolean' ? (field ? 'True' : 'False') : String(field)}`);
  return `${value.kind} { ${members.join(', ')} }`;
}

function deconstruct(value: TextContent): readonly [string];
function deconstruct(value: SummaryContent): readonly [string, Int64];
function deconstruct(value: ToolCallContent): readonly [string, string, string];
function deconstruct(value: ToolResultContent): readonly [string, string, boolean];
function deconstruct(value: BuiltInContent): readonly Field[];
function deconstruct(value: BuiltInContent): readonly Field[] {
  return Object.freeze(fields(builtIn(value)));
}

function clone<T extends ContextContent>(content: T): T {
  const value = builtIn(content);
  const copy = (): BuiltInContent => {
    switch (value.kind) {
      case 'TextContent': return new TextContent(value.Text);
      case 'SummaryContent': return new SummaryContent(value.Text, value.ThroughSequence);
      case 'ToolCallContent': return new ToolCallContent(value.CallId, value.ToolName, value.ArgumentsJson);
      case 'ToolResultContent': return new ToolResultContent(value.CallId, value.ResultJson, value.IsError);
    }
  };
  return copy() as unknown as T;
}

/** Explicit record operations; JavaScript identity and built-in Map equality are unchanged. */
export const ContextContentRecords = Object.freeze({ equals, hash, format, deconstruct, clone });
