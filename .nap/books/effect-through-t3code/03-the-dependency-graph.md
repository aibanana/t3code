# The Dependency Graph

The orchestration engine just said `yield* OrchestrationEventStore`. Where does the event store come from?

In Chapters 1 and 2, you learned that `yield*` inside `Effect.gen` suspends a computation until its value is available, and that errors travel through the type. But we glossed over something. When you write:

```ts
const store = yield* OrchestrationEventStore;
```

you are not calling a function. You are not importing a singleton. You are asking the runtime: "I need an `OrchestrationEventStore`. Find one." The runtime looks at a structure called the *environment* -- a typed map from service tags to implementations -- and either finds it or refuses to compile. That lookup, and the machinery that builds the map, is the subject of this chapter.

The T3 Code server wires together 30+ services: event stores, projection pipelines, provider adapters, terminal managers, git integrations, analytics, checkpoint reactors. Each one depends on others. This chapter shows how the codebase declares those dependencies and lets the compiler verify that every wire is connected.

---

## A service is an interface plus a name

Here is the event store service, in its entirety as a service declaration:

**`OrchestrationEventStore`:** [OrchestrationEventStore.ts:21-70](/apps/server/src/persistence/Services/OrchestrationEventStore.ts#L21)

```ts
export interface OrchestrationEventStoreShape {
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  readonly readAll: () => Stream.Stream<
    OrchestrationEvent,
    OrchestrationEventStoreError
  >;
}

export class OrchestrationEventStore extends ServiceMap.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("t3/persistence/Services/OrchestrationEventStore") {}
```

Two things happen here. The interface `OrchestrationEventStoreShape` describes *what the service does* -- append events, read them back. Every method returns an `Effect` or a `Stream`, which means every method is a computation-as-value (Chapter 1) carrying typed errors (Chapter 2).

The class `OrchestrationEventStore` is the tag. Think of it as a key in a typed dictionary. The `ServiceMap.Service` base class links the key to the shape with a string identifier `"t3/persistence/Services/OrchestrationEventStore"` that must be globally unique. That string is for debugging -- the type system does the actual dispatch.

When you write `yield* OrchestrationEventStore` inside an `Effect.gen`, the compiler infers that your effect *requires* `OrchestrationEventStore` in its environment. It becomes part of the type signature: `Effect<SomeResult, SomeError, OrchestrationEventStore>`. That third type parameter is the bill of materials. The program won't run until every item on the bill is supplied.

Here is another service tag, for the provider adapter registry:

**`ProviderAdapterRegistry`:** [ProviderAdapterRegistry.ts:37-40](/apps/server/src/provider/Services/ProviderAdapterRegistry.ts#L37)

```ts
export class ProviderAdapterRegistry extends ServiceMap.Service<
  ProviderAdapterRegistry,
  ProviderAdapterRegistryShape
>()("t3/provider/Services/ProviderAdapterRegistry") {}
```

Same pattern. Interface describes behavior, class provides the tag. Every service in T3 Code follows this convention.

---

## A layer is a recipe

You have a tag. You need an implementation. A `Layer` is the recipe that produces one.

Here is how the event store gets built:

**`OrchestrationEventStoreLive`:** [OrchestrationEventStore.ts:96-267](/apps/server/src/persistence/Layers/OrchestrationEventStore.ts#L96)

```ts
const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;        // dependency: I need SQL

  const appendEventRow = SqlSchema.findOne({      // wire up a prepared query
    Request: AppendEventRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) => sql`
      INSERT INTO orchestration_events (...)
      VALUES (...)
      RETURNING sequence, event_id AS "eventId", ...
    `,
  });

  // ... readEventRowsFromSequence similarly ...

  const append: OrchestrationEventStoreShape["append"] = (event) =>
    appendEventRow({ /* ... */ }).pipe(
      Effect.mapError(/* ... */),                 // tagged errors from Ch. 2
      Effect.flatMap((row) => decodeEvent(row).pipe(/* ... */)),
    );

  // ... readFromSequence, readAll ...

  return {
    append,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
  } satisfies OrchestrationEventStoreShape;       // compiler checks the shape
});

export const OrchestrationEventStoreLive = Layer.effect(
  OrchestrationEventStore,  // what I provide
  makeEventStore,           // how I build it
);
```

Read this from the bottom up. `Layer.effect(Tag, effect)` says: "To produce `OrchestrationEventStore`, run this effect." The effect is an `Effect.gen` that:

1. **Yields its dependencies.** `yield* SqlClient.SqlClient` says "I need a SQL client." The layer's input type now includes `SqlClient`.
2. **Builds internal machinery.** The prepared queries, the pagination logic, the error mapping -- all local to this factory function.
3. **Returns the shape.** The `satisfies OrchestrationEventStoreShape` on line 264 is a compile-time assertion that the returned object matches the interface. If you forget a method, the compiler catches it here, not at some distant call site.

The layer is a function from dependencies to service. In physics terms: it's a constructor that declares its own prerequisites. `SqlClient -> OrchestrationEventStore`. The type system tracks this arrow.

---

## Specializing adapters

Before wiring layers together, notice how T3 Code handles the fact that different providers (Codex, Claude Code) share the same interface but have different implementations.

**`ProviderAdapterShape`:** [ProviderAdapter.ts:45-50](/apps/server/src/provider/Services/ProviderAdapter.ts#L45)

```ts
export interface ProviderAdapterShape<TError> {
  readonly provider: ProviderKind;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly startSession: (input: ProviderSessionStartInput) =>
    Effect.Effect<ProviderSession, TError>;
  readonly sendTurn: (input: ProviderSendTurnInput) =>
    Effect.Effect<ProviderTurnStartResult, TError>;
  // ... interruptTurn, respondToRequest, stopSession, etc.
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
```

This is the generic adapter contract -- parameterized by error type `TError`. Each concrete provider narrows it:

**`CodexAdapter`:** [CodexAdapter.ts:21-30](/apps/server/src/provider/Services/CodexAdapter.ts#L21)

```ts
export interface CodexAdapterShape
  extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "codex";   // literal type narrows the kind
}

export class CodexAdapter extends ServiceMap.Service<
  CodexAdapter,
  CodexAdapterShape
>()("t3/provider/Services/CodexAdapter") {}
```

The pattern: generic interface for the contract, specialized interface + tag for each implementation. The registry layer (below) yields all adapter tags and stores them in a map. This is how the server routes a session request for `"codex"` to the Codex adapter and `"claude-code"` to the Claude Code adapter, without conditionals in the routing logic.

---

## Layers compose

You have individual layers: one produces an event store (needs SQL), one produces a registry (needs adapters), one produces a session directory (needs a persistence repository). Now you need to wire them into a graph. Effect gives you three composition operators. All of them are used in `serverLayers.ts`.

### `Layer.provide` -- "A needs B"

**`serverLayers.ts`:** [serverLayers.ts:56-58](/apps/server/src/serverLayers.ts#L56)

```ts
const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);
```

`ProviderSessionDirectoryLive` requires `ProviderSessionRuntimeRepository` in its environment. `Layer.provide(ProviderSessionRuntimeRepositoryLive)` satisfies that requirement. After this line, `providerSessionDirectoryLayer` still requires whatever `ProviderSessionRuntimeRepositoryLive` needs (the SQL client), but no longer requires the repository itself. One edge in the dependency graph, resolved.

### `Layer.provideMerge` -- "satisfy + re-export"

**`serverLayers.ts`:** [serverLayers.ts:65-69](/apps/server/src/serverLayers.ts#L65)

```ts
const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
  Layer.provide(codexAdapterLayer),
  Layer.provide(claudeCodeAdapterLayer),
  Layer.provideMerge(providerSessionDirectoryLayer),
);
```

`Layer.provide` satisfies a dependency and hides it. `Layer.provideMerge` satisfies the dependency *and* keeps it visible in the output. Why? Because `providerSessionDirectoryLayer` is needed by both the registry and the provider service. `provideMerge` says "feed this into the registry, but also pass it through so downstream layers can use it too."

The distinction matters. `provide` is private wiring -- "the registry uses the directory internally." `provideMerge` is public wiring -- "the registry uses the directory, and so will whoever consumes this combined layer."

### `Layer.mergeAll` -- "independent services, combined"

**`serverLayers.ts`:** [serverLayers.ts:91-97](/apps/server/src/serverLayers.ts#L91)

```ts
const runtimeServicesLayer = Layer.mergeAll(
  orchestrationLayer,
  OrchestrationProjectionSnapshotQueryLive,
  CheckpointStoreLive,
  checkpointDiffQueryLayer,
  RuntimeReceiptBusLive,
);
```

These five layers don't depend on each other. `mergeAll` combines them into one layer that provides all five services. It's a parallel composition -- the runtime can initialize them in any order (or concurrently). Think of it as the direct sum of independent subsystems.

### Building up: the orchestration stack

Here is how the orchestration engine gets its dependencies:

**`serverLayers.ts`:** [serverLayers.ts:80-84](/apps/server/src/serverLayers.ts#L80)

```ts
const orchestrationLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
);
```

The orchestration engine needs three things: a projection pipeline, an event store, and a command receipt repository. Each is provided. The event store in turn needs `SqlClient`. The pipeline needs its own dependencies. But at this level of composition, you don't care -- each `Layer.provide` resolves one edge, and the remaining requirements propagate upward automatically. The type system keeps the books.

Here is the full runtime assembly:

**`serverLayers.ts`:** [serverLayers.ts:129-136](/apps/server/src/serverLayers.ts#L129)

```ts
return Layer.mergeAll(
  orchestrationReactorLayer,
  gitCoreLayer,
  gitManagerLayer,
  terminalLayer,
  KeybindingsLive,
).pipe(Layer.provideMerge(NodeServices.layer));
```

Five top-level subsystems merged, with Node platform services (`FileSystem`, `Path`, etc.) provided to all of them via `provideMerge`. The result is a single `Layer` that, given `SqlClient` + `ServerConfig` + `AnalyticsService` + `ProviderService`, produces *every runtime service the server needs*.

---

## The complex case: a layer that does real work

Most layers are simple factories -- yield dependencies, return methods. But sometimes a layer needs to set up infrastructure that lives for the lifetime of the application. The `ProviderService` layer is the canonical example.

**`makeProviderService`:** [ProviderService.ts:125-547](/apps/server/src/provider/Layers/ProviderService.ts#L125)

```ts
const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    // 1. Yield dependencies
    const analytics = yield* Effect.service(AnalyticsService);
    const registry = yield* ProviderAdapterRegistry;
    const directory = yield* ProviderSessionDirectory;

    // 2. Create infrastructure
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    // 3. Fork background workers
    const worker = Effect.forever(
      Queue.take(runtimeEventQueue).pipe(
        Effect.flatMap(processRuntimeEvent),
      ),
    );
    yield* Effect.forkScoped(worker);

    // 4. Wire adapter event streams into the queue
    yield* Effect.forEach(adapters, (adapter) =>
      Stream.runForEach(adapter.streamEvents, (event) =>
        Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
      ).pipe(Effect.forkScoped),
    ).pipe(Effect.asVoid);

    // 5. Register cleanup
    yield* Effect.addFinalizer(() =>
      Effect.catch(runStopAll(), (cause) =>
        Effect.logWarning("failed to stop provider service", { cause }),
      ),
    );

    // 6. Return the service shape
    return { startSession, sendTurn, /* ... */ } satisfies ProviderServiceShape;
  });
```

Six things happen in one `Effect.gen`:

1. **Service access.** Three `yield*` calls declare the dependencies: analytics, the adapter registry, and the session directory.
2. **Infrastructure creation.** An unbounded `Queue` for serializing runtime events, and a `PubSub` for fan-out to multiple subscribers.
3. **Background work.** `Effect.forkScoped` spawns a fiber that runs *for the lifetime of the layer's scope*. The worker loops forever, taking events from the queue and processing them.
4. **Stream wiring.** Each adapter's event stream is drained into the shared queue, each in its own scoped fiber.
5. **Cleanup.** `Effect.addFinalizer` registers a shutdown hook: when the scope closes (server shutdown), stop all provider sessions. The finalizer itself is an `Effect` -- it can fail, and that failure is handled with a warning log rather than crashing.
6. **Shape return.** The methods close over the queue, pubsub, registry, and directory. The `satisfies` check ensures the returned object matches the interface.

This is a layer doing genuine setup work -- spawning fibers, allocating concurrent data structures, registering finalizers. But notice: it's still just an `Effect.gen`. All the patterns from Chapters 1 and 2 apply. The errors are typed. The dependencies are declared. The runtime manages the lifecycle.

---

## `Layer.unwrap`: when construction needs context

Sometimes the shape of the dependency graph depends on runtime information. In T3 Code, the provider layer graph depends on `ServerConfig` -- the config determines log paths, which affect how event loggers are constructed.

**`makeServerProviderLayer`:** [serverLayers.ts:41-74](/apps/server/src/serverLayers.ts#L41)

```ts
export function makeServerProviderLayer(): Layer.Layer<
  ProviderService,
  ProviderUnsupportedError,
  SqlClient.SqlClient | ServerConfig | FileSystem.FileSystem | AnalyticsService
> {
  return Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;     // read config at build time
    const providerLogsDir = path.join(stateDir, "logs", "provider");

    const nativeEventLogger = yield* makeEventNdjsonLogger(/* ... */);
    const canonicalEventLogger = yield* makeEventNdjsonLogger(/* ... */);

    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const codexAdapterLayer = makeCodexAdapterLive(/* ... */);
    const claudeCodeAdapterLayer = makeClaudeCodeAdapterLive(/* ... */);

    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeCodeAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );

    return makeProviderServiceLive(/* ... */).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerSessionDirectoryLayer),
    );
  }).pipe(Layer.unwrap);  // <-- the key
}
```

The function body is an `Effect.gen` that yields `ServerConfig`, then builds and returns a `Layer`. But `Effect.gen` produces an `Effect`, not a `Layer`. The call to `Layer.unwrap` converts `Effect<Layer<A, E, R1>, E2, R2>` into `Layer<A, E | E2, R1 | R2>`. In English: "run this effect to get a layer, and merge the requirements."

Why is this necessary? Because the layer graph itself varies based on config. The log paths, the choice of adapters, the event logger options -- these are determined at startup by reading `ServerConfig`. You can't wire these statically, because the values don't exist until the config is loaded.

`Layer.unwrap` is the escape hatch from static composition into dynamic composition. You won't need it often. When you do, it's because the graph's topology depends on runtime data.

---

## Testing: swap implementations in one line

A preview of Chapter 6, but worth seeing now because it demonstrates the payoff of this architecture.

**Integration test fixture:** [providerService.integration.test.ts:48-63](/apps/server/integration/providerService.integration.test.ts#L48)

```ts
const registry: typeof ProviderAdapterRegistry.Service = {
  getByProvider: (provider) =>
    provider === "codex"
      ? Effect.succeed(harness.adapter)
      : Effect.fail(new ProviderUnsupportedError({ provider })),
  listProviders: () => Effect.succeed(["codex"]),
};

const shared = Layer.mergeAll(
  directoryLayer,
  Layer.succeed(ProviderAdapterRegistry, registry),  // fake registry
  AnalyticsService.layerTest,                         // no-op analytics
).pipe(Layer.provide(SqlitePersistenceMemory));        // in-memory SQLite
```

`Layer.succeed(ProviderAdapterRegistry, registry)` creates a layer that provides the registry tag with a hand-built object. No network. No process spawning. No config files. The `ProviderService` layer doesn't know or care -- it yields `ProviderAdapterRegistry` and gets whatever the test provides. The entire provider service, with its queues and fibers and finalizers, runs against fake adapters and in-memory storage. Same code paths, controlled inputs.

---

## The constraint satisfaction problem

Step back and look at what the type system is doing.

Each layer declaration is a constraint: "I provide X. I require Y." `OrchestrationEventStoreLive` provides `OrchestrationEventStore`, requires `SqlClient`. `ProviderServiceLive` provides `ProviderService`, requires `ProviderAdapterRegistry`, `ProviderSessionDirectory`, and `AnalyticsService`. And so on for 30+ services.

When you compose layers with `provide`, `provideMerge`, and `mergeAll`, you are solving a constraint satisfaction problem. Each `provide` eliminates one requirement. Each `mergeAll` combines independent providers. The final composed layer has a type like:

```ts
Layer<
  AllTheServicesYouNeed,
  AllTheErrorsThatCanHappen,
  TheRemainingUnsatisfiedRequirements
>
```

If that third type parameter is `never` -- no unsatisfied requirements -- the layer is self-contained and can be fed to the runtime. If it still contains requirements, the compiler tells you exactly what's missing. Not at runtime. Not in a stack trace. In a red squiggly on the line where you try to run the program.

This is like specifying a Lagrangian. You declare the structure of the system -- what each part provides, what each part needs. You don't write the wiring code that passes services around. You don't maintain a dependency injection container that resolves things at runtime with string keys. You declare constraints, and the compiler verifies they're satisfiable. The runtime then builds the graph, initializes services in dependency order, manages scopes, and runs finalizers on shutdown.

The payoff is that adding a new service -- say, a Claude Code adapter -- means writing a `ServiceMap.Service` class, implementing a `Layer.effect`, and adding one `Layer.provide` call in `serverLayers.ts`. The compiler immediately tells you if you forgot a dependency or provided the wrong shape. The existing 29 services don't change. The graph grows by one node and one edge, and the type checker re-verifies the whole thing in milliseconds.

That's the dependency graph. Declare the structure, let the machine verify it. In the next chapter, we'll look at what flows through these services: the event-sourcing pipeline that turns commands into events and events into state.
