// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Lucene.Net.Analysis.Util;
using Lucene.Net.Util;

namespace LLMContextLib.TokenizationBenchmarks;

/// <summary>
/// Finite paired tokenizer diagnostic, independent of the production solution/dependency graph.
/// Run twice per runtime with opposite method ordering. Every run first requires exact policy
/// parity. Timing/allocation include collection, deduplication, sorting, and immutable output;
/// they exclude prebuilt inputs and correctness checks. This is not BenchmarkDotNet isolation,
/// an application throughput test, or a full Lucene search-backend experiment.
/// </summary>
internal static class Program
{
    private static readonly (string Name, Func<string, ImmutableArray<string>> Run)[] Methods =
    [
        ("Current", ContextPolicies.Terms),
        ("DirectSort", TermCollectors.DirectSort),
        ("NormalizedRanges", TermCollectors.NormalizedRanges),
        ("LuceneCharTerm", TermCollectors.LuceneCharTerm),
        ("LuceneRangeBuffer", TermCollectors.LuceneRangeBuffer)
    ];

    private static readonly (string Name, string Text)[] Fixtures =
    [
        ("Empty", ""),
        ("Query", "Build workers WORKERS"),
        ("Repeated", string.Join(' ', Enumerable.Repeat("BUILD workers build workers", 128))),
        ("ToolJson", string.Join('\n', Enumerable.Repeat(
            """{"tool":"build-profiler","version":"example-v1","workload":"example-build","workers":4,"outcome":"Completed"}""", 32))),
        ("Unique", string.Join(' ', Enumerable.Range(0, 512).Select(i => $"token{i:D4}"))),
        ("Unicode", string.Concat(Enumerable.Repeat(
            "\u00c9CLAIR caf\u00e9 CAF\u00c9 \u03a3\u03c2 \u0130\u0131 \u4e2d\u6587123 \ud835\udd18nicode a\u0301 ", 96))),
        ("LongWord", new string('A', 16_384)),
        ("Punctuation", new string('!', 4096))
    ];

    private static void Main(string[] args)
    {
        if (args.Length == 0) throw new ArgumentException("Supply an output JSON path or --verify-only.");
        int verified = Verify();
        if (args[0] == "--verify-only")
        {
            Console.WriteLine($"PASS: {verified} parity inputs, null handling, stable output, and parallel calls.");
            return;
        }
        bool reverse = args.Contains("--reverse", StringComparer.Ordinal);
        var samples = Measure(reverse);
        var heap = new List<HeapSample>();
        foreach (var fixture in Fixtures.Where(f => f.Name is "Repeated" or "Unique" or "LongWord"))
            foreach (var method in reverse ? Methods.Reverse() : Methods.AsEnumerable())
                for (int round = 0; round < 3; round++)
                    heap.Add(MeasureRetained(fixture, method, round));

        // Resolve the repository from the checked-out project, not the caller's current folder.
        // Hash current sources and actual loaded assemblies so artifacts cannot silently refer
        // to an older binary or a different prototype than the one the report describes.
        string root = FindRoot();
        string project = Path.Combine(root, @"benchmarks\LLMContextLib.TokenizationBenchmarks");
        var report = new
        {
            Methodology = "Finite in-process paired diagnostic, seven rotating/reversed rounds after 256 warmups per method/fixture. GC is forced only for separate retained-output heap samples. No pooling, interning or cross-call cache. Not BenchmarkDotNet or application performance evidence.",
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
            LibrarySha256 = Hash(typeof(ContextPolicies).Assembly.Location),
            LuceneSha256 = Hash(typeof(LuceneVersion).Assembly.Location),
            AnalysisCommonSha256 = Hash(typeof(CharArraySet).Assembly.Location),
            ProbeBinarySha256 = Hash(Assembly.GetExecutingAssembly().Location),
            Assemblies = Directory.GetFiles(AppContext.BaseDirectory, "*.dll")
                .Select(path => new { Name = Path.GetFileName(path), Bytes = new FileInfo(path).Length, Sha256 = Hash(path) })
                .ToArray(),
            Sources = Directory.GetFiles(project, "*.cs").Append(Path.Combine(project,
                    "LLMContextLib.TokenizationBenchmarks.csproj"))
                .Append(Path.Combine(root, @"src\LLMContextLib\ContextPolicies.cs"))
                .Append(Path.Combine(root, "Directory.Build.props"))
                .Append(Path.Combine(root, "global.json"))
                .Append(Path.Combine(project, "packages.lock.json"))
                .Append(Path.Combine(project, "NuGet.Fallback.Config"))
                .Select(path => new { Path = Path.GetRelativePath(root, path), Sha256 = Hash(path) }).ToArray(),
            Dependencies = File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
                "LLMContextLib.TokenizationBenchmarks.deps.json")),
            Samples = samples,
            RetainedOutputs = heap
        };
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args[0]))!);
        File.WriteAllText(args[0], JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"{report.Runtime}; parity={verified}; reverse={reverse}");
        foreach (var group in samples.GroupBy(sample => (sample.Fixture, sample.Method)))
            Console.WriteLine($"{group.Key.Fixture,-12} {group.Key.Method,-19} ns/op={Median(group.Select(s => s.Nanoseconds)),12:F1} B/op={Median(group.Select(s => s.Bytes)),10:F0}");
        foreach (var group in heap.GroupBy(sample => (sample.Fixture, sample.Method)))
            Console.WriteLine($"Heap {group.Key.Fixture,-12} {group.Key.Method,-19} live={Median(group.Select(s => (double)s.LiveBytes)),12:F0} for 256 retained results");
    }

    /// <summary>
    /// Rotate first position each round and reverse traversal on alternate rounds. The second
    /// process reverses this schedule again. Every call uses the same delegate/length consumer,
    /// and the returned array and all temporary key/buffer allocations are charged to that call.
    /// Timing is still susceptible to tiered JIT, collections, and shared-machine interference.
    /// </summary>
    private static List<Sample> Measure(bool reverse)
    {
        var samples = new List<Sample>();
        foreach (var fixture in Fixtures)
        {
            foreach (var method in reverse ? Methods.Reverse() : Methods.AsEnumerable())
                for (int i = 0; i < 256; i++) GC.KeepAlive(method.Run(fixture.Text));
            int iterations = Math.Clamp(1_000_000 / Math.Max(1, fixture.Text.Length), 64, 20_000);
            for (int round = 0; round < 7; round++)
                for (int position = 0; position < Methods.Length; position++)
                {
                    int offset = (position + round) % Methods.Length;
                    int index = ((round % 2 == 0) ^ reverse) ? offset : Methods.Length - 1 - offset;
                    var method = Methods[index];
                    long bytes = GC.GetAllocatedBytesForCurrentThread();
                    long start = Stopwatch.GetTimestamp();
                    int checksum = 0;
                    for (int i = 0; i < iterations; i++) checksum += method.Run(fixture.Text).Length;
                    long ticks = Stopwatch.GetTimestamp() - start;
                    bytes = GC.GetAllocatedBytesForCurrentThread() - bytes;
                    GC.KeepAlive(checksum);
                    samples.Add(new(fixture.Name, fixture.Text.Length,
                        ContextPolicies.Terms(fixture.Text).Length, method.Name, round, iterations,
                        ticks * 1_000_000_000d / Stopwatch.Frequency / iterations, (double)bytes / iterations));
                }
        }
        return samples;
    }

    /// <summary>
    /// Retain only returned immutable arrays, never the temporary collectors. Full collections
    /// approximate incremental live managed output, not working set or a precise graph size.
    /// Warmed assembly/type infrastructure is outside this delta; package overhead is reported
    /// separately via dependency metadata, not misrepresented as zero because scratch is freed.
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static HeapSample MeasureRetained((string Name, string Text) fixture,
        (string Name, Func<string, ImmutableArray<string>> Run) method, int round)
    {
        var outputs = new ImmutableArray<string>[256];
        long before = GC.GetTotalMemory(forceFullCollection: true);
        for (int i = 0; i < outputs.Length; i++) outputs[i] = method.Run(fixture.Text);
        long bytes = GC.GetTotalMemory(forceFullCollection: true) - before;
        GC.KeepAlive(outputs);
        return new(fixture.Name, method.Name, round, bytes);
    }

    /// <summary>
    /// Check all UTF-16 code units separated by boundaries, adversarial scratch-buffer reuse,
    /// long words, supplied fixtures, and 2,000 deterministic random strings. Repeat relevant
    /// checks under Turkish culture and on parallel calls; no mutable collector may escape or
    /// be shared across requests. Null must retain the public argument-name contract.
    /// </summary>
    private static int Verify()
    {
        string allCharacters = string.Create(65_536 * 2, 0, static (destination, _) =>
        {
            for (int i = 0; i < 65_536; i++) { destination[2 * i] = (char)i; destination[2 * i + 1] = ' '; }
        });
        var random = new Random(1729);
        var inputs = Fixtures.Select(f => f.Text).Concat([
            allCharacters, "abc xyz abc xyztuv xyz", "aa ab ac ad aa ab ac ad",
            "\u0130I\u0131i \u03a3\u03c3\u03c2 \ud801\udc00 a\u0301",
            new string('A', 16_384) + " b " + new string('A', 16_384)])
            .Concat(Enumerable.Range(0, 2_000).Select(_ => new string(Enumerable.Range(0, 128)
                .Select(_ => (char)random.Next(65_536)).ToArray()))).ToArray();
        foreach (string input in inputs) VerifyInput(input);
        var culture = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("tr-TR");
            foreach (string input in inputs.Take(13)) VerifyInput(input);
        }
        finally { CultureInfo.CurrentCulture = culture; }
        Parallel.For(0, 128, i => VerifyInput(inputs[i % inputs.Length]));
        foreach (var method in Methods)
        {
            try { method.Run(null!); throw new InvalidOperationException($"Null accepted: {method.Name}"); }
            catch (ArgumentNullException error) when (error.ParamName == "text") { }
            var retained = method.Run("stable terms stable");
            method.Run("different payload with longer words");
            if (!retained.SequenceEqual(ContextPolicies.Terms("stable terms stable")))
                throw new InvalidOperationException($"Output changed: {method.Name}");
        }
        return inputs.Length;
    }

    private static void VerifyInput(string input)
    {
        var expected = ContextPolicies.Terms(input);
        foreach (var method in Methods)
            if (!expected.SequenceEqual(method.Run(input)))
                throw new InvalidOperationException($"Lexical mismatch: {method.Name}");
    }

    private static double Median(IEnumerable<double> values)
    {
        var sorted = values.Order().ToArray();
        return sorted.Length % 2 == 1 ? sorted[sorted.Length / 2]
            : (sorted[sorted.Length / 2 - 1] + sorted[sorted.Length / 2]) / 2;
    }

    private static string FindRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "LLMContextLib.sln")))
            directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("Run inside the source checkout.");
    }

    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
    private sealed record Sample(string Fixture, int Characters, int UniqueTerms, string Method,
        int Round, int Iterations, double Nanoseconds, double Bytes);
    private sealed record HeapSample(string Fixture, string Method, int Round, long LiveBytes);
}
