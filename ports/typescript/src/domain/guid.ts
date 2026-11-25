// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { Guid } from './session.js';

const guidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function canonicalGuid(id: Guid): Guid {
  if (typeof id !== 'string' || id.length !== 36 || !guidPattern.test(id)) throw new TypeError('Expected a dashed GUID.');
  return id.toLowerCase();
}
