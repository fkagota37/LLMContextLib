// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Diagnostics;
using System.Runtime;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace LLMContextLib.StrategyBenchmarks;

internal static class PartitionWriteExperiment
{
    private sealed record Sample(string Operation, long ApplyTicks, long ApplyBytes, long QueryScopeTicks);
    private sealed record Round(string Profile, bool Pinned, string Policy, int Pair, int Position,
        Sample[] Samples, long SynchronizationTicks, long SynchronizationProcessBytes,
        long GrowthSynchronizationTicks, long GrowthSynchronizationProcessBytes,
        long InitialActiveBytes, long BeforeSynchronizationBytes, long AfterSynchronizationBytes,
        long FinalActiveBytes, long RetainedBytesBeforeRelease, long RetainedBytesAfterRelease);

    internal static int Run(string output, int calls, bool reverse, string[] arguments)
    {
        var sources = Program.SourceHashes();
        var rounds = new List<Round>();
        foreach (bool distinct in new[] { false, true })
            foreach (bool pinned in new[] { false, true })
            {
                Measure(distinct, pinned, partitioned: false, -1, 0);
                Measure(distinct, pinned, partitioned: true, -1, 1);
                for (int pair = 0; pair < calls; pair++)
                    foreach (bool partitioned in reverse ? new[] { true, false } : new[] { false, true })
                        rounds.Add(Measure(distinct, pinned, partitioned, pair,
                            partitioned == reverse ? 0 : 1));
            }
        if (!sources.SequenceEqual(Program.SourceHashes()))
            throw new InvalidOperationException("Sources changed during measurement.");
        string full = Path.GetFullPath(output);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, JsonSerializer.Serialize(new
        {
            Mode = "PartitionWrites",
            RecordedAt = DateTimeOffset.UtcNow,
            Arguments = arguments,
            Calls = calls,
            Reverse = reverse,
            Runtime = RuntimeInformation.FrameworkDescription,
            Host = RuntimeInformation.OSDescription,
            Architecture = RuntimeInformation.ProcessArchitecture.ToString(),
            Environment.ProcessorCount,
            GCSettings.IsServerGC,
            LatencyMode = GCSettings.LatencyMode.ToString(),
            Stopwatch.Frequency,
            SourceHashes = sources,
            AssemblyHashes = Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll")
                .ToDictionary(path => Path.GetFileName(path)!, Program.Hash),
            Rounds = rounds
        }, Program.Json));
        Console.WriteLine($"PASS {rounds.Count} matched rounds; {rounds.Sum(round => round.Samples.Length)} writes and exact queries: {full}");
        return 0;
    }

    private static Round Measure(bool distinct, bool pinned, bool partitioned, int pair, int position)
    {
        var sessionId = Id(1);
        var contributions = Enumerable.Range(0, 48).ToDictionary(n => Id(1000 + n), n =>
            new ContextIndexKeys(Enumerable.Range(0, 255)
                .Select(k => distinct ? $"entry:{n}:key:{k}" : $"common:key:{k}").Append("shared")));
        var session = new LLMSessionContext(sessionId, Id(2), Id(3), 0, SessionStatus.Active,
            Enumerable.Range(0, 4).ToImmutableSortedDictionary(n => (long)n,
                n => new ContextSegment(n, 0, Enumerable.Range(n * 8, 8).Select(i =>
                    new ContextEntry(Id(1000 + i), i, ContextRole.User, DateTimeOffset.UnixEpoch,
                        new TextContent($"source {i}"))
                    { IndexKeys = contributions[Id(1000 + i)] }).ToImmutableArray())),
            ImmutableDictionary<Guid, ConversationAnchor>.Empty);
        var recipe = LLMContextFactory.Create(new()
        {
            MaximumEntriesPerSegment = 8,
            EstimatedResidentByteBudget = 256 * 1024 * 1024,
            MaximumEstimatedRetainedBytes = 256 * 1024 * 1024
        }).WithProducerOwnedIndexing();
        if (partitioned) recipe = recipe.WithPartitionedIndexing(new()
        {
            MaximumEstimatedPartitionBytes = 4 * 1024 * 1024,
            MaximumEstimatedWorkingSetBytes = 2 * 1024 * 1024
        });
        using var owner = recipe.Initialize([session]);
        ILLMContextReadLease? old = pinned ? owner.OpenRead(sessionId) : null;
        try
        {
            var model = Enumerable.Range(0, 32).ToDictionary(n => Id(1000 + n), n => (long)n);
            long revision = 0;
            long initial = owner.GetStatistics().EstimatedActiveBytes;
            var samples = new List<Sample>();
            for (int i = 0; i < 32; i += 2)
            {
                int n = i;
                var command = new ContextChangeSet(sessionId, revision, [new DeleteEntry(Id(1000 + n))]);
                Execute(command, "Delete", () => model.Remove(Id(1000 + n)));
            }
            long before = owner.GetStatistics().EstimatedActiveBytes;
            long syncStartBytes = GC.GetTotalAllocatedBytes(precise: true);
            long syncStart = Stopwatch.GetTimestamp();
            if (partitioned)
            {
                var receipt = owner.SynchronizeIndexAsync(sessionId).GetAwaiter().GetResult();
                if (!receipt.Succeeded || receipt.PartitionsCompacted != 4 || receipt.ContentRevision != revision)
                    throw new InvalidOperationException("Synchronization did not preserve the expected content revision.");
            }
            long syncTicks = partitioned ? Stopwatch.GetTimestamp() - syncStart : 0;
            long syncBytes = partitioned ? GC.GetTotalAllocatedBytes(precise: true) - syncStartBytes : 0;
            long after = owner.GetStatistics().EstimatedActiveBytes;
            for (int i = 32; i < 48; i++)
            {
                int n = i;
                var draft = new ContextEntryDraft(Id(1000 + n), ContextRole.User, DateTimeOffset.UnixEpoch,
                    new TextContent($"growth {n}"))
                { IndexKeys = contributions[Id(1000 + n)] };
                var command = new ContextChangeSet(sessionId, revision, [new AppendEntries([draft])]);
                Execute(command, "Grow", () => model.Add(Id(1000 + n), n));
            }
            long growthSyncBytes = GC.GetTotalAllocatedBytes(precise: true);
            long growthSyncStart = Stopwatch.GetTimestamp();
            if (partitioned)
            {
                var receipt = owner.SynchronizeIndexAsync(sessionId).GetAwaiter().GetResult();
                if (!receipt.Succeeded || receipt.ContentRevision != revision)
                    throw new InvalidOperationException("Growth synchronization did not complete.");
            }
            long growthSyncTicks = partitioned ? Stopwatch.GetTimestamp() - growthSyncStart : 0;
            growthSyncBytes = partitioned ? GC.GetTotalAllocatedBytes(precise: true) - growthSyncBytes : 0;
            owner.WithCurrent(sessionId, read =>
            {
                if (!model.OrderBy(pair => pair.Value).Select(pair => pair.Key)
                    .SequenceEqual(read.SearchKeys(new(["shared"]), 100).Select(hit => hit.EntryId)))
                    throw new InvalidOperationException("Post-synchronization oracle mismatch.");
            });
            if (old is not null && old.SearchKeys(new(["shared"]), 100).Length != 32)
                throw new InvalidOperationException("Pinned generation changed.");
            var final = owner.GetStatistics();
            old?.Dispose();
            old = null;
            long released = owner.GetStatistics().EstimatedRetainedBytes;
            if (released != 0 || final.EstimatedPreparationBytes != 0)
                throw new InvalidOperationException("Read/preparation reservations leaked.");
            return new(distinct ? "Distinct256" : "Common256", pinned, partitioned ? "Partitioned" : "ProducerEager",
                pair, position, samples.ToArray(), syncTicks, syncBytes, growthSyncTicks, growthSyncBytes,
                initial, before, after,
                final.EstimatedActiveBytes, final.EstimatedRetainedBytes, released);

            void Execute(ContextChangeSet command, string operation, Action updateModel)
            {
                long bytes = GC.GetAllocatedBytesForCurrentThread();
                long start = Stopwatch.GetTimestamp();
                var result = owner.Apply(command);
                long elapsed = Stopwatch.GetTimestamp() - start;
                long allocation = GC.GetAllocatedBytesForCurrentThread() - bytes;
                if (result.Status != ContextMutationStatus.Applied || result.Revision != revision + 1)
                    throw new InvalidOperationException($"Unexpected write: {result.Status}: {result.Error}");
                revision++;
                updateModel();
                var keys = new ContextIndexKeys(["shared"]);
                ImmutableArray<ContextSearchHit> actual = [];
                long queryStart = Stopwatch.GetTimestamp();
                owner.WithCurrent(sessionId, read => actual = read.SearchKeys(keys, 100));
                long queryTicks = Stopwatch.GetTimestamp() - queryStart;
                var expected = model.OrderBy(pair => pair.Value).Select(pair => pair.Key);
                if (!expected.SequenceEqual(actual.Select(hit => hit.EntryId)) ||
                    actual.Any(hit => hit.SessionRevision != revision))
                    throw new InvalidOperationException("Independent key-membership/order oracle mismatch.");
                if (owner.GetStatistics().RetainedReads != (pinned ? 1 : 0))
                    throw new InvalidOperationException("Scoped read did not release its lease.");
                samples.Add(new(operation, elapsed, allocation, queryTicks));
            }
        }
        finally { old?.Dispose(); }
    }

    private static Guid Id(int n) => new(n, 0, 0, new byte[8]);
}
