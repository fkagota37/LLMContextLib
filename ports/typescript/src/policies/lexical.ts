// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { SummaryContent, TextContent, ToolCallContent, ToolResultContent, type ContextContent } from '../domain/session.js';

export function textParts(content: ContextContent): readonly string[] {
  if (content instanceof TextContent || content instanceof SummaryContent) return [content.Text];
  if (content instanceof ToolCallContent) return [content.ToolName, ' ', content.CallId, ' ', content.ArgumentsJson];
  if (content instanceof ToolResultContent) return [content.CallId, ' ', content.ResultJson];
  throw new TypeError('Only the immutable built-in content cases are admitted.');
}

export function textLength(content: ContextContent): number {
  return textParts(content).reduce((length, part) => length + part.length, 0);
}

export interface TermPrefix {
  readonly Terms: readonly string[];
  readonly ResumeOffset: number;
  readonly Complete: boolean;
}

const letterOrDigit = /[\p{L}\p{Nd}]/u;
// BMP differences measured against the pinned .NET 8 and 9 lexical reference.
const newerLetters = new Set([
  2191, 3164, 3292, 7305, 7306, 42955, 42956, 42957, 42958, 42959, 42962, 42964, 42970, 42971, 42972, 42993,
]);
export const isLexicalCharacter = (character: string) =>
  character.length === 1 && !newerLetters.has(character.charCodeAt(0)) && letterOrDigit.test(character);
export const lowerLexicalCharacter = (character: string) => {
  const lower = character.toLowerCase();
  return lower.length === 1 ? lower : character;
};

export function scanTerms(parts: readonly string[], maximumWords = Infinity, maximumCharacters = Infinity,
  start = 0, seed: readonly string[] = [], checkCancellation?: () => void): TermPrefix {
  const terms = new Set(seed);
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = (offset: number, complete: boolean): TermPrefix => ({
    Terms: Object.freeze([...terms].sort()), ResumeOffset: offset, Complete: complete,
  });
  let position = 0;
  let inspected = 0;
  let words = 0;
  let wordStart = start;
  let word = '';
  for (const part of parts) {
    let offset = Math.min(part.length, Math.max(0, start - position));
    position += offset;
    for (; offset < part.length; offset++, position++, inspected++) {
      if ((inspected & 1023) === 0) checkCancellation?.();
      if (inspected === maximumCharacters) return result(word ? wordStart : position, false);
      const character = part[offset];
      if (isLexicalCharacter(character)) {
        if (!word) wordStart = position;
        word += lowerLexicalCharacter(character);
      } else if (word) {
        terms.add(word);
        word = '';
        if (++words === maximumWords) return result(position + 1, position + 1 === length);
      }
    }
  }
  if (word) terms.add(word);
  return result(position, true);
}
