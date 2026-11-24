// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Text.Json;
using LLMContextLib;

internal static class ConfigurationTrace
{
    internal static void Run()
    {
        var rows = new List<object>();
        void Check(string label, Action action)
        {
            string outcome;
            try { action(); outcome = "ok"; }
            catch (Exception error) { outcome = error switch
            {
                ArgumentOutOfRangeException => "Range", ArgumentException => "Argument", OverflowException => "Overflow",
                _ => throw new Exception($"Unexpected {label}", error)
            }; }
            rows.Add(new { label, outcome });
        }
        foreach (string field in new[] { "ForegroundWords", "ForegroundCharacters", "MaximumPendingEntries", "MaximumEstimatedWorkBytes" })
            foreach (long value in new long[] { -1, 0, 1, int.MaxValue })
            {
                var limits = new DeferredIndexingOptions();
                Set(limits, field, value);
                Check($"deferred/{field}/{value}", () => LLMContextFactory.Create(new() { DeferredIndexing = limits }));
            }
        foreach (string field in new[] { "MaximumEstimatedPartitionBytes", "MaximumWorkingSetEntries",
            "MaximumEstimatedWorkingSetBytes", "MaximumPendingSynchronizations", "MaximumEstimatedPreparationBytes" })
            foreach (long value in new long[] { -1, 0, 1, int.MaxValue, long.MaxValue })
            {
                if (typeof(PartitionedContextIndexOptions).GetProperty(field)!.PropertyType == typeof(int) && value > int.MaxValue) continue;
                var limits = new PartitionedContextIndexOptions();
                Set(limits, field, value);
                Check($"partition/{field}/{value}", () => LLMContextFactory.Create(new()
                    { IndexingMode = ContextIndexingMode.ProducerOwned, PartitionedIndex = limits, EstimatedResidentByteBudget = long.MaxValue }));
            }
        Check("partition/unknown-behavior", () => LLMContextFactory.Create().WithPartitionedIndexing(new()
            { WriteBehavior = (ContextSynchronizationWriteBehavior)99 }));
        foreach (double value in new[] { -1d, 0d, .0001, 2147483647d, 2147483648d })
            Check($"partition/timeout/{value.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
                () => LLMContextFactory.Create().WithPartitionedIndexing(new()
                    { SynchronizationWaitTimeout = TimeSpan.FromMilliseconds(value) }));
        foreach (int value in new[] { -1, 0, 1, int.MaxValue })
            Check($"execution/threshold/{value}", () => LLMContextFactory.Create().WithExecutionStrategies(new()
                { MinimumDeferredCharacters = value }));
        Check("execution/null", () => LLMContextFactory.Create().WithExecutionStrategies(null!));
        Check("execution/unknown-indexing", () => LLMContextFactory.Create().WithExecutionStrategies(new()
            { Indexing = (ContextIndexingStrategy)99 }));
        Check("execution/unknown-preparation", () => LLMContextFactory.Create().WithExecutionStrategies(new()
            { Preparation = (ContextPreparationStrategy)99 }));
        Check("execution/append-without-deferred", () => LLMContextFactory.Create().WithExecutionStrategies(new()
            { Indexing = ContextIndexingStrategy.AppendOptimized }));
        Check("execution/synchronous-deferred", () => LLMContextFactory.Create(new() { DeferredIndexing = new() })
            .WithExecutionStrategies(new() { Indexing = ContextIndexingStrategy.Synchronous }).Initialize([]).Dispose());
        foreach (string field in new[] { "Capacity", "MaximumTextCharacters", "MaximumEstimatedBytes" })
            foreach (long value in new long[] { -1, 0, 1, 3, 8192, int.MaxValue, long.MaxValue })
            {
                if (typeof(BitFasterTermMemoOptions).GetProperty(field)!.PropertyType == typeof(int) && value > int.MaxValue) continue;
                var limits = new BitFasterTermMemoOptions();
                Set(limits, field, value);
                Check($"memo/{field}/{value}", () => LLMContextFactory.Create(new() { EstimatedResidentByteBudget = long.MaxValue })
                    .WithBitFasterTermMemoization(limits));
            }
        Check("lucene/unknown", () => LLMContextFactory.Create().WithLuceneTermCollection((LuceneTermCollection)99));
        Check("lucene/null-builder", () => LuceneExecutionExtensions.WithLuceneTermCollection(null!));
        Check("memo/null-builder", () => BitFasterExecutionExtensions.WithBitFasterTermMemoization(null!));
        Check("producer/collector", () => LLMContextFactory.Create().WithLuceneTermCollection().WithProducerOwnedIndexing());
        Check("producer/memo", () => LLMContextFactory.Create().WithBitFasterTermMemoization().WithProducerOwnedIndexing());
        using var owner = LLMContextFactory.Create()
            .WithExecutionStrategies(new() { Preparation = ContextPreparationStrategy.Serialized })
            .WithExecutionStrategies(new() { Indexing = ContextIndexingStrategy.Synchronous }).Initialize([]);
        rows.Add(new { label = "execution/replacement-recipe", preparation = owner.GetStatistics().Execution!.Preparation.ToString(),
            indexing = owner.GetStatistics().Execution!.Indexing.ToString() });
        Console.WriteLine(JsonSerializer.Serialize(new { reference = "479d2612315cbd292da917bae6d8d3fec35fea24", rows }));
    }

    private static void Set(object target, string field, long value)
    {
        var property = target.GetType().GetProperty(field)!;
        property.SetValue(target, property.PropertyType == typeof(int) ? (object)(int)value : value);
    }
}
