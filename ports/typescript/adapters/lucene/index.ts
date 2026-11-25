// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import {
  configureExecutionProviders, ContextExecutionRecipe, isLexicalCharacter, lowerLexicalCharacter,
  type LLMContextFactoryBuilder,
} from 'llmcontextlib-port-typescript/adapter-support';

export enum LuceneTermCollection {
  RangeBuffer = 'RangeBuffer',
  CharTerm = 'CharTerm',
}

export function WithLuceneTermCollection(builder: LLMContextFactoryBuilder, collection = LuceneTermCollection.RangeBuffer): LLMContextFactoryBuilder {
  if (!builder) throw new TypeError('Builder is required.');
  if (!Object.values(LuceneTermCollection).includes(collection)) throw new RangeError('Invalid Lucene collector selection.');
  return builder[configureExecutionProviders]((recipe) => new ContextExecutionRecipe(() => ({
    Name: collection === LuceneTermCollection.RangeBuffer ? 'LuceneRangeBuffer' : 'LuceneCharTerm',
    Collect: collection === LuceneTermCollection.RangeBuffer ? ranges : charTerms,
    WorkerCollection: { Module: import.meta.url, Export: collection === LuceneTermCollection.RangeBuffer ? 'ranges' : 'charTerms' },
  }), true, recipe.Memo, recipe.MemoReservation));
}

/** @internal */
export function ranges(text: string, checkCancellation?: () => void): readonly string[] {
  const distinct = new Set<string>();
  const scratch: string[] = [];
  let position = 0;
  const check = () => { if ((position & 1023) === 0) checkCancellation?.(); };
  while (position < text.length) {
    check();
    if (!isLexicalCharacter(text[position])) { position++; continue; }
    let length = 0;
    while (position < text.length && isLexicalCharacter(text[position])) {
      check();
      scratch[length++] = lowerLexicalCharacter(text[position++]);
    }
    scratch.length = length;
    distinct.add(scratch.join(''));
  }
  return Object.freeze([...distinct].sort());
}

/** @internal */
export function charTerms(text: string, checkCancellation?: () => void): readonly string[] {
  const distinct = new Set<string>();
  let term = '';
  for (let offset = 0; offset < text.length; offset++) {
    if ((offset & 1023) === 0) checkCancellation?.();
    const character = text[offset];
    if (isLexicalCharacter(character)) term += lowerLexicalCharacter(character);
    else if (term) { distinct.add(term); term = ''; }
  }
  if (term) distinct.add(term);
  return Object.freeze([...distinct].sort());
}
