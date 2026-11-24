// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using LLMContextLib;

if (args is ["--views"])
{
    ViewTrace.Run();
    return;
}
if (args is ["--configuration"])
{
    ConfigurationTrace.Run();
    return;
}
if (args is ["--lifecycle"])
{
    await LifecycleTrace.Run();
    return;
}
if (args is ["--supported-contracts"])
{
    await SupportedContractTrace.Run();
    return;
}
if (args is ["--content-records"])
{
    ContentRecordTrace.Run();
    return;
}
if (args is ["--scalar-records"])
{
    ScalarRecordTrace.Run();
    return;
}
if (args is ["--entry-records"])
{
    EntryRecordTrace.Run();
    return;
}
if (args is ["--compound-records"])
{
    CompoundRecordTrace.Run();
    return;
}
if (args is ["--partitioned"] or ["--write-optimized"])
{
    await PartitionTrace.Run(args[0] == "--write-optimized");
    return;
}
if (args is ["--write-optimized-mixed"])
{
    await PartitionTrace.RunMixed();
    return;
}
if (args is ["--timestamps"])
{
    const string format = "yyyy-MM-dd'T'HH:mm:ss.fffffffzzz";
    foreach (string input in new[]
    {
        "0001-01-01T00:00:00.0000000+00:00", "9999-12-31T23:59:59.9999999+00:00",
        "0001-01-01T14:00:00.0000000+14:00", "9999-12-31T09:59:59.9999999-14:00",
        "0001-01-01T13:59:59.9999999+14:00", "9999-12-31T10:00:00.0000000-14:00",
        "1970-01-01T00:00:00.0000001+00:00", "1969-12-31T23:59:59.9999999+00:00",
        "1900-02-29T00:00:00.0000000+00:00", "2000-02-29T00:00:00.0000000+00:00",
        "2026-04-31T00:00:00.0000000+00:00", "2026-12-31T23:59:59.9999999+14:01",
        "2026-12-31T23:59:59.9999999-13:60", "2026-12-31T24:00:00.0000000+00:00"
    })
    {
        bool valid = DateTimeOffset.TryParseExact(input, format, CultureInfo.InvariantCulture, DateTimeStyles.None, out var value);
        Console.WriteLine(JsonSerializer.Serialize(new { input, ticks = valid ? EpochTicks(value) : null }));
    }

    var random = new Random(1729);
    for (int i = 0; i < 10_000; i++)
    {
        var utc = DateTimeOffset.FromUnixTimeMilliseconds(random.NextInt64(-62135510400000L, 253402214400000L))
            .AddTicks(random.Next(10_000));
        var value = utc.ToOffset(TimeSpan.FromMinutes(random.Next(-840, 841)));
        Console.WriteLine(JsonSerializer.Serialize(new { input = value.ToString(format, CultureInfo.InvariantCulture), ticks = EpochTicks(value) }));
    }
    return;
}
if (args is ["--options"])
{
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        Core = OptionSnapshot(new LLMContextOptions()),
        WriteOptimized = OptionSnapshot(LLMContextOptions.WriteOptimized),
        Deferred = OptionSnapshot(new DeferredIndexingOptions()),
        Partitioned = OptionSnapshot(new PartitionedContextIndexOptions()),
        Execution = OptionSnapshot(new ContextExecutionOptions()),
    }));
    return;
}
if (args is ["--int64"])
{
    long[] edges = [long.MinValue, long.MinValue + 1, -9007199254740992L, -9007199254740991L, -1, 0,
        1, 9007199254740991L, 9007199254740992L, long.MaxValue - 1, long.MaxValue];
    foreach (long left in edges)
        foreach (long right in edges)
            WriteWide(left, right);
    var random = new Random(1729);
    var bytes = new byte[16];
    for (int i = 0; i < 4096; i++)
    {
        random.NextBytes(bytes);
        WriteWide(System.Buffers.Binary.BinaryPrimitives.ReadInt64LittleEndian(bytes),
            System.Buffers.Binary.BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(8)));
    }
    return;
}

var session = Id(1);
var first = Id(3);
var second = Id(4);
var bookmark = Id(5);
var time = DateTimeOffset.UnixEpoch;
var original = new TextContent("wide Straße");
using var owner = LLMContextFactory.Create(new LLMContextOptions
{
    MaximumEstimatedBytesPerSegment = long.MaxValue,
    EstimatedResidentByteBudget = long.MaxValue,
    MaximumEstimatedRetainedBytes = long.MaxValue,
    EntrySizeEstimator = entry => ((TextContent)entry.Content).Text == "overflow" ? long.MaxValue : 9007199254740993L,
    ProjectionSizeEstimator = _ => 41,
}).WithExecutionStrategies(new()).Initialize([new LLMSessionContext(
    session, Id(2), null, 0, SessionStatus.Active,
    ImmutableSortedDictionary<long, ContextSegment>.Empty,
    ImmutableDictionary<Guid, ConversationAnchor>.Empty)]);

Trace("created");
Trace("append", owner.Apply(new(session, 0, [new AppendEntries([new(first, ContextRole.User, time, original)])])));
using (var old = owner.OpenRead(session))
{
    Trace("capture", read: old);
    Trace("invalid", owner.Apply(new(session, 1, [new ReplaceEntry(first, new TextContent("discarded")),
        new ReplaceEntry(second, new TextContent("unknown"))])), old);
    Trace("overflow", owner.Apply(new(session, 1, [new ReplaceEntry(first, new TextContent("overflow"))])), old);
    Trace("same-payload", owner.Apply(new(session, 1, [new ReplaceEntry(first, original)])), old);
    Trace("replace", owner.Apply(new(session, 2, [new ReplaceEntry(first, new TextContent("discarded")),
        new ReplaceEntry(first, new TextContent("final Straße"))])), old);
    Trace("anchor", owner.Apply(new(session, 3, [new AppendEntries([new(second, ContextRole.User, time, new TextContent("tail"))]),
        new PutAnchor(new(bookmark, first, second, "label", "memo", ["topic"], AnchorKind.Manual, 4, null))])), old);
    Trace("relocate", owner.Apply(new(session, 4, [
        new PutAnchor(new(bookmark, second, second, "label", "memo", ["topic"], AnchorKind.Manual, 5, null))])), old);
    using (owner.OpenView(ContextViews.Timeline(session))) Trace("view", read: old);
    Trace("delete", owner.Apply(new(session, 5, [new DeleteEntry(second)])), old);
    if (!owner.TryFind(session, out var current)) throw new InvalidOperationException("Session disappeared.");
    var segment = current.Segments.Values.Single();
    var entry = segment.Entries.Single();
    Trace("segment-invalid-sequence", owner.Apply(new(session, 6, [
        new ReplaceSegment(segment.SegmentId, [entry with { Sequence = entry.Sequence + 1 }])])), old);
    var replacement = new ReplaceSegment(segment.SegmentId, [entry with { Content = new TextContent("segment label") }]);
    Trace("segment-replace", owner.Apply(new(session, 6, [replacement])), old);
    Trace("segment-stale", owner.Apply(new(session, 6, [replacement])), old);
}
Trace("released");

static Guid Id(int value) => new($"00000000-0000-0000-0000-{value:000000000000}");
static string EpochTicks(DateTimeOffset value) => (value.UtcTicks - DateTimeOffset.UnixEpoch.UtcTicks).ToString(CultureInfo.InvariantCulture);

static void WriteWide(long left, long right)
{
    string? sum;
    try { sum = checked(left + right).ToString(CultureInfo.InvariantCulture); }
    catch (OverflowException) { sum = null; }
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        left = left.ToString(CultureInfo.InvariantCulture),
        right = right.ToString(CultureInfo.InvariantCulture),
        uncheckedIncrement = unchecked(left + 1).ToString(CultureInfo.InvariantCulture),
        comparison = left.CompareTo(right),
        sum,
    }));
}

static object? OptionSnapshot(object? value) => value switch
{
    null or int or long or bool => value,
    Enum kind => kind.ToString(),
    TimeSpan duration => duration.TotalMilliseconds,
    _ => value.GetType().GetProperties(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)
        .Where(property => property.Name is "InfrastructureBytes" or "RecoveryBytes" or "SerializeSessionPreparation" ||
            (property.GetMethod?.IsPublic == true && property.Name is not (nameof(LLMContextOptions.TimeProvider)
                or nameof(LLMContextOptions.EntrySizeEstimator) or nameof(LLMContextOptions.ProjectionSizeEstimator))))
        .ToDictionary(property => property.PropertyType == typeof(TimeSpan) ? $"{property.Name}Ms" : property.Name,
            property => OptionSnapshot(property.GetValue(value))),
};

void Trace(string label, IContextMutationResult? result = null, ILLMContextReadLease? read = null)
{
    using var current = owner.OpenRead(session);
    var hits = current.Search("label", 8).Select(hit => hit.EntryId.ToString()).ToArray();
    var entries = current.ReadRange(0, 8).Select(entry => ((TextContent)entry.Content).Text).ToArray();
    var revision = current.Session.Revision;
    current.Dispose();
    var stats = owner.GetStatistics();
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        label, status = result?.Status.ToString(), revision, hits, entries, oldRevision = read?.Session.Revision,
        active = stats.EstimatedActiveBytes.ToString(), retained = stats.EstimatedRetainedBytes.ToString(),
        view = stats.EstimatedViewBytes.ToString(), reads = stats.RetainedReads,
        published = stats.PublishedMutations, rewrites = stats.SegmentsRewritten,
        rewrittenBytes = stats.EstimatedSegmentBytesRewritten.ToString(),
        collections = stats.Execution?.TermCollections, synchronous = stats.Execution?.SynchronousEntries,
    }));
}
