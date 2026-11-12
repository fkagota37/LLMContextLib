// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Diagnostics;

namespace LLMContextLib.Benchmarks;

/// <summary>
/// Opt-in, thread-local observations of the conventional manager's existing locks/loops.
/// No timers or diagnostic objects are created by ordinary benchmark calls when disabled.
/// Segmented internals are NOT instrumented: missing lock-wait values must remain null,
/// rather than be misreported as zero contention. Observations include timer overhead.
/// </summary>
internal sealed class PressureInstrumentation
{
    [ThreadStatic] internal static PressureInstrumentation? Current;
    internal long ReadWaitTicks, WriteWaitTicks, AdmissionTicks;
    internal int AdmissionWaits, CompactedEntries, RebuiltLocations, SnapshotReferences;
    internal void ReadWait(long started) => ReadWaitTicks += Stopwatch.GetTimestamp() - started;
    internal void WriteWait(long started) => WriteWaitTicks += Stopwatch.GetTimestamp() - started;
}
