// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

namespace LLMContextLib;

/// <summary>
/// Entry point for constructing the single owning context client. Configuration and initial
/// session loading are separate so an application can establish policy before publishing data.
/// No model provider, external tool, or persistence service is constructed by this factory.
/// </summary>
public static class LLMContextFactory
{
    /// <summary>Validate construction policy and return a reusable initialization recipe.</summary>
    /// <param name="options">Construction-time limits/estimators, or null for the library defaults.</param>
    /// <param name="sessionIdSelector">
    /// Optional identity check for imported sessions. It must return each session's SessionId;
    /// it cannot remap canonical identities. Keep the delegate deterministic and non-reentrant.
    /// </param>
    /// <returns>A builder that creates a separate owner on every Initialize call.</returns>
    /// <exception cref="ArgumentOutOfRangeException">A configured limit or timeout is invalid.</exception>
    /// <exception cref="ArgumentNullException">A required callback or clock in options is null.</exception>
    public static LLMContextFactoryBuilder Create(
        LLMContextOptions? options = null,
        Func<LLMSessionContext, Guid>? sessionIdSelector = null)
    {
        var selected = options ?? new LLMContextOptions();
        selected.Validate();
        return new LLMContextFactoryBuilder(selected, sessionIdSelector ?? (session => session.SessionId));
    }
}

/// <summary>
/// Validated configuration awaiting initial sessions. Reusing the builder does not share state
/// between the owners it creates; share one initialized owner when workers need shared history.
/// </summary>
public sealed class LLMContextFactoryBuilder
{
    private readonly LLMContextOptions _options;
    private readonly Func<LLMSessionContext, Guid> _selector;
    internal LLMContextFactoryBuilder(LLMContextOptions options, Func<LLMSessionContext, Guid> selector)
        => (_options, _selector) = (options, selector);

    /// <summary>
    /// Load, validate, index, and admit initial session graphs, then transfer lifetime ownership
    /// to the caller. Empty input creates an empty owner; the memory catalog starts at revision zero.
    /// </summary>
    /// <param name="sessions">
    /// Initial immutable sessions, enumerated once. IDs must be unique, collections initialized,
    /// and complete reachable graphs valid; input revisions are preserved rather than reset.
    /// </param>
    /// <returns>A disposable client. Workers should borrow it instead of initializing their own copy.</returns>
    /// <exception cref="ArgumentNullException">The input sequence is null.</exception>
    /// <exception cref="ArgumentException">A session is invalid, duplicated, or cannot be admitted.</exception>
    /// <remarks>
    /// Initial loading is not externally visible until this call returns. If enumeration,
    /// validation, or admission fails, the partially populated owner is disposed before the
    /// exception escapes; callers do not receive a half-initialized client.
    /// </remarks>
    public ILLMContextPolymorphicArray Initialize(IEnumerable<LLMSessionContext> sessions)
    {
        ArgumentNullException.ThrowIfNull(sessions);
        var owner = new LLMContextPolymorphicArray(new SegmentedContextStorage(_options, _selector), _options);
        try
        {
            foreach (var session in sessions)
            {
                var result = owner.CreateSession(session);
                if (result.Status != ContextMutationStatus.Applied)
                    throw new ArgumentException(result.Error ?? "Invalid initial session.", nameof(sessions));
            }
            return owner;
        }
        catch
        {
            owner.Dispose();
            throw;
        }
    }
}
