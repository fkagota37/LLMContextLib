// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { ContextEntry, ContextSearchHit } from '../domain/session.js';
import { compareInt64 } from '../domain/int64.js';
import { canonicalizeSearchText, getEntryText, truncateForSnippet } from './text.js';

function normalizeQueryTerms(value: string): readonly string[] {
  const normalized = canonicalizeSearchText(value);
  if (!normalized) {
    return [];
  }

  const terms = new Set<string>();
  let token = '';
  for (const character of normalized) {
    if (/[A-Za-z0-9]/u.test(character)) {
      token += character.toLowerCase();
    } else if (token.length > 0) {
      terms.add(token);
      token = '';
    }
  }
  if (token.length > 0) {
    terms.add(token);
  }
  return [...terms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function filterExactTextMatches(entries: readonly ContextEntry[], query: string, limit: number): readonly ContextSearchHit[] {
  const terms = normalizeQueryTerms(query);
  if (!terms.length || limit <= 0) {
    return [];
  }

  const matches: ContextSearchHit[] = [];
  for (const entry of entries) {
    const text = getEntryText(entry);
    const textTerms = new Set<string>();
    let token = '';
    for (const character of text) {
      if (/[A-Za-z0-9]/u.test(character)) {
        token += character.toLowerCase();
      } else if (token.length > 0) {
        textTerms.add(token);
        token = '';
      }
    }
    if (token.length > 0) {
      textTerms.add(token);
    }

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
  const keySet = new Set(keys);
  for (const entry of entries) {
    const entryKeys = entry.IndexKeys ?? [];
    if (entryKeys.some((key) => keySet.has(key))) {
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
