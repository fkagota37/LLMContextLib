// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using Xunit;

namespace LLMContextLib.Tests;

public sealed class CurrentReadTests
{
    [Fact]
    public void CaptureIsLazyStableAndRenewedBetweenScopes()
    {
        using var owner = LLMContextFactory.Create().Initialize([ContextTests.Session()]);
        var id = ContextTests.Id(1);
        ILLMContextReadLease? escaped = null;
        owner.WithCurrent(id, read =>
        {
            escaped = read;
            Assert.Equal(0, owner.GetStatistics().RetainedReads);
            Assert.Equal(ContextMutationStatus.Applied,
                owner.Apply(new(id, 0, [new SetSessionStatus(SessionStatus.Active)])).Status);
            Assert.Equal(1, read.Session.Revision);
            Assert.Equal(1, owner.GetStatistics().RetainedReads);
            Assert.Equal(ContextMutationStatus.Applied,
                owner.Apply(new(id, 1, [new SetSessionStatus(SessionStatus.Active)])).Status);
            Assert.Equal(1, read.Session.Revision);
        });
        Assert.Equal(0, owner.GetStatistics().RetainedReads);
        Assert.Throws<ObjectDisposedException>(() => escaped!.ReadRange(0, 1));
        owner.WithCurrent(id, read => Assert.Equal(2, read.Session.Revision));
        Assert.Equal(0, owner.GetStatistics().EstimatedRetainedBytes);
        owner.WithCurrent(ContextTests.Id(999), _ => { });
        Assert.Throws<KeyNotFoundException>(() =>
            owner.WithCurrent(ContextTests.Id(999), read => _ = read.Session));
    }

    [Fact]
    public void ExceptionsAndNestedScopesReleaseTheirOwnCaptures()
    {
        using var owner = LLMContextFactory.Create().Initialize([ContextTests.Session()]);
        var id = ContextTests.Id(1);
        Assert.Throws<InvalidOperationException>(() => owner.WithCurrent(id, outer =>
        {
            _ = outer.Session;
            owner.WithCurrent(id, inner =>
            {
                _ = inner.Session;
                Assert.Equal(2, owner.GetStatistics().RetainedReads);
            });
            Assert.Equal(1, owner.GetStatistics().RetainedReads);
            throw new InvalidOperationException("consumer failure");
        }));
        Assert.Equal(0, owner.GetStatistics().RetainedReads);
        Assert.Equal(0, owner.GetStatistics().EstimatedRetainedBytes);
    }

    [Fact]
    public async Task ConcurrentScopesNeverDisposeAnotherProducersRead()
    {
        using var owner = LLMContextFactory.Create().Initialize([ContextTests.Session()]);
        using var barrier = new Barrier(2);
        await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => Task.Run(() =>
            owner.WithCurrent(ContextTests.Id(1), read =>
            {
                Assert.NotEmpty(read.ReadRange(0, 1));
                Assert.True(barrier.SignalAndWait(TimeSpan.FromSeconds(10)));
                Assert.NotEmpty(read.ReadRange(0, 1));
            }))));
        Assert.Equal(0, owner.GetStatistics().RetainedReads);
    }
}
