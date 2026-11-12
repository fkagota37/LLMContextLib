// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Diagnostics;
using System.Runtime;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Reflection;

namespace LLMContextLib.Benchmarks;

internal static class RunEvidence
{
    internal static void Save(string? output, string mode, object reports, string[] arguments)
    {
        if (output is null) return;
        string path = Path.GetFullPath(output);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "LLMContextLib.sln"))) root = root.Parent;
        var hashes = new SortedDictionary<string, string>(StringComparer.Ordinal);
        if (root is not null)
        {
            foreach (string folder in new[] { @"src\LLMContextLib", @"benchmarks\LLMContextLib.Benchmarks" })
                foreach (string file in Directory.EnumerateFiles(Path.Combine(root.FullName, folder), "*", SearchOption.AllDirectories)
                    .Where(file => (file.EndsWith(".cs", StringComparison.Ordinal) || file.EndsWith(".csproj", StringComparison.Ordinal)) &&
                        !file.Contains(@"\obj\", StringComparison.Ordinal) && !file.Contains(@"\bin\", StringComparison.Ordinal)))
                    hashes.Add(Path.GetRelativePath(root.FullName, file), Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));
            foreach (string name in new[] { "Directory.Build.props", "NuGet.Config", "global.json", "LLMContextLib.sln" })
            {
                string file = Path.Combine(root.FullName, name);
                hashes.Add(name, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));
            }
        }
        File.WriteAllText(path, JsonSerializer.Serialize(new
        {
            Mode = mode,
            TraceVersion = 1,
            RecordedAt = DateTimeOffset.UtcNow,
            Arguments = arguments,
            Runtime = RuntimeInformation.FrameworkDescription,
            Host = RuntimeInformation.OSDescription,
            BuildSdk = typeof(RunEvidence).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                .FirstOrDefault(attribute => attribute.Key == "BuildSdk")?.Value,
            Architecture = RuntimeInformation.ProcessArchitecture.ToString(),
            Environment.ProcessorCount,
            GCSettings.IsServerGC,
            LatencyMode = GCSettings.LatencyMode.ToString(),
            Stopwatch.Frequency,
            SourceHashes = hashes,
            Reports = reports
        }, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"Evidence saved: {path}");
    }
}
