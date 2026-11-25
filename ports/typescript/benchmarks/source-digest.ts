// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function sourceDigest(): string {
  const hash = createHash('sha256');
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (path.endsWith('.ts')) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  scan('src');
  scan('adapters');
  scan('benchmarks');
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.packages.json', 'scripts\\pack.mjs']) {
    hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}
