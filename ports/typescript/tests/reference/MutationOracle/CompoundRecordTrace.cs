// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using LLMContextLib;

internal static class CompoundRecordTrace
{
    internal static void Run()
    {
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        var id = new Guid("abcdef01-2345-6789-aaaa-000000000001");
        var time = DateTimeOffset.UnixEpoch.AddTicks(7);
        var entry = new ContextEntry(id, 1, ContextRole.User, time, new TextContent("entry"));
        var entries = ImmutableArray.Create(entry);
        var segment = new ContextSegment(0, 7, entries);
        var segments = ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, segment);
        var anchor = new ConversationAnchor(id, id, id, "anchor", "", ["topic"], AnchorKind.Manual, 7, null)
            { IndexKeys = new(["opaque"]) };
        var anchors = ImmutableDictionary<Guid, ConversationAnchor>.Empty.Add(id, anchor);
        var session = new LLMSessionContext(id, id, null, 7, SessionStatus.Active, segments, anchors);
        var memory = new ContextMemory(id, new(id), "memory", 7, MemoryStatus.Confirmed, time, [new(id, id)]);
        var page = new ContextPage(entries, new(id, 7, 1));
        var indexed = new ContextIndexedSearchResult([new(id, null, "hit", 1, 7)], new(7, 1, 0));
        var resolution = new AnchorResolution(anchor, AnchorTargetStatus.Current, entry, entry, 7);
        var append = new AppendEntries([new(id, ContextRole.User, time, new TextContent("draft"))]);
        var replace = new ReplaceSegment(0, entries);
        var put = new PutAnchor(anchor);
        var replaceEntry = new ReplaceEntry(id, new TextContent("replacement"));
        var delete = new DeleteEntry(id);
        var remove = new RemoveAnchor(id);
        var status = new SetSessionStatus(SessionStatus.Active);
        var change = new ContextChangeSet(id, 7, [append]);
        var memoryChange = new MemoryChangeSet(7, [memory], [id]);
        var stats = new LLMContextStatistics(1, long.MaxValue, 0, 0, 7, 1, 1, 10)
            { Execution = new() { TermCollector = "Native" }, EstimatedPreparationBytes = 17 };
        object[] records =
        [
            segment, segment with { }, segment with { Entries = ImmutableArray.Create(entry) },
            session, session with { }, session with { Segments = ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, segment) },
            anchor, anchor with { }, anchor with { Topics = ImmutableArray.Create("topic") }, anchor with { IndexKeys = new(["opaque"]) },
            memory, memory with { Scope = new(id), ExpiresAt = time.ToOffset(TimeSpan.FromHours(-1)) },
            memory with { Sources = [new(id, id)] }, memory with { ExpiresAt = time.AddTicks(1) },
            page, page with { Next = page.Next! with { } }, page with { Entries = ImmutableArray.Create(entry) }, page with { Next = null },
            indexed, indexed with { IndexStatus = indexed.IndexStatus with { } }, indexed with { IndexStatus = indexed.IndexStatus with { PendingEntries = 1 } },
            resolution, resolution with { Anchor = anchor with { }, Start = entry with { }, End = entry with { CreatedAt = time.ToOffset(TimeSpan.FromHours(2)) } },
            resolution with { End = null },
            append, append with { }, append with { Entries = ImmutableArray.Create(append.Entries[0]) },
            replace, replace with { }, replace with { Entries = ImmutableArray.Create(entry) },
            put, put with { Anchor = anchor with { } }, put with { Anchor = anchor with { IndexKeys = null } },
            replaceEntry, replaceEntry with { Content = new TextContent("replacement") }, replaceEntry with { Content = new TextContent("other") },
            delete, delete with { }, delete with { EntryId = Guid.Empty },
            remove, remove with { }, remove with { AnchorId = Guid.Empty },
            status, status with { }, status with { Status = SessionStatus.Suspended },
            change, change with { }, change with { Changes = ImmutableArray.Create<ContextChange>(append) },
            memoryChange, memoryChange with { }, memoryChange with { Deletes = ImmutableArray.Create(id) },
            stats, stats with { Execution = stats.Execution! with { } }, stats with { EstimatedPreparationBytes = 18 }, stats with { Execution = null },
        ];
        var references = new Dictionary<object, int>();
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
                value = Encode(value),
                text = value.ToString(),
                fields = fields.Select(Encode),
                equals = records.Select(other => value.Equals(other)).ToArray(),
                changeEquals = value is ContextChange command
                    ? records.OfType<ContextChange>().Select(other => command.Equals(other)).Append(command.Equals(null)).ToArray()
                    : null,
                copied = !ReferenceEquals(value, clone) && value.Equals(clone) && value.GetHashCode() == clone.GetHashCode(),
            };
        })));

        object? Encode(object? value)
        {
            if (value is null or int or bool or string or Guid) return value;
            if (value is long number) return new { number = number.ToString(CultureInfo.InvariantCulture) };
            if (value is Enum name) return name.ToString();
            if (value is DateTimeOffset date) return date.ToString("o", CultureInfo.InvariantCulture);
            Type type = value.GetType();
            if (value is ContextIndexKeys || (type.Namespace == "System.Collections.Immutable" && type.IsGenericType))
            {
                if (!references.TryGetValue(value, out int reference)) references.Add(value, reference = references.Count + 1);
                return new { reference, isMap = type.Name.Contains("Dictionary", StringComparison.Ordinal) };
            }
            return new
            {
                record = type.Name,
                members = type.GetProperties().ToDictionary(property => property.Name, property => Encode(property.GetValue(value))),
            };
        }
    }
}
