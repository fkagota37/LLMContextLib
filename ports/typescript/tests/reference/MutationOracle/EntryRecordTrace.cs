// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Globalization;
using System.Text.Json;
using LLMContextLib;

internal static class EntryRecordTrace
{
    internal static void Run()
    {
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        Guid id = new("abcdef01-2345-6789-aaaa-000000000001");
        var instant = DateTimeOffset.Parse("2026-03-02T07:05:06.1234567+00:00", CultureInfo.InvariantCulture);
        var offset = instant.ToOffset(TimeSpan.FromMinutes(-210));
        ContextIndexKeys shared = new(["opaque"]);
        ContextIndexKeys separate = new(["opaque"]);
        var content = new TextContent("record");
        var entry = new ContextEntry(id, long.MaxValue, ContextRole.User, instant, content) { IndexKeys = shared };
        var draft = new ContextEntryDraft(id, ContextRole.User, instant, content) { IndexKeys = shared };
        var replace = new ReplaceEntry(id, content) { IndexKeys = shared };
        object[] records =
        [
            entry, entry with { CreatedAt = offset, Content = new TextContent("record") },
            entry with { CreatedAt = instant.AddTicks(1) }, entry with { IndexKeys = separate }, entry with { IndexKeys = null },
            draft, draft with { CreatedAt = offset }, draft with { Role = ContextRole.Assistant }, draft with { IndexKeys = separate },
            replace, replace with { Content = new TextContent("record") }, replace with { Content = new TextContent("other") },
            replace with { IndexKeys = separate }, replace with { IndexKeys = null },
        ];
        Console.WriteLine(JsonSerializer.Serialize(records.Select(value =>
        {
            Type type = value.GetType();
            var deconstruct = type.GetMethod("Deconstruct")!;
            var fields = new object?[deconstruct.GetParameters().Length];
            deconstruct.Invoke(value, fields);
            object clone = type.GetMethod("<Clone>$")!.Invoke(value, null)!;
            return new
            {
                type = type.Name,
                value = type.GetProperties().ToDictionary(property => property.Name, property => Encode(property.GetValue(value))),
                text = value.ToString(),
                fields = fields.Select(Encode),
                equals = records.Select(other => value.Equals(other)).ToArray(),
                copied = !ReferenceEquals(value, clone) && value.Equals(clone) && value.GetHashCode() == clone.GetHashCode(),
            };
        })));

        object? Encode(object? value) => value switch
        {
            long number => number.ToString(CultureInfo.InvariantCulture),
            Enum name => name.ToString(),
            DateTimeOffset time => time.ToString("o", CultureInfo.InvariantCulture),
            TextContent text => new { kind = "TextContent", text.Text },
            ContextIndexKeys keys => ReferenceEquals(keys, shared) ? "shared" : "separate",
            _ => value,
        };
    }
}
