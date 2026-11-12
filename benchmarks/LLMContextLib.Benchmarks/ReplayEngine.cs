// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Diagnostics;
using LLMContextLib;

namespace LLMContextLib.Benchmarks;

public sealed record ReplayStep(
    ReplayActionKind Kind, long Revision, ContextMutationStatus? Status = null,
    ContextObservation? Observation = null, ContextEntry? RetainedFirst = null);
public sealed record ReplaySample(
    string Category, long ElapsedTicks, long Revision, ContextMutationStatus? Status, ulong Digest);
public sealed record ReplayResult(ImmutableArray<ReplayStep> Steps, ImmutableArray<ReplaySample> Samples, ulong Digest);

/// <summary>
/// Fresh finite-replay engine. Timing includes domain operations, materialized outputs and
/// identical checksum consumption; fixture generation, participant seeding and oracle checks
/// are excluded. Per-request Stopwatch samples are optional because they have measurable cost.
/// The returned batch time is never mislabeled a request percentile.
/// </summary>
public static class ReplayEngine
{
    public static ReplayResult Execute(
        IContextBenchmarkParticipant participant, ImmutableArray<ReplayAction> trace, bool sample = false)
    {
        var steps = ImmutableArray.CreateBuilder<ReplayStep>(trace.Length);
        var samples = ImmutableArray.CreateBuilder<ReplaySample>(sample ? trace.Length : 0);
        var retained = new Dictionary<int, IContextRetention>();
        ulong total = 14695981039346656037;
        try
        {
            foreach (var action in trace)
            {
                long started = sample ? Stopwatch.GetTimestamp() : 0;
                ReplayStep step;
                switch (action.Kind)
                {
                    case ReplayActionKind.Read:
                        var read = participant.Read(action.SessionId, action.Request!);
                        step = new(action.Kind, read.SessionRevision, Observation: read);
                        break;
                    case ReplayActionKind.Change:
                        var mutation = participant.Apply(new(action.SessionId, action.ExpectedRevision, action.Changes));
                        step = new(action.Kind, mutation.Revision, mutation.Status);
                        break;
                    case ReplayActionKind.Memory:
                        mutation = participant.ApplyMemory(action.Memory!);
                        step = new(action.Kind, mutation.Revision, mutation.Status);
                        break;
                    case ReplayActionKind.Retain:
                        var lease = participant.Retain(action.SessionId);
                        retained.Add(action.RetentionId, lease);
                        step = new(action.Kind, lease.Revision, RetainedFirst: lease.FirstEntry);
                        break;
                    case ReplayActionKind.CheckRetained:
                        lease = retained[action.RetentionId];
                        step = new(action.Kind, lease.Revision, RetainedFirst: lease.FirstEntry);
                        break;
                    case ReplayActionKind.Release:
                        lease = retained[action.RetentionId];
                        step = new(action.Kind, lease.Revision);
                        retained.Remove(action.RetentionId);
                        lease.Dispose();
                        break;
                    default: throw new ArgumentOutOfRangeException(nameof(trace));
                }
                ulong digest = Digest(step);
                total = unchecked((total ^ digest) * 1099511628211);
                if (sample)
                {
                    string category = action.Request?.Kind.ToString() ?? action.Kind.ToString();
                    samples.Add(new(category, Stopwatch.GetTimestamp() - started, step.Revision, step.Status, digest));
                }
                steps.Add(step);
            }
            return new(steps.MoveToImmutable(), samples.ToImmutable(), total);
        }
        finally
        {
            foreach (var lease in retained.Values) lease.Dispose();
        }
    }

    // O(output characters + output records), explicitly inside every participant's timing.
    // This digest is only a consumption mechanism. Full-value equivalence below, not hash
    // equality, is the correctness gate. Strings are visited without JSON/UTF-8 serialization.
    private static ulong Digest(ReplayStep step)
    {
        ulong hash = 14695981039346656037;
        void Number(long value) => hash = unchecked((hash ^ (ulong)value) * 1099511628211);
        void Text(string text) { foreach (char character in text) Number(character); }
        void Entry(ContextEntry entry)
        {
            Text(entry.EntryId.ToString("N"));
            Number(entry.Sequence);
            Number((int)entry.Role);
            Text(ContextPolicies.Text(entry.Content));
        }
        Number(step.Revision);
        Number((int)step.Kind);
        Number((int?)step.Status ?? -1);
        if (step.RetainedFirst is not null) Entry(step.RetainedFirst);
        if (step.Observation is not { } read) return hash;
        Number(read.MemoryRevision);
        foreach (var entry in read.Entries) Entry(entry);
        foreach (var hit in read.Hits) { Text(hit.EntryId.ToString("N")); Text(hit.Snippet); Number(hit.Sequence); }
        foreach (var anchor in read.Anchors) { Text(anchor.Anchor.Title); Number((int)anchor.Status); }
        foreach (var memory in read.Memories) { Text(memory.MemoryId.ToString("N")); Text(memory.Content); }
        foreach (var item in read.Model) { Number((int)item.Role); Text(item.Text); }
        return hash;
    }
}

public static class ReplayChecks
{
    public static void Verify(ContextFixture fixture, ImmutableArray<ReplayAction> trace)
    {
        using var oracle = new SemanticOracle(fixture);
        var expected = ReplayEngine.Execute(oracle, trace);
        foreach (var kind in Enum.GetValues<ParticipantKind>())
        {
            using var participant = BenchmarkParticipants.Create(kind, fixture);
            var actual = ReplayEngine.Execute(participant, trace);
            AssertEquivalent(expected, actual, kind.ToString());
        }
    }

    public static void AssertEquivalent(ReplayResult expected, ReplayResult actual, string label)
    {
        if (expected.Steps.Length != actual.Steps.Length) throw new InvalidOperationException($"{label}: operation count differs.");
        for (int i = 0; i < expected.Steps.Length; i++)
        {
            var left = expected.Steps[i];
            var right = actual.Steps[i];
            if (left.Kind != right.Kind || left.Revision != right.Revision || left.Status != right.Status ||
                left.RetainedFirst != right.RetainedFirst || !Same(left.Observation, right.Observation))
                throw new InvalidOperationException($"{label}: semantic mismatch at operation {i} ({left.Kind}); " +
                    $"expected revision/status {left.Revision}/{left.Status}, got {right.Revision}/{right.Status}.");
        }
        if (expected.Digest != actual.Digest) throw new InvalidOperationException($"{label}: output consumption differs.");
    }

    private static bool Same(ContextObservation? left, ContextObservation? right) =>
        left is null ? right is null : right is not null &&
        left.SessionRevision == right.SessionRevision && left.MemoryRevision == right.MemoryRevision &&
        left.Entries.SequenceEqual(right.Entries) && left.Hits.SequenceEqual(right.Hits) &&
        left.Anchors.SequenceEqual(right.Anchors) && left.Memories.SequenceEqual(right.Memories) &&
        left.Model.SequenceEqual(right.Model);
}
