// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Globalization;
using System.Text.Json;
using LLMContextLib;

internal static class ContentRecordTrace
{
    internal static void Run()
    {
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        ContextContent[] cases =
        [
            new TextContent(""), new TextContent("value"), new TextContent("value"), new TextContent("Value"),
            new SummaryContent("value", 0), new SummaryContent("value", 9007199254740993), new SummaryContent("value", 9007199254740993),
            new ToolCallContent("call", "build", "{\"jobs\":2}"), new ToolCallContent("call", "build", "{ \"jobs\":2 }"),
            new ToolResultContent("call", "done", false), new ToolResultContent("call", "done", true),
        ];
        Console.WriteLine(JsonSerializer.Serialize(cases.Select(value =>
        {
            var copy = value with { };
            return new
            {
                display = value.ToString(),
                fields = Deconstruct(value),
                equal = cases.Select(other => value == other),
                equalBase = cases.Select(other => value.Equals(other)),
                equalObject = cases.Cast<object>().Append(new object()).Append("value").Select(other => value.Equals(other)),
                cloneDistinct = !ReferenceEquals(value, copy),
                cloneEqual = value == copy,
                cloneHashEqual = value.GetHashCode() == copy.GetHashCode(),
                equalsNull = value == null,
            };
        })));
    }

    private static object[] Deconstruct(ContextContent value)
    {
        switch (value)
        {
            case TextContent text:
                text.Deconstruct(out var words);
                return [words];
            case SummaryContent summary:
                var (content, through) = summary;
                return [content, through.ToString(CultureInfo.InvariantCulture)];
            case ToolCallContent call:
                var (callId, tool, arguments) = call;
                return [callId, tool, arguments];
            case ToolResultContent result:
                var (resultId, json, error) = result;
                return [resultId, json, error];
            default:
                throw new InvalidOperationException();
        }
    }
}
