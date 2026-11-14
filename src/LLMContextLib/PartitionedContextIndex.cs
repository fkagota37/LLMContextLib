// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;

namespace LLMContextLib;

/// <summary>Producer choice when a session's index synchronization closes write admission.</summary>
public enum ContextSynchronizationWriteBehavior
{
    /// <summary>Return Synchronizing immediately; a producer may stage its own bounded intent.</summary>
    Reject,
    /// <summary>Wait up to SynchronizationWaitTimeout, then return Synchronizing. Never rebase.</summary>
    Wait
}

/// <summary>
/// Opt-in segment-local entry indexes and authoritative working sets. Limits are conservative
/// estimates, not process-heap caps. Anchor indexes remain on the existing session path.
/// </summary>
public sealed record PartitionedContextIndexOptions
{
    /// <summary>Maximum estimated base plus working-set bytes per segment's entry index.</summary>
    public long MaximumEstimatedPartitionBytes { get; init; } = 2 * 1024 * 1024;
    /// <summary>Maximum authoritative overrides/tombstones per partition before synchronization.</summary>
    public int MaximumWorkingSetEntries { get; init; } = 64;
    /// <summary>Maximum estimated override/tombstone bytes per partition.</summary>
    public long MaximumEstimatedWorkingSetBytes { get; init; } = 512 * 1024;
    /// <summary>Maximum outstanding synchronization requests, including the one running.</summary>
    public int MaximumPendingSynchronizations { get; init; } = 32;
    /// <summary>Per-attempt preconstruction reservation ceiling for producer-owned writes.</summary>
    public long MaximumEstimatedPreparationBytes { get; init; } = 8 * 1024 * 1024;
    /// <summary>Reject by default; staging remains a producer responsibility.</summary>
    public ContextSynchronizationWriteBehavior WriteBehavior { get; init; }
    /// <summary>Bound on waiting for synchronization, separate from ordinary admission waits.</summary>
    public TimeSpan SynchronizationWaitTimeout { get; init; } = TimeSpan.FromSeconds(1);

    internal long InfrastructureBytes => checked(4096L + 512L * MaximumPendingSynchronizations);
    internal long RecoveryBytes => checked(2 * MaximumEstimatedPartitionBytes);

    internal void Validate()
    {
        if (MaximumEstimatedPartitionBytes <= 0 || MaximumWorkingSetEntries <= 0 ||
            MaximumEstimatedWorkingSetBytes <= 0 || MaximumPendingSynchronizations <= 0 ||
            MaximumEstimatedPreparationBytes <= 0 || !Enum.IsDefined(WriteBehavior) ||
            SynchronizationWaitTimeout < TimeSpan.Zero ||
            SynchronizationWaitTimeout.TotalMilliseconds > int.MaxValue)
            throw new ArgumentOutOfRangeException(nameof(PartitionedContextIndexOptions));
        _ = checked(InfrastructureBytes + RecoveryBytes);
    }
}

/// <summary>
/// Durable completion notification. Success means synchronization and write-admission reopening,
/// not reclamation of reader-pinned generations or guaranteed capacity for staged writes.
/// </summary>
public sealed record ContextIndexSynchronization(
    Guid SessionId, long Generation, long ContentRevision, int PartitionsCompacted,
    bool Succeeded, string? Error = null);

internal sealed class PartitionCapacityException(bool canSynchronize, string message) : Exception(message)
{
    internal bool CanSynchronize { get; } = canSynchronize;
    internal long SegmentId { get; set; }
}

internal sealed record PartitionContribution(ImmutableArray<string> Terms, long Bytes)
{
    internal long IndexBytes => checked(128 + 6 * Bytes);
}

internal sealed record ContextIndexPartition(
    ImmutableDictionary<Guid, PartitionContribution> Contributions,
    ImmutableDictionary<string, ImmutableHashSet<Guid>> Search,
    ImmutableDictionary<Guid, PartitionContribution?> Overrides,
    long BaseBytes, long WorkingSetBytes)
{
    internal static ContextIndexPartition Empty { get; } = new(
        ImmutableDictionary<Guid, PartitionContribution>.Empty,
        ImmutableDictionary.Create<string, ImmutableHashSet<Guid>>(StringComparer.Ordinal),
        ImmutableDictionary<Guid, PartitionContribution?>.Empty, 256, 0);

    internal long EstimatedBytes => checked(BaseBytes + WorkingSetBytes);

    internal ContextIndexPartition Override(Guid id, PartitionContribution? value,
        PartitionedContextIndexOptions options)
    {
        long oldBytes = Overrides.TryGetValue(id, out var old) ? OverrideBytes(old) : 0;
        if (value is null && !Contributions.ContainsKey(id))
            return this with { Overrides = Overrides.Remove(id), WorkingSetBytes = WorkingSetBytes - oldBytes };
        long bytes = checked(WorkingSetBytes - oldBytes + OverrideBytes(value));
        int count = Overrides.Count + (Overrides.ContainsKey(id) ? 0 : 1);
        if (count > options.MaximumWorkingSetEntries || bytes > options.MaximumEstimatedWorkingSetBytes ||
            checked(BaseBytes + bytes) > options.MaximumEstimatedPartitionBytes)
            throw new PartitionCapacityException(!Overrides.IsEmpty,
                "Partition working set is full; synchronize before retrying, or reduce the atomic contribution.");
        return this with { Overrides = Overrides.SetItem(id, value), WorkingSetBytes = bytes };
    }

    internal static long OverrideBytes(PartitionContribution? contribution) =>
        checked(128 + (contribution?.IndexBytes ?? 0));

    internal ContextIndexPartition Compact(CancellationToken cancellationToken = default)
    {
        var contributions = Contributions.ToBuilder();
        foreach (var (id, value) in Overrides)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (value is null) contributions.Remove(id);
            else contributions[id] = value;
        }
        var search = ImmutableDictionary.CreateBuilder<string, ImmutableHashSet<Guid>>(StringComparer.Ordinal);
        long bytes = 256;
        foreach (var (id, value) in contributions)
        {
            cancellationToken.ThrowIfCancellationRequested();
            bytes = checked(bytes + value.IndexBytes);
            foreach (string term in value.Terms)
            {
                cancellationToken.ThrowIfCancellationRequested();
                search.TryGetValue(term, out var posting);
                search[term] = (posting ?? ImmutableHashSet<Guid>.Empty).Add(id);
            }
        }
        return new(contributions.ToImmutable(), search.ToImmutable(),
            ImmutableDictionary<Guid, PartitionContribution?>.Empty, bytes, 0);
    }
}
