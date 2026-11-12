// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Diagnostics;
using System.Collections.Immutable;
using LLMContextLib;

namespace LLMContextLib.Benchmarks;

public sealed record RetentionSample(
    string Phase, int Round, int Held, long Revision, long ManagedBytes, long PrivateBytes, long WorkingSet);

/// <summary>
/// Bounded grow/retain/release diagnostic, not a proof of immediate GC or a forced-GC benchmark.
/// The authoritative tail grows deliberately; only snapshot retention is expected to stop
/// growing after release. Process observations include the harness and runtime.
/// </summary>
public static class RetentionSoak
{
    public static ImmutableArray<RetentionSample> Run(ParticipantKind kind, int rounds = 32)
    {
        if (rounds <= 0 || rounds > 4096) throw new ArgumentOutOfRangeException(nameof(rounds));
        var fixture = ContextFixture.Create("Interactive");
        using var participant = BenchmarkParticipants.Create(kind, fixture);
        using var process = Process.GetCurrentProcess();
        Guid sessionId = fixture.Sessions[0].SessionId;
        var target = ContextPolicies.Entries(fixture.Sessions[0]).First();
        var held = new Queue<(IContextRetention Lease, long Revision, ContextEntry? First)>();
        var samples = ImmutableArray.CreateBuilder<RetentionSample>();
        long revision = 0;
        try
        {
            for (int round = 0; round < rounds; round++)
            {
                var lease = participant.Retain(sessionId);
                held.Enqueue((lease, lease.Revision, lease.FirstEntry));
                var result = participant.Apply(new(sessionId, revision,
                    [new ReplaceEntry(target.EntryId, new TextContent($"soak revision {round}")),
                     new AppendEntries([new(ContextFixture.Id(12, 0, round), ContextRole.User,
                         ContextFixture.Now.AddDays(1).AddSeconds(round), new TextContent(new string('s', 1024)))])]));
                if (result.Status != ContextMutationStatus.Applied) throw new InvalidOperationException(result.Error);
                revision = result.Revision;
                foreach (var retained in held)
                    if (retained.Lease.Revision != retained.Revision || retained.Lease.FirstEntry != retained.First)
                        throw new InvalidOperationException("Retained context changed under mutation.");
                if (held.Count > 4) held.Dequeue().Lease.Dispose();
                Sample("grow", round);
            }
            while (held.TryDequeue(out var item)) item.Lease.Dispose();
            for (int round = 0; round < 8; round++)
            {
                Thread.Sleep(10);
                Sample("released", round);
            }
            return samples.ToImmutable();
        }
        finally
        {
            while (held.TryDequeue(out var item)) item.Lease.Dispose();
        }

        void Sample(string phase, int round)
        {
            process.Refresh();
            samples.Add(new(phase, round, held.Count, revision, GC.GetTotalMemory(false),
                process.PrivateMemorySize64, process.WorkingSet64));
        }
    }
}
