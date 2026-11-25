# LLMContextLib

> **Experimental / work in progress.** This library is **not production-ready**
> and has **no stable, versioned release**. APIs, behavior, resource policies, and
> any future persistence formats may change without compatibility guarantees.
> Use it for evaluation and prototyping; passing tests or benchmark results are
> not production-readiness certification. See `TODO.md` for open design concerns
> and opportunities.

**Turn a conversation into a shared, navigable workspace for people and agents,
not just a growing prompt.**

LLMContextLib is a .NET library with a TypeScript/Node.js port for applications that need to revisit decisions,
connect tool results to their reasoning, and reuse knowledge across related
conversations. Store a session once; expose conversation, navigation, search,
memory, and model-input views without maintaining separate transcripts.

```text
                       One session history
                               |
        +----------------------+----------------------+
        |                      |                      |
  Conversation UI        Navigation outline      Tool inspection
  messages to show       topics and decisions    calls and results
                               |
                       anchors into the text
                               |
                     scoped, reusable memory
                               |
                  model input within a token budget
```

The application still runs tools, calls models, renders its UI, and schedules
workers. **LLMContextLib is its shared context layer**, not a model runtime,
autonomous-agent framework, or build runner.

Token budgets are **caller-owned context properties**. The library honors a
supplied budget when assembling model input; it does not allocate budgets,
choose model limits, or provide a model tokenizer.

## Choose an implementation

| Implementation               | Start here                                                                                         | Status                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| .NET 8 / .NET 9              | [Startup below](#recommended-startup), [technical usage](docs/usage-documentation.md)              | Experimental; original implementation                                                              |
| TypeScript / Node.js 22, ESM | [Port README](ports/typescript/README.md), [runnable walkthrough](ports/typescript/walkthrough.md) | Experimental; supported-contract parity qualified against the pinned .NET reference on Windows x64 |

The TypeScript port includes its own source, tests, examples, benchmark tools,
and separately installable Lucene/BitFaster adapter equivalents under
`ports\typescript`. It is not a separate context engine or a publicly published,
stable npm release. See its [parity statement](ports/typescript/parity.md) for
the reference pin, evidence, runtime-specific differences, and qualification limits.

## Recommended startup

The following example uses .NET. For Node.js, use the
[TypeScript walkthrough](ports/typescript/walkthrough.md).

Start with the **`WriteOptimized` preset**, our latest tested producer-owned,
partitioned configuration. Here, "producer" just means your calling application.
This complete example creates an empty conversation, adds a searchable message
and reads it back. You do not need to construct storage partitions.

```csharp
using System.Collections.Immutable;
using LLMContextLib;

var sessionId = Guid.NewGuid();
var session = new LLMSessionContext(
    SessionId: sessionId,
    UserId: Guid.NewGuid(),
    RepositoryId: null,
    Revision: 0,
    Status: SessionStatus.Active,
    Segments: ImmutableSortedDictionary<long, ContextSegment>.Empty,
    Anchors: ImmutableDictionary<Guid, ConversationAnchor>.Empty);
LLMSessionContext[] sessions = [session];

using var contexts = LLMContextFactory
    .Create(LLMContextOptions.WriteOptimized)
    .Initialize(sessions);

// Your application chooses exact-match labels before submitting the message.
var entry = new ContextEntryDraft(
    EntryId: Guid.NewGuid(),
    Role: ContextRole.User,
    CreatedAt: DateTimeOffset.UtcNow,
    Content: new TextContent("The build cache is enabled."))
{
    IndexKeys = new ContextIndexKeys(["topic:build", "feature:cache"])
};
var result = contexts.Apply(new ContextChangeSet(sessionId, 0,
    [new AppendEntries([entry])]));
if (result.Status != ContextMutationStatus.Applied)
    throw new InvalidOperationException($"{result.Status}: {result.Error}");

contexts.WithCurrent(sessionId, read =>
{
    var hits = read.SearchKeys(new ContextIndexKeys(["feature:cache"]), 16);
    Console.WriteLine($"Matching entries: {hits.Length}");
    foreach (var hit in hits)
        Console.WriteLine(hit.Snippet);
});
```

`sessions` is an array of session records; the owner builds their storage and
indexes. `IndexKeys` are your application's exact-match labels, not automatically
generated text tokens. Share this one owner with your workers.

**Start here without choosing individual limits.** Continue with the guides
below when you need integration details or have measurements that call for tuning.

## Next steps

For TypeScript, use the [port documentation](ports/typescript/README.md).
The following guides describe the .NET implementation:

- [Technical usage](docs/usage-documentation.md): ownership, loading sessions,
  reads/writes, application integration, and build/run instructions.
- [Configuration tuning](docs/config-tuning.md): exact preset values and
  metric-driven adjustments.
- [Runnable application example](examples/BuildInvestigation/README.md):
  a build-investigation assistant sharing context across workers.

## License

MIT licensed. See `LICENSE` for the copyright notice and full terms. Dependencies
remain subject to their own licenses.
