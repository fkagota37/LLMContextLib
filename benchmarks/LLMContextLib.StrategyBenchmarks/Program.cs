// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Diagnostics;
using System.Reflection;
using System.Runtime;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using LLMContextLib.Benchmarks;

namespace LLMContextLib.StrategyBenchmarks;

internal static class Program
{
    internal static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    private static int Main(string[] args)
    {
        string output = Value("--output") ?? throw new ArgumentException("--output is required.");
        if (File.Exists(output)) throw new ArgumentException("Use a new report path.");
        string suite = Value("--suite") ?? "all";
        int calls = int.Parse(Value("--calls") ?? "128");
        if (calls is < 16 or > 512 || suite is not ("all" or "sequential" or "load" or "memory"))
            throw new ArgumentException("Invalid bounded experiment settings.");
        bool reverse = args.Contains("--reverse", StringComparer.Ordinal);
        if (args.Contains("--partition-stress", StringComparer.Ordinal))
            return PartitionStressExperiment.Run(output, reverse, args);
        if (args.Contains("--partition-writes", StringComparer.Ordinal))
        {
            if (suite != "all") throw new ArgumentException("Partition diagnostics do not use --suite.");
            return PartitionWriteExperiment.Run(output, calls, reverse, args);
        }
        if (args.Contains("--producer-writes", StringComparer.Ordinal))
        {
            if (suite != "all") throw new ArgumentException("Producer diagnostics do not use --suite.");
            return ProducerWriteExperiment.Run(output, calls, reverse, args);
        }
        var sources = SourceHashes();
        int oracleChecks = 0;
        foreach (var policy in Experiment.Policies)
        {
            var fixture = ContextFixture.Create("Interactive", entryCount: 32, sessionCount: 2);
            foreach (var scenario in Enum.GetValues<ContextScenario>())
            {
                using var participant = BenchmarkParticipants.Create(Experiment.Builder(policy, validation: true), fixture);
                ReplayChecks.Verify(fixture, ContextTraces.Create(fixture, scenario), participant, policy + "/" + scenario);
                oracleChecks++;
            }
        }
        Console.WriteLine($"PASS {oracleChecks} independent oracle traces");
        var sequential = suite is "all" or "sequential" ? Experiment.Sequential(calls, reverse) : [];
        var loads = suite is "all" or "load" ? Experiment.Load(calls, reverse) : [];
        var memory = suite is "all" or "memory" ? Experiment.Memory(reverse) : [];
        if (!sources.SequenceEqual(SourceHashes())) throw new InvalidOperationException("Sources changed during measurement.");
        string full = Path.GetFullPath(output);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, JsonSerializer.Serialize(new
        {
            Mode = "Bounded composition diagnostic; not a service percentile, capacity or hard-heap claim",
            RecordedAt = DateTimeOffset.UtcNow,
            Arguments = args,
            Suite = suite,
            Calls = calls,
            Reverse = reverse,
            OracleChecks = oracleChecks,
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
                .ToDictionary(path => Path.GetFileName(path)!, Hash),
            TimerBracket = Calibrate(),
            Sequential = sequential,
            Loads = loads,
            Memory = memory
        }, Json));
        Console.WriteLine($"Evidence saved: {full}");
        return 0;

        string? Value(string name)
        {
            int position = Array.IndexOf(args, name);
            return position >= 0 && position + 1 < args.Length ? args[position + 1] : null;
        }
    }

    internal static SortedDictionary<string, string> SourceHashes()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "LLMContextLib.sln"))) root = root.Parent;
        if (root is null) throw new InvalidOperationException("Run the built executable inside its source checkout.");
        var hashes = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (string folder in new[]
        {
            @"src\LLMContextLib", @"src\LLMContextLib.Lucene", @"src\LLMContextLib.BitFaster",
            @"benchmarks\LLMContextLib.Benchmarks", @"benchmarks\LLMContextLib.StrategyBenchmarks"
        })
            foreach (string file in Directory.EnumerateFiles(Path.Combine(root.FullName, folder), "*", SearchOption.AllDirectories)
                .Where(file => !file.Contains(@"\obj\", StringComparison.Ordinal) && !file.Contains(@"\bin\", StringComparison.Ordinal) &&
                    (file.EndsWith(".cs", StringComparison.Ordinal) || file.EndsWith(".csproj", StringComparison.Ordinal) ||
                     file.EndsWith("packages.lock.json", StringComparison.Ordinal))))
                hashes.Add(Path.GetRelativePath(root.FullName, file), Hash(file));
        foreach (string file in new[] { "global.json", "Directory.Build.props", "NuGet.Config", "LLMContextLib.sln" })
            hashes.Add(file, Hash(Path.Combine(root.FullName, file)));
        return hashes;
    }

    internal static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    internal static long[] Calibrate()
    {
        var result = new long[4096];
        for (int i = 0; i < result.Length; i++)
        {
            long start = Stopwatch.GetTimestamp();
            result[i] = Stopwatch.GetTimestamp() - start;
        }
        return result;
    }
}
