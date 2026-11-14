// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Diagnostics;
using System.Reflection;
using System.Runtime;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace LLMContextLib.StrategyBenchmarks;

internal sealed record ProducerSample(long PrepareTicks, long ApplyTicks, long PipelineTicks,
    long PrepareBytes, long ApplyBytes);
internal sealed record ProducerRun(string Profile, string Reuse, string Operation, string Policy,
    int Position, long ActiveBytes, ProducerSample[] Samples);

internal static class ProducerWriteExperiment
{
    private static readonly string[] RepeatedKeys = ["alpha", "beta"];
    private static readonly string[] UniqueKeys = Enumerable.Range(0, 512).Select(i => $"word{i:D5}").ToArray();
    private static readonly string Repeated = string.Join(' ', Enumerable.Repeat("alpha beta", 256));
    private static readonly string Unique = string.Join(' ', UniqueKeys);
    private static Guid Id(int value) => new(value, 0, 0, new byte[8]);
    private static string Tail(int variant) => $"tail{variant:D6}";
    private static string Text(string profile, int variant) => (profile == "Repeated" ? Repeated : Unique) + " " + Tail(variant);
    private static ContextIndexKeys Keys(string profile, int variant) =>
        new((profile == "Repeated" ? RepeatedKeys : UniqueKeys).Append(Tail(variant)));

    internal static int Run(string output, int calls, bool reverse, string[] arguments)
    {
        var sources = Program.SourceHashes();
        var runs = new List<ProducerRun>();
        foreach (string profile in new[] { "Repeated", "Unique" })
            foreach (string reuse in new[] { "Hot", "Cold", "Mixed" })
                foreach (string operation in new[] { "Append", "Replace" })
                {
                    _ = Measure(profile, reuse, operation, false, 32, 0);
                    _ = Measure(profile, reuse, operation, true, 32, 0);
                    for (int position = 0; position < 2; position++)
                        runs.Add(Measure(profile, reuse, operation, reverse ? position == 0 : position == 1, calls, position));
                    Console.WriteLine($"PASS producer writes {profile}/{reuse}/{operation}");
                }
        if (!sources.SequenceEqual(Program.SourceHashes())) throw new InvalidOperationException("Sources changed during measurement.");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
        File.WriteAllText(output, JsonSerializer.Serialize(new
        {
            Mode = "ProducerWrites",
            Description = "Independent fixture-aware producers; prepare/apply/pipeline measured separately, not a loaded capacity test",
            RecordedAt = DateTimeOffset.UtcNow,
            Arguments = arguments,
            Calls = calls,
            Reverse = reverse,
            Runtime = RuntimeInformation.FrameworkDescription,
            Host = RuntimeInformation.OSDescription,
            Architecture = RuntimeInformation.ProcessArchitecture.ToString(),
            BuildSdk = typeof(Program).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                .First(attribute => attribute.Key == "BuildSdk").Value,
            Environment.ProcessorCount,
            GCSettings.IsServerGC,
            LatencyMode = GCSettings.LatencyMode.ToString(),
            Stopwatch.Frequency,
            SourceHashes = sources,
            AssemblyHashes = Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll")
                .ToDictionary(path => Path.GetFileName(path)!, Program.Hash),
            TimerBracket = Program.Calibrate(),
            Runs = runs
        }, Program.Json));
        Console.WriteLine($"Evidence saved: {Path.GetFullPath(output)}");
        return 0;
    }

    private static ProducerRun Measure(string profile, string reuse, string operation, bool supplied, int calls, int position)
    {
        var entries = Enumerable.Range(0, 8).Select(i =>
            new ContextEntry(Id(1000 + i), i, ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent(Text(profile, i)))
            {
                IndexKeys = supplied ? Keys(profile, i) : null
            }).ToImmutableArray();
        var session = new LLMSessionContext(Id(1), Id(2), null, 0, SessionStatus.Active,
            ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, new(0, 0, entries)),
            ImmutableDictionary<Guid, ConversationAnchor>.Empty);
        var builder = LLMContextFactory.Create(new()
        {
            EstimatedResidentByteBudget = 128L * 1024 * 1024,
            MaximumEstimatedRetainedBytes = 128L * 1024 * 1024,
            MaximumEntriesPerSegment = 32,
            MaximumEstimatedBytesPerSegment = 1024 * 1024
        });
        using var owner = (supplied ? builder.WithProducerOwnedIndexing() : builder).Initialize([session]);
        var variants = Enumerable.Range(0, calls).Select(i =>
            reuse == "Cold" || (reuse == "Mixed" && i % 5 == 4) ? 1000 + i : (i / 8 + i % 8) % 8).ToArray();
        string[] texts = variants.Select(i => Text(profile, i)).ToArray();
        var queryKeys = variants.Select(i => new ContextIndexKeys([Tail(i)])).ToArray();
        var samples = new ProducerSample[calls];
        for (int i = 0; i < calls; i++)
        {
            long pipeline = Stopwatch.GetTimestamp();
            long allocated = GC.GetAllocatedBytesForCurrentThread();
            long preparing = Stopwatch.GetTimestamp();
            var content = new TextContent(texts[i]);
            var keys = supplied ? Keys(profile, variants[i]) : null;
            ContextChange command = operation == "Append"
                ? new AppendEntries([new(Id(2000 + i), ContextRole.User, DateTimeOffset.UnixEpoch, content) { IndexKeys = keys }])
                : new ReplaceEntry(Id(1000 + i % 8), content) { IndexKeys = keys };
            var request = new ContextChangeSet(Id(1), i, [command]);
            long prepared = Stopwatch.GetTimestamp();
            long before = GC.GetAllocatedBytesForCurrentThread();
            long applying = Stopwatch.GetTimestamp();
            var result = owner.Apply(request);
            long returned = Stopwatch.GetTimestamp();
            long after = GC.GetAllocatedBytesForCurrentThread();
            samples[i] = new(prepared - preparing, returned - applying, returned - pipeline,
                before - allocated, after - before);
            if (result.Status != ContextMutationStatus.Applied || result.Revision != i + 1)
                throw new InvalidOperationException("Lost sequential write.");
            using var read = owner.OpenRead(Id(1));
            if (read.IndexStatus.PendingEntries != 0) throw new InvalidOperationException("Incomplete producer index.");
            var hits = supplied ? read.SearchKeys(queryKeys[i], 16) : read.Search(Tail(variants[i]), 16);
            var expected = read.ReadRange(0, calls + 8).Where(entry =>
                ((TextContent)entry.Content).Text.EndsWith(" " + Tail(variants[i]), StringComparison.Ordinal))
                .Take(16).Select(entry => entry.EntryId);
            if (!expected.SequenceEqual(hits.Select(hit => hit.EntryId)))
                throw new InvalidOperationException("Exact search differs from captured-content oracle.");
        }
        var statistics = owner.GetStatistics();
        if (statistics.RetainedReads != 0 || statistics.PendingIndexWork != 0)
            throw new InvalidOperationException("Resources did not drain.");
        return new(profile, reuse, operation, supplied ? "ProducerKeys" : "NativeText",
            position, statistics.EstimatedActiveBytes, samples);
    }
}
