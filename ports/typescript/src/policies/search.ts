// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { ContextEntry, ContextSearchHit } from '../domain/session.js';
import { compareInt64 } from '../domain/int64.js';
import { Terms } from './context.js';
import { canonicalizeSearchText, getEntryText, truncateForSnippet } from './text.js';

export function filterExactTextMatches(entries: readonly ContextEntry[], query: string, limit: number): readonly ContextSearchHit[] {
  const terms = Terms(canonicalizeSearchText(query));
  if (!terms.length || limit <= 0) {
    return [];
  }

  const matches: ContextSearchHit[] = [];
  for (const entry of entries) {
    const text = getEntryText(entry);
    const textTerms = new Set(Terms(text));

    if (terms.every((term) => textTerms.has(term))) {
      matches.push({
        EntryId: entry.EntryId,
        AnchorId: null,
        Snippet: truncateForSnippet(text),
        Sequence: entry.Sequence,
        SessionRevision: 0,
      });
    }
    if (matches.length >= limit) {
      return matches;
    }
  }
  return matches;
}

export function filterKeyMatches(entries: readonly ContextEntry[], keys: readonly string[], limit: number): readonly ContextSearchHit[] {
  if (!keys.length || limit <= 0) {
    return [];
  }

  const matches: ContextSearchHit[] = [];
  const requestedKeys = [...new Set(keys)];
  for (const entry of entries) {
    const entryKeys = entry.IndexKeys ?? [];
    if (requestedKeys.every((key) => entryKeys.includes(key))) {
      matches.push({
        EntryId: entry.EntryId,
        AnchorId: null,
        Snippet: truncateForSnippet(getEntryText(entry)),
        Sequence: entry.Sequence,
        SessionRevision: 0,
      });
    }
    if (matches.length >= limit) {
      return matches;
    }
  }
  return matches;
}

export function orderSearchMatches(matches: readonly ContextSearchHit[]): readonly ContextSearchHit[] {
  return [...matches].sort((a, b) => compareInt64(a.Sequence, b.Sequence) || a.EntryId.localeCompare(b.EntryId));
}
