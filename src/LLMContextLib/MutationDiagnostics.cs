// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Diagnostics;

namespace LLMContextLib;

/// <summary>
/// Internal terminal-path labels separating cheap stale reads, post-preparation conflicts,
/// and gate/resource rejection. These are experimental attribution categories, not public errors.
/// </summary>
internal enum MutationDisposition
{
    Exception, NotFound, InitialRevisionConflict, GatedRevisionConflict,
    InvalidPreparation, GateRejected, PreparedRevisionConflict, ResourceRejected, Applied
}

/// <summary>
/// Optional per-call evidence, owned by a synchronous caller on its current thread. The
/// library allocates no diagnostic object or timers when Current is null. Callers must
/// clear Current in finally; nested/reentrant estimator operations are not supported.
/// Preparation bytes are managed CURRENT-THREAD allocations, not retained/resident bytes.
/// Resource admission duration includes accounting-lock acquisition, budget wait and
/// publication bookkeeping, not a purported pure contention measurement.
/// </summary>
internal sealed class MutationDiagnostics
{
    [ThreadStatic] internal static MutationDiagnostics? Current;
    internal MutationDisposition Disposition;
    internal bool PreparationStarted, Prepared, GateAttempted;
    internal long PreparationTicks, PreparationBytes, GateTicks, ResourceTicks, StorageTicks, StorageBytes;
    private long _operationTicks, _operationBytes, _preparationTicks, _preparationBytes;

    internal void Begin()
    {
        // Sample allocations before starting the timer, mirroring preparation below. Values
        // cover this synchronous thread only; external/other-thread work is outside attribution.
        _operationBytes = GC.GetAllocatedBytesForCurrentThread();
        _operationTicks = Stopwatch.GetTimestamp();
    }

    internal void End()
    {
        StorageTicks = Stopwatch.GetTimestamp() - _operationTicks;
        StorageBytes = GC.GetAllocatedBytesForCurrentThread() - _operationBytes;
    }

    internal void BeginPreparation()
    {
        // PreparationStarted and Prepared distinguish failed validation from a complete
        // candidate later rejected at publication. Timer completion alone does not imply success.
        PreparationStarted = true;
        _preparationBytes = GC.GetAllocatedBytesForCurrentThread();
        _preparationTicks = Stopwatch.GetTimestamp();
    }

    internal void EndPreparation()
    {
        PreparationTicks = Stopwatch.GetTimestamp() - _preparationTicks;
        PreparationBytes = GC.GetAllocatedBytesForCurrentThread() - _preparationBytes;
    }
}
