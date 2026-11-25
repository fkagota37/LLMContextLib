// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text.Json;
using LLMContextLib;

using var captured = new ManualResetEventSlim();
var clock = new CaptureClock(captured);
Guid sessionId = new("00000000-0000-0000-0000-000000000001");
using var owner = LLMContextFactory.Create(new LLMContextOptions
{
    MaximumRetainedReads = 1,
    AdmissionTimeout = TimeSpan.FromSeconds(3),
    TimeProvider = clock,
}).Initialize([new LLMSessionContext(
    sessionId, new("00000000-0000-0000-0000-000000000002"), null, 0, SessionStatus.Active,
    ImmutableSortedDictionary<long, ContextSegment>.Empty,
    ImmutableDictionary<Guid, ConversationAnchor>.Empty)]);

using var held = owner.OpenRead(sessionId);
var writer = Task.Factory.StartNew(() =>
{
    try
    {
        if (!captured.Wait(TimeSpan.FromSeconds(3)))
            throw new InvalidOperationException("The second reader did not capture its roots.");
        var appended = owner.Apply(new(sessionId, 0, [new AppendEntries([
            new ContextEntryDraft(Guid.NewGuid(), ContextRole.User, DateTimeOffset.UtcNow, new TextContent("concurrent update"))
        ])]));
        if (appended.Status != ContextMutationStatus.Applied)
            throw new InvalidOperationException($"Concurrent writer failed: {appended.Status}.");
    }
    finally
    {
        held.Dispose();
    }
}, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

using var admitted = owner.OpenRead(sessionId);
await writer;
if (!owner.TryFind(sessionId, out var current) || admitted.Session.Revision != 0 || current.Revision != 1)
    throw new InvalidOperationException("The waiting reader did not preserve the pre-wait capture.");

Console.WriteLine(JsonSerializer.Serialize(new { admitted = true, capturedRevision = admitted.Session.Revision, currentRevision = current.Revision }));

sealed class CaptureClock(ManualResetEventSlim captured) : TimeProvider
{
    private int calls;
    public override DateTimeOffset GetUtcNow()
    {
        if (Interlocked.Increment(ref calls) == 2) captured.Set();
        return DateTimeOffset.UnixEpoch;
    }
}
