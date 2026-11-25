// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export interface ICollector<T> {
  readonly entries: readonly T[];
  add(item: T): void;
  clear(): void;
}

export class ListCollector<T> implements ICollector<T> {
  public readonly entries: T[] = [];

  public add(item: T): void {
    this.entries.push(item);
  }

  public clear(): void {
    this.entries.length = 0;
  }
}

export function requireNativeCollectorAccess(enabled: boolean): void {
  if (!enabled) {
    throw new Error('Native term collection requires explicit opt-in through the execution boundary.');
  }
}

export class NativeTermCollector implements ICollector<string> {
  public readonly entries: string[] = [];

  constructor(enabled = true) {
    requireNativeCollectorAccess(enabled);
  }

  public add(item: string): void {
    if (item && !this.entries.includes(item)) {
      this.entries.push(item);
    }
  }

  public clear(): void {
    this.entries.length = 0;
  }
}
