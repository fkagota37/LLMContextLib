// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using LLMContextLib;

namespace LLMContextLib.Benchmarks;

internal static class ContextDemo
{
    internal static void Run()
    {
        var fixture = ContextFixture.Create("Interactive", entryCount: 32, sessionCount: 2);
        using var contexts = LLMContextFactory.Create(fixture.Options).Initialize(fixture.Sessions);
        var session = fixture.Sessions[0];
        using (var navigation = contexts.OpenView(ContextViews.Navigation(session.SessionId)))
            foreach (var target in navigation)
                Console.WriteLine($"NAVIGATE {target.Anchor.Title}: {target.Anchor.StartEntryId} -> {target.Status}");
        using (var conversation = contexts.OpenView(ContextViews.Conversation(session.SessionId, 3)))
            foreach (var entry in conversation)
                Console.WriteLine($"CONVERSATION {entry.Sequence}/{entry.Role}: {ContextPolicies.Text(entry.Content)[..48]}...");

        var source = ImmutableArray.Create(new MemorySource(session.SessionId, session.Anchors.Keys.First()));
        var repo = new ContextMemory(Guid.NewGuid(), new(RepositoryId: session.RepositoryId),
            "Repository context uses canonical entry IDs.", 0, MemoryStatus.Confirmed, null, source);
        var local = repo with { MemoryId = Guid.NewGuid(), Scope = new(SessionId: session.SessionId), Content = "This session is an in-memory PoC." };
        var result = contexts.ApplyMemory(new(0, [repo, local], []));
        Console.WriteLine($"MEMORY ADMISSION {result.Status}");
        using (var first = contexts.OpenView(ContextViews.Memory(session.SessionId, [repo.Scope, local.Scope])))
        using (var second = contexts.OpenView(ContextViews.Memory(fixture.Sessions[1].SessionId, [repo.Scope])))
            Console.WriteLine($"SCOPED MEMORY session one={first.Count}; session two={second.Count}");
        using var model = contexts.OpenView(ContextViews.Model(session.SessionId, 512, ContextFixture.EstimateTokens, [repo.Scope, local.Scope]));
        Console.WriteLine($"MODEL VIEW revision={model.SessionRevision}, memory={model.MemoryRevision}, items={model.Count}");
    }
}
