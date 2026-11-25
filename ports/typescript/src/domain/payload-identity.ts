// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

const nativePayloads = new WeakSet<object>();

export function sealPayload(payload: object): void {
  Object.freeze(payload);
  nativePayloads.add(payload);
}

export function isNativePayload(payload: object): boolean {
  return nativePayloads.has(payload);
}
