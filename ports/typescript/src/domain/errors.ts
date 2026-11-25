// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export type ContextErrorCode = 'Disposed' | 'NotFound' | 'InvalidOperation' | 'NotSupported';

/** Operational failure; invalid arguments remain TypeError or RangeError. */
export class ContextError extends Error {
  constructor(public readonly code: ContextErrorCode, message: string) {
    super(message);
    this.name = 'ContextError';
  }
}
