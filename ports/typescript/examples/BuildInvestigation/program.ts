// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { BuildInvestigationAssistant } from './assistant.js';

console.log('Offline simulation: no real model or build runs, no performance measurements.');
const assistant = new BuildInvestigationAssistant();
try {
  assistant.RunDemonstration();
} finally {
  assistant.dispose();
}
