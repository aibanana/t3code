# Effect Through T3 Code — Editorial Notes

## The Arc

T3 Code is a web GUI that orchestrates AI code agents. The server is built entirely on Effect-TS. The architecture and the library teach each other — each chapter uses a real problem from T3 Code to motivate the next Effect concept, and understanding that concept makes the architecture feel inevitable.

**The reader's journey:**
1. "Oh, computations are values" → the core mental model shift
2. "Oh, errors are part of the type" → the safety payoff
3. "Oh, services are declared, not passed" → the structural elegance
4. "Oh, types cross system boundaries" → the contract system
5. "Oh, streams are lazy and composable" → the reactive insight
6. "Oh, testing is just providing different values" → the payoff of all the above

## Audience

Experienced developer with physics/math background. Never seen Effect. Gets bored from reading docs or reference-style listings. Likes engaging challenges. Thinks in terms of symmetries, invariants, conservation laws. Wants to understand *why* things are shaped the way they are, not just *how* to use them.

## Voice

Feynman teaching physics to Caltech freshmen. Start from a situation ("you want to send a turn to an AI agent — what needs to happen?"), let the abstraction emerge as the only sane explanation. Be opinionated. Point at subtle second-order consequences. Every sentence should be load-bearing.

No filler, no "in this chapter we will learn about." Just start.

## Chapter Plan

### Chapter 1: Computation as a Value (~2500 words)

**The problem:** You're building a server that orchestrates AI agents. An agent turn involves: resolving which adapter to use, starting a session, sending input, consuming an event stream, updating a read model, notifying clients. Each step can fail differently. Each step needs services that aren't available at call site.

**The concept:** Effect.gen turns imperative async sequences into composable values. `yield*` is like `await` but it also accesses services from the environment. The return value of Effect.gen is not the result — it's a *description* of a computation that, when run, will produce a result.

**Code to feature:**
- OrchestrationEngine's `processEnvelope` — the command processing loop
- ProviderService's `startSession` — nested Effect.gen, service access
- Simple pipe chains from EventStore (mapError, flatMap)
- The "async/await vs Effect.gen" comparison (but not as a table — as a narrative)

**Key insight:** A computation that hasn't run yet can be composed, transformed, retried, and handed to someone else. An awaited promise is gone — you only have its result. This is the difference between describing a physics experiment and having already run it.

**Don't:**
- Don't exhaustively list all Effect operators
- Don't start with "Effect is a library for..."
- Don't compare to Haskell IO monad (the reader hasn't seen Haskell)

---

### Chapter 2: Errors That Mean Something (~2000 words)

**The problem:** The orchestration engine dispatches commands. A command can fail because: the JSON is malformed, the schema doesn't match, an invariant is violated, the database write fails, or the projector can't decode an event. In try/catch land, these are all `catch(e)` with `e: unknown`. You log and pray.

**The concept:** Tagged errors. Schema.TaggedErrorClass gives each error a name, structured fields, and a message. The error channel in `Effect.Effect<A, E>` makes failures visible in the type signature. `catchTag` lets you pattern match on specific errors.

**Code to feature:**
- The error hierarchy in `orchestration/Errors.ts` and `provider/Errors.ts`
- OrchestrationEngine's `processEnvelope` — the full error recovery flow:
  - Transaction fails → catchTag("SqlError") → reconcile read model
  - Invariant fails → record rejection receipt
  - Catch-all → reconcile + Deferred.fail
- How error types compose into unions (ProviderServiceError, OrchestrationDispatchError)

**Key insight:** In physics, you specify the state space — including the failure states. "The system can be in states A, B, or Error-X, Error-Y." Effect does this for computations. The error channel IS your failure state space, and the compiler checks you handle it.

**Don't:**
- Don't list every error class
- Don't make it feel like Java checked exceptions (explain why this is different — composition, not declaration)

---

### Chapter 3: The Dependency Graph (~3000 words)

**The problem:** The orchestration engine needs an event store. The event store needs SQLite. The provider service needs adapters, a session directory, and analytics. The adapters need config, loggers, and external process spawners. How do you wire 30+ services together without going insane?

**The concept:** Services and Layers. A Service is an interface + a tag. A Layer is a recipe that, given its dependencies, produces a service. Layer composition (provide, provideMerge, mergeAll) builds a dependency graph. The runtime resolves it.

**Code to feature:**
- A simple service: OrchestrationEventStore (interface + ServiceMap.Service)
- Its layer: OrchestrationEventStoreLive (Effect.gen that yields SqlClient)
- The progression: one service → composed layers → serverLayers.ts full graph
- makeServerProviderLayer: dynamic layer composition (yield* ServerConfig inside Layer.unwrap)
- The Layer.provide vs Layer.provideMerge distinction (in practice, not in theory)

**Key insight:** This is a constraint satisfaction problem. Each layer declares "I provide X, I require Y." The compiler verifies the graph is complete before you run anything. It's like specifying a Hamiltonian — you declare the system's structure, and the runtime evolves it.

**Don't:**
- Don't try to show the entire layer graph (it's 30+ nodes — pick 3-4 representative paths)
- Don't explain Context.Tag (T3 Code doesn't use it)
- Don't explain Layer algebra formally — show it through composition

---

### Chapter 4: Types That Cross Boundaries (~2500 words)

**The problem:** The server and client communicate over WebSocket. The server has 29+ RPC methods, 15+ event types, 20+ command types. Each has a specific payload shape. A renamed field or added enum value silently breaks the other side. You need types that are validated at the boundary and trusted inside.

**The concept:** Effect Schema. Define a schema once, get: TypeScript type, runtime decoder, encoder, branded nominal types. Schema.Struct for shapes, Schema.Literals for enums, Schema.Union for discriminated unions. Decode at system boundaries. Trust the type inside.

**Code to feature:**
- Branded IDs: makeEntityId factory → ThreadId, ProjectId (same string, different type)
- The WebSocket protocol: tagRequestBody + Schema.Union for method dispatch
- ProviderRuntimeEvent union: 15+ event types discriminated by `type` field
- Decode in practice: the WS transport decodes incoming messages, rejects invalid ones
- TurnCountRange: cross-field validation (fromTurnCount <= toTurnCount)
- Schema.withDecodingDefault: backward compatibility for evolving schemas

**Key insight:** Schema is one system replacing three: validation (Zod), nominal types (branded types), and serialization. The schema IS the contract. When you read a test that decodes a turn.plan.updated event, you're reading documentation, a contract test, and a type definition simultaneously.

**Don't:**
- Don't list all schema operators
- Don't compare to Zod feature-by-feature
- Don't show every branded ID type

---

### Chapter 5: How Information Flows (~3000 words)

**The problem:** A Codex process emits events through an EventEmitter callback. A Claude Code SDK emits events through an async iterator. Both need to feed into the same orchestration pipeline. Multiple consumers (projector, checkpoint reactor, WebSocket push) need to independently receive every event. And you need to test all of this without timing-dependent sleeps.

**The concept:** Queue bridges imperative callbacks to Effect. Stream.fromQueue creates lazy consumers. PubSub fans out to multiple independent subscribers. Effect.forkScoped runs background fibers with automatic cleanup.

**Code to feature:**
- CodexAdapter: EventEmitter → Queue.offerAll → Stream.fromQueue
- ProviderService: multiple adapter streams → merged queue → worker loop → PubSub.publish → Stream.fromPubSub (the getter pattern for fresh subscriptions)
- The full event pipeline diagram (adapter → service → ingestion → engine → reactor → WS push)
- Effect.forever(Queue.take(q).pipe(Effect.flatMap(process))) — the canonical worker loop
- DrainableWorker: deterministic testing without sleeps (the Deferred trick)
- Effect.forkScoped + automatic cleanup vs manual unsubscribe

**Key insight:** Everything is pull-based. Nothing flows until someone asks. A stream isn't "running" — it's a description of how to get events when you need them. This is lazy evaluation applied to async I/O. Queue and PubSub are the coordination points where push meets pull.

**Don't:**
- Don't compare to RxJS operator-by-operator
- Don't explain backpressure abstractly (show it through Queue.take blocking)
- Don't enumerate all Stream operators

---

### Chapter 6: Testing and the Real World (~2500 words)

**The problem:** You want to test the orchestration engine. It needs SQLite, an event store, a projection pipeline, and a command receipt repository. You want to test the provider service. It needs adapters that talk to external processes. You want to test the full event pipeline. How do you test all of this fast, deterministically, and without native module crashes?

**The concept:** Because everything is a value (services, layers, computations), testing is providing different values. Layer.succeed swaps a service. SqlitePersistenceMemory gives you a real database in memory. TestProviderAdapterHarness scripts provider responses. ManagedRuntime creates a test environment with full lifecycle.

Also: how the runtime bridges to the non-Effect world. NodeRuntime.runMain for process bootstrap. Effect.runPromise for WebSocket callbacks. Effect.callback for Node.js callbacks. Scopes and finalizers for graceful shutdown.

**Code to feature:**
- Layer.succeed(OrchestrationEventStore, flakyStore) — injecting a fake that fails on third write
- SqlitePersistenceMemory — same migrations, zero disk
- TestProviderAdapterHarness — queue-based response scripting, introspection methods
- makeIntegrationFixture — mixing real layers with fake adapters
- The WS server bridge: Effect.runPromise inside ws.on("message")
- Effect.acquireRelease for resource lifecycle (TerminalManagerRuntime)
- @effect/vitest's it.effect and it.layer

**Key insight:** The testing story isn't a separate feature — it's the natural consequence of the architecture. When dependencies are explicit in types and swappable through layers, testing is just "give different layers." This is the payoff of all five preceding chapters.

**Don't:**
- Don't make it feel like a testing tutorial
- Don't exhaustively cover @effect/vitest API
- Don't re-explain concepts from earlier chapters (reference them)

---

## Cross-Chapter Notes

**Running example:** Use the "user sends a turn" flow as a recurring thread. Chapter 1 introduces the command processing. Chapter 2 shows its error handling. Chapter 3 shows how it gets its dependencies. Chapter 4 shows how the command is validated. Chapter 5 shows how the response events flow. Chapter 6 shows how to test it.

**Code snippets:** Curated, not copied. 5-15 lines per snippet. Inline comments for anything non-obvious. `// ...` for elided code. Show the PURPOSE lines, not the first N lines.

**Links:** Use `[file.ts:123](/apps/server/src/path/to/file.ts#L123)` format. Links go BEFORE code blocks.

**Tone:** Dense. Every sentence load-bearing. No transitions like "now let's look at" — just start the next thing. Occasional dry humor is fine if it serves understanding.
