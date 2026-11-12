# Current LLM context contract

The existing contract and non-goals are carried forward, not redefined by the
extraction. The full inherited specification and its implementation/measurement
record are preserved byte-for-byte in `history\llm_polymorphic.md`.
This entry point records only the standalone naming/construction changes and
the architectural guarantees needed to read that historical document correctly.

## Standalone surface

All domain types now live in namespace `LLMContextLib`.

```csharp
using var contexts = LLMContextFactory.Create(options).Initialize(sessions);
```

The result is one `ILLMContextPolymorphicArray`, directly inheriting `IDisposable`
and declaring `TryFind(Guid, out LLMSessionContext)`. It no longer inherits the
generic `IPolymorphicArray`. Its remaining public operations are unchanged:
`CreateSession`, `RemoveSession`, `Apply`, `ApplyMemory`, `OpenRead`, `OpenView<T>`,
and `GetStatistics`.

`ILLMContextReadLease`, `ILLMContextViewDefinition<T>`, `ILLMContextView<T>`, and
`IContextMutationResult` retain their existing semantics and names.
There is no public bridge/storage constructor, writable backing array, generic
engine, or overlay to initialize alongside the client.

The optional `sessionIdSelector` factory argument preserves the former identity
validation path: its result must equal each session's canonical `SessionId`.
Ordinary Guid equality is fixed; generic equality/overlay configuration is absent.
Options are validated at factory creation. Invalid/duplicate initial sessions
fail initialization and dispose the partially constructed owner.

## Ownership and publication

```text
Application -> ILLMContextPolymorphicArray
                    |
           internal owning bridge
                    |
          internal ILLMContextStorage
                    |
          SegmentedContextStorage
```

Immutable session roots publish ordered segments, entry locations, anchors, and
search indexes together. IDs remain stable across edits; deleted identities cannot
be reused. Expected-revision checks prevent stale updates without automatic retry.
Memory-catalog changes have their own revision/publication boundary.

Read leases capture a session root and a memory root independently. They are
coherent for those captured revisions, not a cross-catalog transaction. Captured
reads and retained views remain valid after writes, removal, and owner disposal.
Readers do not take a session writer lock. Per-session writers, owner-wide
resource admission, and memory publication use distinct gates.

Limits govern conservative estimated active/retained/view resources. They do not
bound every escaped immutable graph, caller-owned result array, or actual process
heap byte. Estimator callbacks must be stable/non-reentrant; synchronous admission
does not accept cancellation tokens.

## Scope and non-goals

Supported scope remains session lifecycle and atomic change sets; immutable
segmented histories; timeline/model/navigation/search/applicable-memory views;
stable contextual anchors; explicit user/repository/session/combined memory
scopes; and revisioned reads with retention admission.

This is not a model runtime, model KV cache, exactly-once tool-execution system,
or initial persistence/distributed storage implementation. Scoped memory conditions
describe applicability, not authorization grants.

## Reading the inherited design

In `history\llm_polymorphic.md`, sections 1-12 describe the domain contract;
13-15 describe implementation, complexity, and verification; 16-20 retain the
experiments, architectural decisions, and known limitations.

References there to `ScalablePolymorphicArray.Llm`, the generic base/factory,
old project paths, commands, and artifacts describe the original repository.
Apply the mapping in `extraction.md` for current code. Do not reinterpret old
benchmark numbers as measurements of this extracted repository.
