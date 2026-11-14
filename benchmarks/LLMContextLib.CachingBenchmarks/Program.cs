// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using BitFaster.Caching;

namespace LLMContextLib.CachingBenchmarks;

/// <summary>
/// Bounded memoization experiment. Compare the SAME production Terms implementation with
/// no cache, an owner-private LRU, and LFU with foreground maintenance. Results separate
/// batch-average timing/allocation, instrumented per-call latency, and retained owner heap.
/// No sessions, writer gates, search index, model calls, or production budgets are modified.
/// Inputs/requests are prepared outside timing; text formatting/creation is not measured.
/// </summary>
internal static class Program
{
    private const int CallsPerRound = 512;
    private const int Rounds = 7;
    private static readonly string[] Policies = ["Uncached", "Lru", "LfuForeground"];
    private static readonly string Repeated = string.Join(' ', Enumerable.Repeat("BUILD workers build workers", 128));
    private static readonly string Unique = string.Join(' ', Enumerable.Range(0, 512).Select(i => $"token{i:D4}"));
    private static readonly (string Name, string Text)[] Profiles =
        [("Query", "build workers"), ("Repeated", Repeated), ("UniqueTerms", Unique)];

    private static void Main(string[] args)
    {
        int verified = Verify();
        if (args.Length == 1 && args[0] == "--verify-only")
        {
            Console.WriteLine($"PASS: {verified} parity inputs plus bounds, bypass, owner isolation, eviction, disposal, and parallel calls.");
            return;
        }
        if (args.Length == 0) throw new ArgumentException("Supply an output JSON path or --verify-only.");
        bool reverse = args.Contains("--reverse", StringComparer.Ordinal);
        var samples = new List<Sample>();
        foreach (var profile in Profiles)
            foreach (string scenario in new[] { "HotEqualText", "ColdUnique", "Mixed80Hot20Cold" })
                Measure(CreateWorkload(profile.Name, profile.Text, scenario), reverse, samples);
        Measure(CreateWorkload("Repeated", Repeated, "Churn256"), reverse, samples);
        Measure(CreateWorkload("Oversized", new string('A', 16_384), "HotEqualText"), reverse, samples);

        var heap = new List<HeapSample>();
        foreach (var profile in Profiles)
            foreach (string policy in reverse ? Policies.Reverse() : Policies.AsEnumerable())
                for (int round = 0; round < 3; round++)
                    heap.Add(MeasureHeap(profile, policy, round));
        long[] timer = new long[4096];
        for (int i = 0; i < timer.Length; i++)
        {
            long start = Stopwatch.GetTimestamp();
            timer[i] = Stopwatch.GetTimestamp() - start;
        }
        string root = FindRoot();
        string project = Path.Combine(root, @"benchmarks\LLMContextLib.CachingBenchmarks");
        var report = new
        {
            Methodology = "Owner-scoped exact-text memoization; seven rotating-order rounds of 512 calls. Batch timing/allocation and individually instrumented latency use SEPARATE freshly seeded owners. Foreground LFU, no background scheduler. Full GC only in separate heap sampling. Not BenchmarkDotNet or application latency evidence.",
            Runtime = RuntimeInformation.FrameworkDescription,
            OS = RuntimeInformation.OSDescription,
            Architecture = RuntimeInformation.ProcessArchitecture.ToString(),
            GCServer = System.Runtime.GCSettings.IsServerGC,
            TieredCompilation = Environment.GetEnvironmentVariable("DOTNET_TieredCompilation") ?? "runtime default",
            TieredPGO = Environment.GetEnvironmentVariable("DOTNET_TieredPGO") ?? "runtime default",
            Sdk = Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>()
                .Single(attribute => attribute.Key == "BuildSdk").Value,
            Reverse = reverse,
            VerifiedInputs = verified,
            CachedTerms.Capacity,
            CachedTerms.MaximumCacheableCharacters,
            Stopwatch.Frequency,
            TimerBracket = new { P50Ns = Percentile(timer, .5), P95Ns = Percentile(timer, .95), P99Ns = Percentile(timer, .99), RawTicks = timer },
            Assemblies = Directory.GetFiles(AppContext.BaseDirectory, "*.dll")
                .Select(path => new { Name = Path.GetFileName(path), Bytes = new FileInfo(path).Length, Sha256 = Hash(path) }),
            Sources = Directory.GetFiles(project, "*.cs").Concat([
                    Path.Combine(project, "LLMContextLib.CachingBenchmarks.csproj"),
                    Path.Combine(project, "packages.lock.json"),
                    Path.Combine(project, "NuGet.Fallback.Config"),
                    Path.Combine(root, @"src\LLMContextLib\ContextPolicies.cs"),
                    Path.Combine(root, "Directory.Build.props"), Path.Combine(root, "global.json")])
                .Select(path => new { Path = Path.GetRelativePath(root, path), Sha256 = Hash(path) }),
            Dependencies = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "LLMContextLib.CachingBenchmarks.deps.json")),
            Samples = samples,
            Retention = heap
        };
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args[0]))!);
        File.WriteAllText(args[0], JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"{report.Runtime}; parity={verified}; reverse={reverse}");
        foreach (var group in samples.GroupBy(s => (s.Profile, s.Scenario, s.Policy)))
            Console.WriteLine($"{group.Key.Profile,-12} {group.Key.Scenario,-20} {group.Key.Policy,-15} meanNs={Median(group.Select(s => s.AverageNanoseconds)):F1} B/op={Median(group.Select(s => s.Bytes)):F1} factory={group.Sum(s => s.BatchComputations)}/{group.Count() * CallsPerRound}");
        foreach (var group in heap.GroupBy(s => (s.Profile, s.Policy)))
            Console.WriteLine($"Heap {group.Key.Profile,-12} {group.Key.Policy,-15} live={Median(group.Select(s => (double)s.LiveBytes)):F0} count={group.First().Footprint.Count} keyEstimate={group.First().Footprint.EstimatedKeyBytes} membershipEstimate={group.First().Footprint.EstimatedMembershipBytes}");
    }

    /// <summary>
    /// Each round starts from a new owner: only the explicitly declared hot set is seeded.
    /// Cold keys are unique across all measured requests. Hot requests use different string
    /// INSTANCES with equal contents, preventing reference-equality-only cache-hit shortcuts.
    /// Churn walks 256 keys against capacity 64. Oversized text is always bypassed.
    /// </summary>
    private static Workload CreateWorkload(string profile, string text, string scenario)
    {
        int hotCount = scenario == "Mixed80Hot20Cold" ? 16 : scenario == "Churn256" ? 256 : 1;
        var hot = Enumerable.Range(0, hotCount).Select(i => text + (hotCount == 1 ? "" : $" hot{i}")).ToArray();
        string[] seeds = scenario is "ColdUnique" or "Churn256" ? [] : hot;
        var inputs = Enumerable.Range(0, CallsPerRound * Rounds).Select(i =>
            scenario == "ColdUnique" || (scenario == "Mixed80Hot20Cold" && i % 5 == 0)
                ? text + $" cold{i}" : new string(hot[i % hot.Length].AsSpan())).ToArray();
        return new(profile, scenario, inputs, seeds);
    }

    private static CachedTerms Seed(Workload workload, string policy)
    {
        var owner = new CachedTerms(policy);
        foreach (string text in workload.Seeds) owner.Get(text);
        owner.Maintain();
        return owner;
    }

    private static void Measure(Workload workload, bool reverse, List<Sample> samples)
    {
        // Warm code paths without warming any of the later measured owners/cold request sets.
        foreach (string policy in Policies)
            using (var warm = new CachedTerms(policy))
                for (int i = 0; i < 128; i++) warm.Get(workload.Inputs[i]);
        for (int round = 0; round < Rounds; round++)
            for (int position = 0; position < Policies.Length; position++)
            {
                int offset = (position + round) % Policies.Length;
                string policy = Policies[((round % 2 == 0) ^ reverse) ? offset : Policies.Length - 1 - offset];
                using var owner = Seed(workload, policy);
                long computations = owner.Computations;
                long allocated = GC.GetAllocatedBytesForCurrentThread();
                long start = Stopwatch.GetTimestamp();
                int checksum = 0;
                for (int i = 0; i < CallsPerRound; i++)
                    checksum += owner.Get(workload.Inputs[round * CallsPerRound + i]).Length;
                long elapsed = Stopwatch.GetTimestamp() - start;
                allocated = GC.GetAllocatedBytesForCurrentThread() - allocated;
                long batchComputations = owner.Computations - computations;
                GC.KeepAlive(checksum);
                int beforeMaintenance = owner.Count;
                var footprint = owner.Snapshot();

                // This second pass measures REAL individually bracketed calls, not percentiles
                // fabricated from batch averages. Timer overhead is included, not subtracted.
                // Record raw ticks so pooled percentiles can be recomputed over both processes.
                using var latencyOwner = Seed(workload, policy);
                computations = latencyOwner.Computations;
                long[] ticks = new long[CallsPerRound];
                for (int i = 0; i < ticks.Length; i++)
                {
                    start = Stopwatch.GetTimestamp();
                    checksum += latencyOwner.Get(workload.Inputs[round * CallsPerRound + i]).Length;
                    ticks[i] = Stopwatch.GetTimestamp() - start;
                }
                GC.KeepAlive(checksum);
                samples.Add(new(workload.Profile, workload.Scenario, policy, round,
                    elapsed * 1_000_000_000d / Stopwatch.Frequency / CallsPerRound,
                    (double)allocated / CallsPerRound, batchComputations,
                    latencyOwner.Computations - computations, beforeMaintenance, footprint,
                    Percentile(ticks, .5), Percentile(ticks, .95), Percentile(ticks, .99), ticks));
            }
    }

    /// <summary>
    /// Generate keys INSIDE the owner-population helper so no caller array keeps them alive.
    /// Heap after churn therefore includes cached text keys, values, nodes, and policy buffers,
    /// unlike the preceding tokenizer experiment's returned-output-only measurement.
    /// Clearing/disposal is measured with no escaped result handles and stopped borrowers.
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static HeapSample MeasureHeap((string Name, string Text) profile, string policy, int round)
    {
        long before = GC.GetTotalMemory(forceFullCollection: true);
        using var owner = new CachedTerms(policy);
        Populate(owner, profile.Text);
        var footprint = owner.Snapshot();
        long live = GC.GetTotalMemory(forceFullCollection: true) - before;
        owner.Dispose();
        long disposed = GC.GetTotalMemory(forceFullCollection: true) - before;
        GC.KeepAlive(owner);
        return new(profile.Name, policy, round, live, disposed, footprint);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Populate(CachedTerms owner, string text)
    {
        for (int i = 0; i < CachedTerms.Capacity * 16; i++) owner.Get(text + $" retained{i}");
        owner.Maintain();
    }

    private static int Verify()
    {
        var random = new Random(1729);
        var inputs = Profiles.Select(p => p.Text).Concat(["", "ABC abc", "\u0130I\u0131i \u03a3\u03c2 a\u0301 \ud801\udc00",
                new string('A', 16_384)])
            .Concat(Enumerable.Range(0, 256).Select(_ => new string(Enumerable.Range(0, 128)
                .Select(_ => (char)random.Next(65_536)).ToArray()))).ToArray();
        foreach (string policy in Policies)
        {
            using var owner = new CachedTerms(policy);
            foreach (string input in inputs)
                if (!owner.Get(input).SequenceEqual(ContextPolicies.Terms(input)))
                    throw new InvalidOperationException($"Policy mismatch: {policy}");
            var retained = owner.Get("stable original");
            Populate(owner, "churn");
            if (!retained.SequenceEqual(ContextPolicies.Terms("stable original")))
                throw new InvalidOperationException("Eviction changed an escaped value.");
            if (owner.Snapshot().Count > CachedTerms.Capacity)
                throw new InvalidOperationException("Quiescent capacity exceeded.");
            long before = owner.Computations;
            owner.Get(new string('A', 16_384));
            owner.Get(new string('A', 16_384));
            if (owner.Computations - before != 2) throw new InvalidOperationException("Oversized input was cached.");
            try { owner.Get(null!); throw new InvalidOperationException("Null accepted."); }
            catch (ArgumentNullException error) when (error.ParamName == "text") { }
            owner.Get("owner isolation");
            using var independent = new CachedTerms(policy);
            independent.Get("owner isolation");
            if (independent.Computations != 1) throw new InvalidOperationException("Owner state leaked.");
            Parallel.For(0, 512, i =>
            {
                string text = "parallel " + i % 16;
                if (!owner.Get(text).SequenceEqual(ContextPolicies.Terms(text)))
                    throw new InvalidOperationException("Parallel policy mismatch.");
            });
            if (owner.Snapshot().Count > CachedTerms.Capacity)
                throw new InvalidOperationException("Parallel quiescent capacity exceeded.");
            owner.Dispose();
            if (!retained.SequenceEqual(ContextPolicies.Terms("stable original")))
                throw new InvalidOperationException("Disposal changed an escaped value.");
            try { owner.Get("disposed"); throw new InvalidOperationException("Disposed owner accepted work."); }
            catch (ObjectDisposedException) { }
        }
        return inputs.Length;
    }

    private static double Percentile(long[] values, double percentile)
    {
        var sorted = values.Order().ToArray();
        return sorted[(int)Math.Ceiling(percentile * sorted.Length) - 1] * 1_000_000_000d / Stopwatch.Frequency;
    }

    private static double Median(IEnumerable<double> values)
    {
        var sorted = values.Order().ToArray();
        return sorted[sorted.Length / 2];
    }

    private static string FindRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "LLMContextLib.sln")))
            directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("Run inside the checkout.");
    }

    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
    private sealed record Workload(string Profile, string Scenario, string[] Inputs, string[] Seeds);
    private sealed record Sample(string Profile, string Scenario, string Policy, int Round,
        double AverageNanoseconds, double Bytes, long BatchComputations, long LatencyComputations,
        int CountBeforeMaintenance, CacheFootprint Footprint, double P50Ns, double P95Ns, double P99Ns, long[] RawLatencyTicks);
    private sealed record HeapSample(string Profile, string Policy, int Round,
        long LiveBytes, long DisposedBytes, CacheFootprint Footprint);
}
