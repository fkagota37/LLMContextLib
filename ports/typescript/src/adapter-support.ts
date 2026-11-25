// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export { configureExecutionProviders, type LLMContextFactoryBuilder } from './factory.js';
export { canonicalInt64, isPositiveInt64, type Int64 } from './domain/int64.js';
export { scalarRecord } from './domain/scalar-records.js';
export { ContextExecutionRecipe, type TermMemo } from './execution/strategy.js';
export { isLexicalCharacter, lowerLexicalCharacter } from './policies/lexical.js';
export { estimateTermBytes } from './storage/session-index.js';
