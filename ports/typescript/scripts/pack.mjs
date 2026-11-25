// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
const output = resolve('dist');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run build:packages.');
const staging = mkdtempSync(join(output, 'package-'));

const entry = (stem) => ({ types: `./${stem}.d.ts`, import: `./${stem}.js` });
const definitions = [
  { directory: 'src', manifest: { name, exports: { '.': entry('index'), './adapter-support': entry('adapter-support') } } },
  { directory: join('adapters', 'lucene'), manifest: { name: `${name}-lucene`, exports: { '.': entry('index') } } },
  { directory: join('adapters', 'bitfaster'), manifest: { name: `${name}-bitfaster`, exports: { '.': entry('index') } } },
];

try {
  for (const { directory, manifest } of definitions) {
    const packageDir = join(staging, manifest.name);
    cpSync(join(output, 'compiled', directory), packageDir, { recursive: true });
    copyFileSync(resolve('..', '..', 'LICENSE'), join(packageDir, 'LICENSE'));
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      private: true, type: 'module', version, license: 'MIT',
      description: 'Experimental LLMContextLib port; no stable release or compatibility guarantee.',
      ...manifest,
      ...(manifest.name === name ? {} : { peerDependencies: { [name]: version } }),
    }, null, 2) + '\n');
    execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--silent', '--pack-destination', output], {
      cwd: packageDir, stdio: 'inherit',
    });
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
