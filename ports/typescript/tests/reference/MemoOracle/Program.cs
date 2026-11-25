// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Text.Json;
using BitFaster.Caching.Lru;
using BitFaster.Caching.Lfu;
using BitFaster.Caching.Scheduler;

if (args is ["--lfu"] or ["--lfu-debug"])
{
    var sequence = new Random(4391);
    int trace = 0;
    foreach (int capacity in new[] { 3, 5, 10, 25, 32, 64 })
        foreach (int distribution in new[] { capacity - 1, capacity, capacity + 2, 3 * capacity })
            for (int repeat = 0; repeat < 3; repeat++)
            {
                var cache = new ConcurrentLfu<string, string>(4, capacity, new ForegroundScheduler(), new DiagnosticComparer());
                var steps = new List<object>();
                for (int index = 0; index < 2048; index++)
                {
                    string key = $"word{sequence.Next(distribution)}";
                    bool hit = true;
                    cache.GetOrAdd(key, k => { hit = false; return k; });
                    bool maintain = index % 19 == 0;
                    if (maintain) cache.DoMaintenance();
                    object? debug = null;
                    if (args[0] == "--lfu-debug" && trace == 18)
                    {
                        const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
                        var core = cache.GetType().GetField("core", flags)!.GetValue(cache)!;
                        var sketch = (CmSketch<string>)core.GetType().GetField("cmSketch", flags)!.GetValue(core)!;
                        var partition = (LfuCapacityPartition)core.GetType().GetField("capacity", flags)!.GetValue(core)!;
                        debug = new { keys = cache.Keys.Order(StringComparer.Ordinal).ToArray(),
                            queues = new[] { "windowLru", "probationLru", "protectedLru" }.Select(name =>
                                ((System.Collections.IEnumerable)core.GetType().GetField(name, flags)!.GetValue(core)!).Cast<object>()
                                    .Select(node => node.GetType().GetField("Key")!.GetValue(node)).ToArray()).ToArray(),
                            limits = new[] { partition.Window, partition.Probation, partition.Protected }, sketchSize = sketch.Size,
                            frequencies = Enumerable.Range(0, distribution).Select(i => sketch.EstimateFrequency($"word{i}")).ToArray() };
                    }
                    steps.Add(new { key, hit, count = cache.Count, maintain, debug,
                        keys = maintain ? cache.Keys.Order(StringComparer.Ordinal).ToArray() : null });
                }
                cache.DoMaintenance();
                if (args[0] != "--lfu-debug" || trace == 18)
                    Console.WriteLine(JsonSerializer.Serialize(new { capacity, steps, allCounterAging = System.Runtime.Intrinsics.X86.Avx2.IsSupported,
                        keys = cache.Keys.Order(StringComparer.Ordinal).ToArray() }));
                cache.Clear();
                trace++;
            }
    return;
}

var random = new Random(4391);
foreach (int capacity in new[] { 3, 4, 5, 6, 9, 10, 11, 25, 32, 64 })
{
    foreach (int distribution in new[] { capacity - 1, capacity, capacity + 2, 3 * capacity })
    {
        for (int repeat = 0; repeat < 8; repeat++)
        {
            var cache = new ConcurrentLru<string, string>(1, capacity, StringComparer.Ordinal);
            var steps = new (string Key, bool Hit, int Count)[240];
            for (int index = 0; index < steps.Length; index++)
            {
                string key = $"word{random.Next(distribution)}";
                bool hit = cache.TryGet(key, out _);
                if (!hit)
                    cache.GetOrAdd(key, k => k);
                steps[index] = (key, hit, cache.Count);
            }

            Console.WriteLine(JsonSerializer.Serialize(new
            {
                capacity,
                steps = steps.Select(step => new { key = step.Key, hit = step.Hit, count = step.Count })
            }));
        }
    }
}

sealed class DiagnosticComparer : IEqualityComparer<string>
{
    public bool Equals(string? left, string? right) => StringComparer.Ordinal.Equals(left, right);
    public int GetHashCode(string value)
    {
        uint hash = 0x811c9dc5;
        foreach (char character in value) hash = unchecked((hash ^ character) * 0x01000193);
        return unchecked((int)hash);
    }
}
