// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Diagnostics;
using BenchmarkDotNet.Running;

namespace LLMContextLib.Benchmarks;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Contains("--ramp-case", StringComparer.Ordinal))
        {
            var descriptor = System.Text.Json.JsonSerializer.Deserialize<RampCase>(Value(args, "--ramp-case")!)!;
            var result = await SustainedRamp.Run(descriptor);
            RunEvidence.Save(Value(args, "--output"), "Isolated sustained ramp; bounded independent arrivals", result, args);
            return 0;
        }
        if (args.Contains("--ramp", StringComparer.Ordinal))
            return await SustainedRamp.RunSuite(Value(args, "--output"), new RampOptions
            {
                ComparePreparationPolicies = args.Contains("--preparationCompare", StringComparer.Ordinal),
                Rates = Value(args, "--rates")?.Split(',').Select(int.Parse).ToArray() ?? [100, 500, 1500],
                StageMilliseconds = Integer(args, "--stageMs", 1500),
                Workers = Integer(args, "--workers", 4),
                QueueCapacity = Integer(args, "--queue", 64),
                TotalEntries = Integer(args, "--entries", 2048),
                Repetitions = Integer(args, "--repetitions", 2),
                Seed = Integer(args, "--seed", 1729),
                MaximumManagedBytes = (long)Integer(args, "--managedMiB", 256) * 1024 * 1024,
                MaximumPrivateBytes = (long)Integer(args, "--privateMiB", 512) * 1024 * 1024
            }, args);
        if (args.Contains("--pressure-case", StringComparer.Ordinal))
        {
            var descriptor = System.Text.Json.JsonSerializer.Deserialize<PressureCase>(Value(args, "--pressure-case")!)!;
            var result = await PressureBenchmarks.RunCase(descriptor);
            RunEvidence.Save(Value(args, "--output"), "Isolated bounded pressure case; instrumentation enabled; not a capacity/SLA claim",
                result, args);
            return 0;
        }
        if (args.Contains("--pressure", StringComparer.Ordinal))
            return await PressureBenchmarks.RunSuite(Value(args, "--output"), args);
        if (args.Contains("--demo", StringComparer.Ordinal)) { ContextDemo.Run(); return 0; }
        if (args.Contains("--concurrent", StringComparer.Ordinal))
        {
            var concurrent = new List<ConcurrentReplayResult>();
            foreach (var kind in Enum.GetValues<ParticipantKind>())
                foreach (bool independent in new[] { false, true })
                {
                    var result = await ConcurrentReplay.Run(kind, independent,
                        readers: Integer(args, "--readers", 8), writers: Integer(args, "--writers", 4),
                        operationsPerWorker: Integer(args, "--operations", 64),
                        arrivalsPerSecond: Value(args, "--arrivalRate") is { } rate ? int.Parse(rate) : null);
                    concurrent.Add(result);
                    Console.WriteLine($"{kind} independent={independent} PASS commits={result.Commits}, conflicts={result.Conflicts}, rejected={result.Rejections}");
                }
            RunEvidence.Save(Value(args, "--output"), "Bounded concurrent replay; request-level instrumentation enabled", concurrent, args);
            return 0;
        }
        if (args.Contains("--soak", StringComparer.Ordinal))
        {
            var soak = new List<object>();
            foreach (var kind in Enum.GetValues<ParticipantKind>())
            {
                var samples = RetentionSoak.Run(kind, Integer(args, "--rounds", 32));
                soak.Add(new { Participant = kind.ToString(), Samples = samples });
                Console.WriteLine($"{kind} PASS retention grow/release samples={samples.Length}");
            }
            RunEvidence.Save(Value(args, "--output"), "Bounded retention diagnostic; no forced GC", soak, args);
            return 0;
        }
        if (!args.Contains("--smoke", StringComparer.Ordinal))
        {
            var summaries = BenchmarkSwitcher.FromAssembly(typeof(Program).Assembly).Run(args);
            return summaries.Any(summary => summary.HasCriticalValidationErrors ||
                summary.Reports.Any(report => !report.Success)) ? 1 : 0;
        }
        var reports = new List<object>();
        var scenarios = Value(args, "--scenario") is { } selected
            ? [Enum.Parse<ContextScenario>(selected)] : Enum.GetValues<ContextScenario>();
        foreach (var scenario in scenarios)
        {
            string profile = Value(args, "--profile") ?? "Interactive";
            int? entryCount = Value(args, "--entries") is { } entries ? int.Parse(entries) : null;
            var fixture = ContextFixture.Create(profile, entryCount);
            if (scenario == ContextScenario.ScopedMemory && fixture.Sessions.Length < 2)
                fixture = ContextFixture.Create(profile, entryCount, sessionCount: 2);
            var trace = ContextTraces.Create(fixture, scenario);
            ReplayChecks.Verify(fixture, trace);
            foreach (var kind in Enum.GetValues<ParticipantKind>())
            {
                using var participant = BenchmarkParticipants.Create(kind, fixture);
                long started = Stopwatch.GetTimestamp();
                var result = ReplayEngine.Execute(participant, trace, sample: true);
                var elapsed = Stopwatch.GetElapsedTime(started);
                reports.Add(new
                {
                    Scenario = scenario.ToString(),
                    Participant = kind.ToString(),
                    fixture.Profile,
                    fixture.Seed,
                    Sessions = fixture.Sessions.Length,
                    EntriesPerSession = fixture.Sessions[0].Segments.Values.Sum(segment => segment.Entries.Length),
                    Operations = trace.Length,
                    ElapsedMs = elapsed.TotalMilliseconds,
                    result.Digest,
                    result.Samples
                });
                Console.WriteLine($"{scenario,-20} {kind,-20} PASS operations={trace.Length} digest={result.Digest:x16}");
            }
        }
        RunEvidence.Save(Value(args, "--output"), "Single-pass correctness smoke; not a warmed performance comparison", reports, args);
        return 0;
    }

    private static string? Value(string[] args, string name)
    {
        int index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static int Integer(string[] args, string name, int fallback) =>
        Value(args, name) is { } value ? int.Parse(value) : fallback;
}
