// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defaultBitFasterTermMemoOptions, WithBitFasterTermMemoization } from '../adapters/bitfaster/index.js';
import { LuceneTermCollection, WithLuceneTermCollection } from '../adapters/lucene/index.js';
import { configureExecutionProviders, LLMContextFactory, type LLMContextFactoryBuilder } from '../src/factory.js';
import { isLexicalCharacter, lowerLexicalCharacter } from '../src/policies/lexical.js';
import { Terms } from '../src/policies/context.js';
import type { ContextExecutionRecipe, TermMemo } from '../src/execution/strategy.js';
import { ForegroundLfu } from './foreground-lfu.js';
import { sourceDigest } from './source-digest.js';

const repeated = Array(128).fill('BUILD workers build workers').join(' ');
const unique = Array.from({ length: 512 }, (_, index) => `token${String(index).padStart(4, '0')}`).join(' ');
const long = 'A'.repeat(16_384);
const fixtures = {
  Empty: '', Query: 'Build workers WORKERS', Repeated: repeated,
  ToolJson: Array(32).fill('{"tool":"build-profiler","version":"example-v1","workload":"example-build","workers":4,"outcome":"Completed"}').join('\n'),
  Unique: unique, Unicode: '\u00c9CLAIR caf\u00e9 CAF\u00c9 \u03a3\u03c2 \u0130\u0131 \u4e2d\u6587123 \ud835\udd18nicode a\u0301 '.repeat(96),
  LongWord: long, Punctuation: '!'.repeat(4096),
};

function recipe(builder: LLMContextFactoryBuilder): ContextExecutionRecipe {
  let state: ContextExecutionRecipe | undefined;
  builder[configureExecutionProviders]((value) => { state = value; return value; });
  assert(state);
  return state;
}

function direct(text: string) {
  const distinct = new Set<string>();
  let word = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (isLexicalCharacter(character)) word += lowerLexicalCharacter(character);
    else if (word) { distinct.add(word); word = ''; }
  }
  if (word) distinct.add(word);
  return Object.freeze(Array.from(distinct).sort());
}

function ranges(text: string) {
  const folded = text.split('').map(lowerLexicalCharacter);
  const buckets = new Map<number, [number, number][]>();
  for (let position = 0; position < text.length;) {
    if (!isLexicalCharacter(text[position])) { position++; continue; }
    const start = position;
    let hash = 0;
    while (position < text.length && isLexicalCharacter(text[position])) hash = Math.imul(hash, 31) + folded[position++].charCodeAt(0) | 0;
    const bucket = buckets.get(hash) ?? [];
    if (!bucket.some(([from, to]) => {
      if (to - from !== position - start) return false;
      for (let i = 0; i < to - from; i++) if (folded[from + i] !== folded[start + i]) return false;
      return true;
    })) {
      bucket.push([start, position]);
      buckets.set(hash, bucket);
    }
  }
  return Object.freeze([...buckets.values()].flatMap((bucket) => bucket.map(([start, end]) =>
    folded.slice(start, end).join(''))).sort());
}

const collectors = new Map<string, (text: string) => readonly string[]>([
  ['Current', Terms], ['DirectSort', direct], ['NormalizedRanges', ranges],
  ...Object.values(LuceneTermCollection).map((collection) => {
    const collector = recipe(WithLuceneTermCollection(LLMContextFactory.Create(), collection)).Collector();
    return [collector.Name, (text: string) => collector.Collect(text)] as const;
  }),
]);
const reverse = process.argv.includes('--reverse');
const verifyOnly = process.argv.includes('--verify-only');
const mode = process.argv[2];
assert(mode === 'tokenization' || mode === 'cache' || mode === 'cache-heap',
  'Usage: term-diagnostics.ts tokenization|cache|cache-heap [--verify-only] [--reverse]');
const sources = ['benchmarks\\term-diagnostics.ts', 'src\\policies\\lexical.ts', 'src\\execution\\strategy.ts',
  'benchmarks\\foreground-lfu.ts', 'adapters\\lucene\\index.ts', 'adapters\\bitfaster\\index.ts', 'package-lock.json'];
const evidence = { runtime: process.version, v8: process.versions.v8, platform: process.platform, architecture: process.arch,
  sourceSha256: sourceDigest(), measurementScope: 'Nonisolated process diagnostic; not throughput, capacity, or a performance comparison claim.',
  execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null, command: process.argv,
  lfu: { dependency: 'BitFaster.Caching 2.6.1', scheduling: 'Foreground', hash: 'UTF-16 FNV-1a; target-local, not randomized CLR string hashes',
    sketchAging: 'All four counters advance (pinned AVX path); 72 differential traces. Scalar source matrix crashes in pinned dependency; not qualified.' },
  sources: sources.map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) };
type DiagnosticMemo = TermMemo & { Maintain?(): void; readonly Keys?: readonly string[] };
const memoFactories = new Map<string, (() => DiagnosticMemo) | null>([
  ['Uncached', null],
  ['BitFasterConcurrentLru', recipe(WithBitFasterTermMemoization(LLMContextFactory.Create(), {
    ...defaultBitFasterTermMemoOptions, MaximumEstimatedBytes: 32 * 1024 * 1024,
  })).Memo!],
  ['BitFasterLfuForeground', () => new ForegroundLfu()],
]);
const order = (round: number) => {
  const policies = [...memoFactories.keys()];
  return policies.map((_, index) => {
    const offset = (index + round) % policies.length;
    return policies[(round % 2 === 0) !== reverse ? offset : policies.length - offset - 1];
  });
};

if (mode === 'tokenization') {
  const samples = [];
  for (const [fixture, text] of Object.entries(fixtures)) {
    const expected = Terms(text);
    const methods = [...collectors];
    for (const [name, run] of methods) {
      assert.deepEqual(run(text), expected, `${fixture}/${name}`);
      if (!verifyOnly) for (let index = 0; index < 256; index++) run(text);
    }
    if (verifyOnly) continue;
    const iterations = Math.max(64, Math.min(20_000, Math.floor(1_000_000 / Math.max(1, text.length))));
    for (let round = 0; round < 7; round++) {
      for (let position = 0; position < methods.length; position++) {
        const offset = (position + round) % methods.length;
        const [method, run] = methods[(round % 2 === 0) !== reverse ? offset : methods.length - offset - 1];
        let consumed = 0;
        const start = process.hrtime.bigint();
        for (let call = 0; call < iterations; call++) consumed += run(text).length;
        const elapsedNs = process.hrtime.bigint() - start;
        assert.equal(consumed, iterations * expected.length);
        samples.push({ fixture, method, round, characters: text.length, terms: expected.length, iterations, elapsedNs: String(elapsedNs) });
      }
    }
  }
  console.log(JSON.stringify({ diagnostic: mode, ...evidence, verifiedInputs: Object.keys(fixtures).length, samples }));
} else if (mode === 'cache-heap') {
  const collect = globalThis.gc;
  assert(collect, 'cache-heap requires Node --expose-gc');
  const heapUsed = () => { collect(); return process.memoryUsage().heapUsed; };
  const { Capacity: capacity } = defaultBitFasterTermMemoOptions;
  const samples = [];
  for (const [profile, text] of Object.entries({ Query: 'build workers', Repeated: repeated, UniqueTerms: unique, Oversized: long })) {
    for (let round = 0; round < (verifyOnly ? 1 : 7); round++) {
      for (const policy of order(round)) {
        const before = heapUsed();
        const memo = memoFactories.get(policy)?.() ?? null;
        const key = (index: number) => `${text} retained${index}`;
        const calls = capacity * 16;
        try {
          for (let index = 0; index < calls; index++) {
            const input = key(index);
            const terms = Terms(input);
            memo?.TryAdd(input, terms);
          }
          memo?.Maintain?.();
          const live = heapUsed();
          const count = memo?.Count ?? 0;
          let estimatedKeyBytes = 0;
          let estimatedMembershipBytes = 0;
          let observed = 0;
          for (let index = 0; index < calls; index++) {
            const input = key(index);
            const terms = memo?.TryGet(input);
            if (!terms) continue;
            assert.deepEqual(terms, Terms(input));
            observed++;
            estimatedKeyBytes += 24 + 2 * input.length;
            estimatedMembershipBytes += 8 * terms.length;
          }
          assert.equal(count, observed);
          assert(count <= capacity);
          if (!memo || profile === 'Oversized') assert.equal(count, 0);
          else assert(count > 0);
          memo?.dispose();
          assert.equal(memo?.Count ?? 0, 0);
          const disposed = heapUsed();
          samples.push({ profile, policy, round, calls, count,
            estimatedKeyBytes, estimatedMembershipBytes, before, live, disposed, liveDelta: live - before,
            disposedDelta: disposed - before });
        } finally { memo?.dispose(); }
      }
    }
  }
  console.log(JSON.stringify({ diagnostic: mode, ...evidence, samples }));
} else {
  const samples = [];
  const run = (policy: string, seeds: readonly string[], inputs: readonly string[], individual: boolean) => {
    const memo = memoFactories.get(policy)?.() ?? null;
    let computations = 0;
    const obtain = (text: string) => {
      const cacheable = memo && text.length <= memo.MaximumTextCharacters;
      const hit = cacheable ? memo.TryGet(text) : undefined;
      if (hit) return hit;
      const terms = Terms(text);
      computations++;
      if (cacheable) memo.TryAdd(text, terms);
      return terms;
    };
    try {
      for (const seed of seeds) obtain(seed);
      memo?.Maintain?.();
      computations = 0;
      const output: (readonly string[])[] = [];
      const elapsed: number[] = [];
      const start = process.hrtime.bigint();
      for (const input of inputs) {
        const before = individual ? process.hrtime.bigint() : 0n;
        output.push(obtain(input));
        if (individual) elapsed.push(Number(process.hrtime.bigint() - before));
      }
      const elapsedNs = process.hrtime.bigint() - start;
      inputs.forEach((value, index) => assert.deepEqual(output[index], Terms(value)));
      memo?.Maintain?.();
      const keys = memo?.Keys ?? [...new Set([...seeds, ...inputs])].filter((value) => memo?.TryGet(value) !== undefined);
      const sorted = [...elapsed].sort((a, b) => a - b);
      const percentile = (rate: number) => sorted[Math.ceil(sorted.length * rate) - 1] ?? null;
      assert.equal(keys.length, memo?.Count ?? 0);
      return { elapsedNs: String(elapsedNs), computations,
        retainedKeys: keys.map((key) => ({ characters: key.length, sha256: createHash('sha256').update(key, 'utf16le').digest('hex') })),
        p50Ns: percentile(.5), p95Ns: percentile(.95), p99Ns: percentile(.99), rawNs: elapsed };
    } finally { memo?.dispose(); }
  };
  for (const [profile, text] of Object.entries({ Query: 'build workers', Repeated: repeated, UniqueTerms: unique, Oversized: long })) {
    for (const scenario of profile === 'Oversized' ? ['HotEqualText'] :
      profile === 'Repeated' ? ['HotEqualText', 'ColdUnique', 'Mixed80Hot20Cold', 'Churn256'] :
        ['HotEqualText', 'ColdUnique', 'Mixed80Hot20Cold']) {
      const hotCount = scenario === 'Mixed80Hot20Cold' ? 16 : scenario === 'Churn256' ? 256 : 1;
      const hot = Array.from({ length: hotCount }, (_, index) => hotCount === 1 ? text : `${text} hot${index}`);
      const seeds = scenario === 'ColdUnique' || scenario === 'Churn256' ? [] : hot;
      for (let round = 0; round < (verifyOnly ? 1 : 7); round++) {
        const inputs = Array.from({ length: verifyOnly ? 64 : 512 }, (_, call) => {
          const index = round * 512 + call;
          return scenario === 'ColdUnique' || scenario === 'Mixed80Hot20Cold' && index % 5 === 0
            ? `${text} cold${index}` : hot[index % hot.length];
        });
        for (const policy of order(round)) {
          const batch = run(policy, seeds, inputs, false);
          if (policy === 'Uncached' || scenario === 'ColdUnique' || profile === 'Oversized') {
            assert.equal(batch.computations, inputs.length);
          }
          else if (scenario === 'HotEqualText') assert.equal(batch.computations, 0);
          if (verifyOnly) continue;
          const perCall = run(policy, seeds, inputs, true);
          assert.equal(batch.computations, perCall.computations);
          samples.push({ profile, scenario, policy, round, calls: inputs.length, batch, perCall });
        }
      }
    }
  }
  console.log(JSON.stringify({ diagnostic: mode, ...evidence, samples }));
}
