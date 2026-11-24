// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Globalization;
using System.Text.Json;
using LLMContextLib;

internal static class ScalarRecordTrace
{
    internal static void Run()
    {
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        Guid first = new("abcdef01-2345-6789-aaaa-000000000001");
        Guid second = new("abcdefff-2345-6789-bbbb-000000000002");
        object[] records =
        [
            new MemoryScope(first), new MemoryScope(first, null, null), new MemoryScope(null, first, second),
            new MemorySource(first, second), new MemorySource(first, second), new MemorySource(second, first),
            new ContextCursor(first, 7, long.MaxValue), new ContextCursor(first, 7, long.MaxValue), new ContextCursor(first, 7, long.MinValue),
            new ModelContextItem(first, null, ContextRole.User, "Ordinal \u00DF"), new ModelContextItem(first, null, ContextRole.User, "Ordinal \u00DF"),
            new ModelContextItem(null, first, ContextRole.Tool, "ordinal \u00DF"),
            new ContextSearchHit(first, second, "", 4, long.MaxValue), new ContextSearchHit(first, second, "", 4, long.MaxValue),
            new ContextSearchHit(first, null, "", 4, long.MaxValue),
            new ContextIndexStatus(long.MaxValue, 42, 0), new ContextIndexStatus(long.MaxValue, 42, 0),
            new ContextIndexStatus(long.MaxValue, 42, 1, 1, "incomplete"),
            new ContextIndexSynchronization(first, long.MaxValue, 0, 3, true), new ContextIndexSynchronization(first, long.MaxValue, 0, 3, true),
            new ContextIndexSynchronization(second, long.MaxValue, 0, 3, false, "failed"),
            new DeleteEntry(first), new DeleteEntry(first), new DeleteEntry(second),
            new RemoveAnchor(first), new RemoveAnchor(first), new RemoveAnchor(second),
            new SetSessionStatus(SessionStatus.Active), new SetSessionStatus(SessionStatus.Active), new SetSessionStatus(SessionStatus.Expired),
            new ContextExecutionOptions(), new ContextExecutionOptions(),
            new ContextExecutionOptions { Preparation = ContextPreparationStrategy.Speculative },
            new DeferredIndexingOptions { MaximumEstimatedWorkBytes = long.MaxValue },
            new DeferredIndexingOptions { MaximumEstimatedWorkBytes = long.MaxValue }, new DeferredIndexingOptions(),
            new PartitionedContextIndexOptions(), new PartitionedContextIndexOptions(),
            new PartitionedContextIndexOptions { SynchronizationWaitTimeout = TimeSpan.FromTicks(1), WriteBehavior = ContextSynchronizationWriteBehavior.Wait },
            new PartitionedContextIndexOptions { SynchronizationWaitTimeout = TimeSpan.FromMilliseconds(int.MaxValue) },
            new BitFasterTermMemoOptions { MaximumEstimatedBytes = long.MaxValue },
            new BitFasterTermMemoOptions { MaximumEstimatedBytes = long.MaxValue },
            new BitFasterTermMemoOptions { MaximumTextCharacters = 33 },
            new ContextExecutionStatistics { TermCollector = "Native", TermCollections = long.MaxValue },
            new ContextExecutionStatistics { TermCollector = "Native", TermCollections = long.MaxValue },
            new ContextExecutionStatistics { TermCollector = "Native", TermCollections = long.MinValue, MemoAdmissionBypasses = 1 },
        ];
        var rows = records.Select(value =>
        {
            Type type = value.GetType();
            var deconstruct = type.GetMethod("Deconstruct");
            var fields = deconstruct is null ? null : new object?[deconstruct.GetParameters().Length];
            deconstruct?.Invoke(value, fields);
            object clone = type.GetMethod("<Clone>$")!.Invoke(value, null)!;
            return new
            {
                type = type.Name,
                value = type.GetProperties().ToDictionary(
                    property => property.PropertyType == typeof(TimeSpan) ? $"{property.Name}Ms" : property.Name,
                    property => Encode(property.GetValue(value))),
                text = value.ToString(),
                fields = fields?.Select(Encode),
                equals = records.Select(other => value.Equals(other)).ToArray(),
                copied = !ReferenceEquals(value, clone) && value.Equals(clone) && value.GetHashCode() == clone.GetHashCode(),
            };
        });
        Console.WriteLine(JsonSerializer.Serialize(rows));
    }

    private static object? Encode(object? value) => value switch
    {
        long length => length.ToString(CultureInfo.InvariantCulture),
        TimeSpan duration => duration.TotalMilliseconds,
        Enum name => name.ToString(),
        _ => value,
    };
}
