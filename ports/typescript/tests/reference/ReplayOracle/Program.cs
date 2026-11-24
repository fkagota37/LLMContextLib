// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using LLMContextLib;
using LLMContextLib.Benchmarks;

var resolver = new DefaultJsonTypeInfoResolver();
resolver.Modifiers.Add(type =>
{
    Type[] variants = type.Type == typeof(ContextContent)
        ? [typeof(TextContent), typeof(ToolCallContent), typeof(ToolResultContent), typeof(SummaryContent)]
        : type.Type == typeof(ContextChange)
            ? [typeof(AppendEntries), typeof(ReplaceEntry), typeof(DeleteEntry), typeof(ReplaceSegment),
                typeof(PutAnchor), typeof(RemoveAnchor), typeof(SetSessionStatus)]
            : [];
    if (variants.Length == 0) return;
    type.PolymorphismOptions = new JsonPolymorphismOptions { TypeDiscriminatorPropertyName = "kind" };
    foreach (var variant in variants) type.PolymorphismOptions.DerivedTypes.Add(new(variant, variant.Name));
});
var json = new JsonSerializerOptions { TypeInfoResolver = resolver, Converters = { new JsonStringEnumConverter() } };
if (args is ["--concurrent-fixture"])
{
    var fixture = ContextFixture.Create("Interactive", sessionCount: 2);
    Console.WriteLine(JsonSerializer.Serialize(new { ContextFixture.Now, fixture.Sessions }, json));
    return;
}
if (args is ["--ramp-fixture"])
{
    var hot = ContextFixture.Create("Interactive", 512, 1);
    var distributed = ContextFixture.Create("Interactive", 128, 4);
    Console.WriteLine(JsonSerializer.Serialize(new { ContextFixture.Now, Hot = hot.Sessions, Distributed = distributed.Sessions }, json));
    return;
}
if (args is ["--pressure-fixture", var pressureCount] && int.TryParse(pressureCount, out var pressureEntries) &&
    pressureEntries is 512 or 1024 or 2048 or 4096 or 16384)
{
    var fixture = ContextFixture.Create("Interactive", pressureEntries);
    Console.WriteLine(JsonSerializer.Serialize(new { ContextFixture.Now, fixture.Sessions }, json));
    return;
}
int count = args.Length == 0 ? 128 : int.Parse(args[0]);
foreach (var scenario in Enum.GetValues<ContextScenario>())
{
    var fixture = ContextFixture.Create("Interactive", count, scenario == ContextScenario.ScopedMemory ? 2 : 1);
    var trace = ContextTraces.Create(fixture, scenario);
    ReplayChecks.Verify(fixture, trace);
    using var participant = BenchmarkParticipants.Create(ParticipantKind.LLMPolymorphic, fixture);
    var expected = ReplayEngine.Execute(participant, trace);
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        Scenario = scenario,
        ContextFixture.Now,
        fixture.Sessions,
        fixture.Options.MaximumEntriesPerSegment,
        fixture.Options.MaximumEstimatedBytesPerSegment,
        fixture.Options.MaximumEstimatedRetainedBytes,
        fixture.Options.MaximumRetainedReads,
        fixture.Options.MaximumViewResults,
        fixture.Options.EstimatedResidentByteBudget,
        Actions = trace.Select(action => new
        {
            action.Kind, action.SessionId, action.ExpectedRevision, action.RetentionId, action.Memory,
            Changes = action.Changes.IsDefault ? [] : action.Changes,
            Request = action.Request is null ? null : action.Request with { Scopes = BenchmarkParticipants.Scopes(action.Request) },
        }),
        expected.Steps,
    }, json));
}
