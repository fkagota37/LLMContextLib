// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextError } from '../domain/errors.js';
import type { ILLMContextReadLease } from '../domain/reads.js';

class CurrentRead implements ILLMContextReadLease {
  private lease: ILLMContextReadLease | null = null;
  constructor(private open: (() => ILLMContextReadLease) | null) {}

  private get read(): ILLMContextReadLease {
    if (!this.open) throw new ContextError('Disposed', 'This current read scope has ended.');
    return this.lease ??= this.open();
  }

  get Session() { return this.read.Session; }
  get IndexingMode() { return this.read.IndexingMode; }
  get MemoryRevision() { return this.read.MemoryRevision; }
  get IndexStatus() { return this.read.IndexStatus; }
  TryFindEntry(...args: Parameters<ILLMContextReadLease['TryFindEntry']>) { return this.read.TryFindEntry(...args); }
  ReadRange(...args: Parameters<ILLMContextReadLease['ReadRange']>) { return this.read.ReadRange(...args); }
  ReadPage(...args: Parameters<ILLMContextReadLease['ReadPage']>) { return this.read.ReadPage(...args); }
  Search(...args: Parameters<ILLMContextReadLease['Search']>) { return this.read.Search(...args); }
  SearchKeys(...args: Parameters<ILLMContextReadLease['SearchKeys']>) { return this.read.SearchKeys(...args); }
  SearchIndexed(...args: Parameters<ILLMContextReadLease['SearchIndexed']>) { return this.read.SearchIndexed(...args); }
  ResolveAnchor(...args: Parameters<ILLMContextReadLease['ResolveAnchor']>) { return this.read.ResolveAnchor(...args); }
  GetApplicableMemory(...args: Parameters<ILLMContextReadLease['GetApplicableMemory']>) { return this.read.GetApplicableMemory(...args); }

  dispose(): void {
    this.open = null;
    const lease = this.lease;
    this.lease = null;
    lease?.dispose();
  }
}

export function withCurrentRead<T>(open: () => ILLMContextReadLease, consume: (read: ILLMContextReadLease) => T): T {
  const scope = new CurrentRead(open);
  try { return consume(scope); }
  finally { scope.dispose(); }
}
