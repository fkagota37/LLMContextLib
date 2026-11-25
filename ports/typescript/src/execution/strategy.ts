// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextIndexingMode } from '../domain/index-keys.js';
import { canonicalInt64, incrementCounter, isInt64, type Int64 } from '../domain/int64.js';
import type { ContextContent } from '../domain/session.js';
import type { LLMContextOptions } from '../options.js';
import { Terms, Text } from '../policies/context.js';
import { scanTerms, textLength, textParts, type TermPrefix } from '../policies/lexical.js';
import { partitionInfrastructureBytes, partitionRecoveryBytes } from '../storage/partitioned-index.js';

export enum ContextIndexingStrategy {
  Configured = 'Configured',
  Synchronous = 'Synchronous',
  AppendOptimized = 'AppendOptimized',
}

export enum ContextPreparationStrategy {
  Configured = 'Configured',
  Speculative = 'Speculative',
  Serialized = 'Serialized',
}

export interface ContextExecutionOptions {
  readonly Indexing: ContextIndexingStrategy;
  readonly Preparation: ContextPreparationStrategy;
  readonly MinimumDeferredCharacters: number;
}

export interface ContextExecutionStatistics {
  readonly TermCollector: string;
  readonly TermMemo: string;
  readonly Indexing: ContextIndexingStrategy;
  readonly Preparation: ContextPreparationStrategy;
  readonly EstimatedReservedBytes: Int64;
  readonly MemoEntries: number;
  readonly TermCollections: Int64;
  readonly MemoHits: Int64;
  readonly MemoMisses: Int64;
  readonly MemoBypasses: Int64;
  readonly MemoAdmissionBypasses: Int64;
  readonly SynchronousEntries: Int64;
  readonly DeferredEntries: Int64;
  readonly DeferredCapacityFallbacks: Int64;
  readonly SpeculativePreparations: Int64;
  readonly SerializedPreparations: Int64;
}

type ExecutionCounts = {
  -readonly [K in Exclude<keyof ContextExecutionStatistics,
    'TermCollector' | 'TermMemo' | 'Indexing' | 'Preparation' | 'EstimatedReservedBytes' | 'MemoEntries'>]: Int64;
};

export const defaultContextExecutionOptions: ContextExecutionOptions = Object.freeze({
  Indexing: ContextIndexingStrategy.Configured,
  Preparation: ContextPreparationStrategy.Configured,
  MinimumDeferredCharacters: 8192,
});

export function validateContextExecutionOptions(options: ContextExecutionOptions): void {
  if (!Number.isInteger(options.MinimumDeferredCharacters) || options.MinimumDeferredCharacters <= 0 || options.MinimumDeferredCharacters > 0x7fff_ffff ||
      !Object.values(ContextIndexingStrategy).includes(options.Indexing) ||
      !Object.values(ContextPreparationStrategy).includes(options.Preparation)) {
    throw new RangeError('Invalid execution strategy options.');
  }
}

export interface TermCollector {
  readonly Name: string;
  readonly WorkerCollection?: { readonly Module: string; readonly Export: string };
  Collect(text: string): readonly string[];
  Complete?(content: ContextContent, prefix: TermPrefix, formatted?: string): readonly string[];
}

export interface TermMemo {
  readonly Name: string;
  readonly MaximumTextCharacters: number;
  readonly Count: number;
  TryGet(text: string): readonly string[] | undefined;
  TryAdd(text: string, terms: readonly string[]): boolean;
  dispose(): void;
}

export const nativeCollector = (): TermCollector => ({
  Name: 'Native',
  Collect: Terms,
  Complete: (content, prefix) => scanTerms(textParts(content), Infinity, Infinity, prefix.ResumeOffset, prefix.Terms).Terms,
});

export class ContextExecutionRecipe {
  public static readonly InfrastructureBytes = 512;

  constructor(
    public readonly Collector: () => TermCollector = nativeCollector,
    public readonly HasCustomCollector = false,
    public readonly Memo?: () => TermMemo,
    public readonly MemoReservation: Int64 = 0,
  ) { Object.freeze(this); }

  public get ReservedBytes(): Int64 {
    return canonicalInt64(BigInt(ContextExecutionRecipe.InfrastructureBytes) + BigInt(this.MemoReservation));
  }

  public Validate(options: LLMContextOptions): void {
    if (options.IndexingMode === ContextIndexingMode.ProducerOwned && (this.HasCustomCollector || this.Memo)) {
      throw new TypeError('Producer-owned indexing cannot use text collectors or term memoization.');
    }
    let other = options.Execution.Indexing !== ContextIndexingStrategy.Synchronous && options.DeferredIndexing ?
      1024n + 128n * BigInt(options.DeferredIndexing.MaximumPendingEntries) : 0n;
    if (options.PartitionedIndex) {
      other += BigInt(partitionInfrastructureBytes(options.PartitionedIndex)) + BigInt(partitionRecoveryBytes(options.PartitionedIndex));
    }
    if (!isInt64(this.MemoReservation) || this.MemoReservation < 0 ||
        BigInt(this.ReservedBytes) + other > options.EstimatedResidentByteBudget) {
      throw new RangeError('Execution infrastructure and memo reservation exceed the resident budget.');
    }
  }
}

export const indexWorkReservation = (characters: number) => 512 + 8 * characters + indexRetentionReservation(characters);
export const indexRetentionReservation = (characters: number) => 1024 + 200 * Math.ceil(characters / 2) + 4 * characters;

export class ContextExecution {
  private readonly collector: TermCollector;
  private readonly memo?: TermMemo;
  private readonly counts: ExecutionCounts = {
    TermCollections: 0, MemoHits: 0, MemoMisses: 0, MemoBypasses: 0, MemoAdmissionBypasses: 0,
    SynchronousEntries: 0, DeferredEntries: 0, DeferredCapacityFallbacks: 0,
    SpeculativePreparations: 0, SerializedPreparations: 0,
  };

  constructor(private readonly recipe: ContextExecutionRecipe, private readonly options: LLMContextOptions) {
    this.collector = recipe.Collector();
    this.memo = recipe.Memo?.();
  }

  private get preparation(): ContextPreparationStrategy {
    const mode = this.options.Execution.Preparation;
    return mode !== ContextPreparationStrategy.Configured ? mode : this.options.SerializeSessionPreparation ?
      ContextPreparationStrategy.Serialized : ContextPreparationStrategy.Speculative;
  }

  public get Statistics(): ContextExecutionStatistics {
    return Object.freeze({
      TermCollector: this.options.IndexingMode === ContextIndexingMode.ProducerOwned ? 'ProducerOwned' : this.collector.Name,
      TermMemo: this.memo?.Name ?? 'None', Indexing: this.options.Execution.Indexing,
      Preparation: this.preparation, EstimatedReservedBytes: this.recipe.ReservedBytes,
      MemoEntries: this.memo?.Count ?? 0, ...this.counts,
    });
  }

  private increment(counter: keyof ExecutionCounts): void {
    this.counts[counter] = incrementCounter(this.counts[counter]);
  }

  public RecordSuppliedEntry(): void { this.increment('SynchronousEntries'); }

  public get CanCollectInWorker(): boolean {
    return this.recipe.Collector === nativeCollector || this.collector.WorkerCollection !== undefined;
  }

  public BeginBackgroundCollection(content: ContextContent) {
    const memoKey = this.memoText(content, textLength(content));
    const cached = this.tryMemo(memoKey);
    if (!cached) this.increment('TermCollections');
    return {
      MemoKey: memoKey, Cached: cached,
      Collector: this.collector.WorkerCollection,
    };
  }

  public FinishBackgroundCollection(memoKey: string | undefined, terms: readonly string[]): void {
    this.remember(memoKey, terms);
  }

  public SelectSerializedPreparation(): boolean {
    const serialized = this.preparation === ContextPreparationStrategy.Serialized;
    this.increment(serialized ? 'SerializedPreparations' : 'SpeculativePreparations');
    return serialized;
  }

  public Collect(text: string): readonly string[] {
    this.increment('TermCollections');
    return this.collector.Collect(text);
  }

  public PrepareEntry(content: ContextContent, existing: boolean, canDefer: (bytes: number) => boolean): TermPrefix {
    const characters = textLength(content);
    const memoKey = this.memoText(content, characters);
    const cached = this.tryMemo(memoKey);
    if (cached) {
      this.increment('SynchronousEntries');
      return { Terms: cached, ResumeOffset: characters, Complete: true };
    }
    const limits = this.options.DeferredIndexing;
    let defer = !!limits && this.options.Execution.Indexing !== ContextIndexingStrategy.Synchronous;
    if (defer && this.options.Execution.Indexing === ContextIndexingStrategy.AppendOptimized) {
      defer = !existing && characters >= this.options.Execution.MinimumDeferredCharacters;
      if (defer && !canDefer(characters)) {
        this.increment('DeferredCapacityFallbacks');
        defer = false;
      }
    }
    if (defer) {
      const prefix = scanTerms(textParts(content), limits!.ForegroundWords, limits!.ForegroundCharacters);
      if (!prefix.Complete) {
        this.increment('DeferredEntries');
        return prefix;
      }
      this.increment('SynchronousEntries');
      this.remember(memoKey, prefix.Terms);
      return prefix;
    }
    const terms = this.Collect(memoKey ?? Text(content));
    this.increment('SynchronousEntries');
    this.remember(memoKey, terms);
    return { Terms: terms, ResumeOffset: characters, Complete: true };
  }

  public Complete(content: ContextContent, prefix: TermPrefix): readonly string[] {
    const memoKey = this.memoText(content, textLength(content));
    const cached = this.tryMemo(memoKey);
    if (cached) return cached;
    this.increment('TermCollections');
    const terms = this.collector.Complete ?
      this.collector.Complete(content, prefix, memoKey) : this.collector.Collect(memoKey ?? Text(content));
    this.remember(memoKey, terms);
    return terms;
  }

  private memoText(content: ContextContent, characters: number): string | undefined {
    if (!this.memo) return undefined;
    if (characters <= this.memo.MaximumTextCharacters) return Text(content);
    this.increment('MemoBypasses');
    return undefined;
  }

  private tryMemo(text: string | undefined): readonly string[] | undefined {
    if (text === undefined) return undefined;
    const terms = this.memo!.TryGet(text);
    this.increment(terms ? 'MemoHits' : 'MemoMisses');
    return terms;
  }

  private remember(text: string | undefined, terms: readonly string[]): void {
    if (text !== undefined && !this.memo!.TryAdd(text, terms)) this.increment('MemoAdmissionBypasses');
  }

  public dispose(): void { this.memo?.dispose(); }
}
