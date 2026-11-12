// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using LLMContextLib.Examples.BuildInvestigation;

// This is the runnable entry point. The host creates the three workers,
// injects the SAME library owner into each, and demonstrates the complete flow.
// The using scope ends after the scenario, disposing the one owner rather than
// having workers independently shut down shared storage. All state is in-process.
Console.WriteLine("Offline simulation: no real model or build runs, no performance measurements.");
using var assistant = new BuildInvestigationAssistant();
assistant.RunDemonstration();
