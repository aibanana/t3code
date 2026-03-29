# Testing and the Real World

Everything in this book so far has been pure description. Computations that haven't happened yet. Errors encoded in types. Services declared as interfaces, wired through layers. Schemas that parse or fail. Streams that produce events forever. All of it: values describing work, never performing it.

Now we make it real. Two problems remain.

First, testing. The orchestration engine needs SQLite, an event store, a projection pipeline, command receipts. The provider service needs adapters that talk to external processes over JSON-RPC. You want to test all of this fast, deterministically, without spinning up real databases on disk or real Codex subprocesses. Second, the real world. Your pure Effect computations need to run inside a WebSocket callback, an HTTP handler, a Node.js process with signal handling. How does the pure world meet the impure world?

The answer to both is the same. Because everything is a value -- because dependencies are explicit in types and swappable through layers -- testing is just "provide different layers," and running is just "hand the value to a runtime."

## Swapping a service with a fake

Recall from Chapter 3: a service is a tag plus a shape. Any value that satisfies the shape can be provided. You don't need a mocking library. You don't need to patch module internals. You build a different implementation of the same contract and hand it to `Layer.succeed`.

Here's a test that verifies the orchestration engine keeps processing commands after a storage failure. The event store is replaced with a hand-built fake that fails on a specific command, then succeeds on everything after.

[OrchestrationEngine.test.ts:293-328](/apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts#L293)

```ts
const flakyStore: OrchestrationEventStoreShape = {
  append(event) {
    if (shouldFailFirstAppend && event.commandId === CommandId.makeUnsafe("cmd-flaky-1")) {
      shouldFailFirstAppend = false;
      return Effect.fail(
        new PersistenceSqlError({ operation: "test.append", detail: "append failed" }),
      );
    }
    const savedEvent = { ...event, sequence: nextSequence } as StoredEvent;
    nextSequence += 1;
    events.push(savedEvent);
    return Effect.succeed(savedEvent);
  },
  readFromSequence(seq) {
    return Stream.fromIterable(events.filter((e) => e.sequence > seq));
  },
  readAll() {
    return Stream.fromIterable(events);
  },
};

const runtime = ManagedRuntime.make(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),  // swap here
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
  ),
);
```

`Layer.succeed(OrchestrationEventStore, flakyStore)` -- that's the entire trick. The engine was built against the `OrchestrationEventStore` tag. It doesn't know or care whether it's talking to SQLite or an in-memory array. The type system enforces the contract; the layer system lets you swap the implementation.

This is different from mocking. A mock patches an existing implementation at runtime, leaving the real dependency in the import graph. Here, the real implementation was never constructed. The fake is a first-class value that satisfies the same typed interface. There's nothing to undo, nothing to restore, no global state mutated.

## Same schema, zero disk

The persistence layer in T3 Code uses SQLite with WAL mode and a migration pipeline. For tests, you want the exact same schema -- same migrations, same PRAGMA setup -- but no file on disk.

[Sqlite.ts:47-50](/apps/server/src/persistence/Layers/Sqlite.ts#L47)

```ts
export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,                                         // PRAGMA + migrations
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);
```

That's it. `":memory:"` is SQLite's in-memory mode. The `setup` layer runs `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, and every migration -- identical to production. You get a fully migrated database that lives and dies with the test process.

In the test, using it is one line:

```ts
Layer.provide(SqlitePersistenceMemory),
```

No temp directories to clean up. No test-specific migration logic. The same layer composition from Chapter 3, pointed at a different target.

## Scripted async protocol testing

The provider adapter talks to external processes -- Codex over JSON-RPC stdio, Claude Code over the agent SDK. You can't run those in CI. You need a fake that lets you script responses and inspect what was called.

The `TestProviderAdapterHarness` is a queue-based fake. You create it, queue up the responses you want, and the adapter plays them back when `sendTurn` is called.

[TestProviderAdapter.integration.ts:224-240](/apps/server/integration/TestProviderAdapter.integration.ts#L224)

```ts
export const makeTestProviderAdapterHarness = (options?) =>
  Effect.gen(function* () {
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    let sessionCount = 0;
    const sessions = new Map<ThreadId, SessionState>();

    // ... adapter methods that read from queued responses ...

    return {
      adapter,                       // satisfies ProviderAdapterShape
      queueTurnResponse,             // script what the next sendTurn returns
      queueTurnResponseForNextSession,
      getStartCount,                 // how many sessions were started?
      getRollbackCalls,              // which rollbacks were requested?
      getInterruptCalls,             // which interrupts were sent?
      getApprovalResponses,          // what approval decisions were made?
    } satisfies TestProviderAdapterHarness;
  });
```

The adapter implements the full `ProviderAdapterShape` contract. When `sendTurn` is called, it shifts the next response off the queue, emits each event through the runtime event queue (the same `Stream.fromQueue` pattern from Chapter 5), and records the turn. When nothing is queued, it fails with a validation error -- so you know immediately if a test made an unexpected call.

The introspection methods -- `getStartCount()`, `getInterruptCalls()`, `getApprovalResponses()` -- let you assert on what the system *did*, not just what it returned. This is the testing equivalent of a physicist's detector: you don't just observe the output, you observe the interactions.

## Integration fixtures: real wiring, fake boundaries

This is the payoff. An integration test that uses the real `ProviderService`, the real `ProviderSessionDirectory`, real persistence -- but fake boundaries at the edges where external processes would be.

[providerService.integration.test.ts:44-73](/apps/server/integration/providerService.integration.test.ts#L44)

```ts
const makeIntegrationFixture = Effect.gen(function* () {
  const cwd = yield* makeWorkspaceDirectory;
  const harness = yield* makeTestProviderAdapterHarness();

  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (provider) =>
      provider === "codex"
        ? Effect.succeed(harness.adapter)
        : Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () => Effect.succeed(["codex"]),
  };

  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );

  const shared = Layer.mergeAll(
    directoryLayer,
    Layer.succeed(ProviderAdapterRegistry, registry),
    AnalyticsService.layerTest,
  ).pipe(Layer.provide(SqlitePersistenceMemory));

  const layer = makeProviderServiceLive().pipe(Layer.provide(shared));

  return { cwd, harness, layer } satisfies IntegrationFixture;
});
```

Read this carefully. The `ProviderSessionDirectory` is real -- it manages session state, persists to the in-memory SQLite. The `ProviderService` is real -- it handles turn lifecycle, approval routing, interruption. But the `ProviderAdapterRegistry` is fake: it routes `"codex"` to the test harness and rejects everything else. The analytics service is a test stub that discards events.

This is what the layer architecture from Chapter 3 was always building toward. You didn't design services and layers because it was aesthetically nice. You designed them because at this moment, in this test, you can run the real orchestration pipeline end-to-end with scripted external behavior. The test exercises real code paths -- real session creation, real event streaming, real persistence -- while controlling exactly what the "outside world" does.

## @effect/vitest and ManagedRuntime

Two pieces of test infrastructure tie it together.

`@effect/vitest` provides `it.effect` for running Effect-returning test cases and `it.layer` for sharing a layer across a test suite.

[GitService.test.ts:9-11](/apps/server/src/git/Layers/GitService.test.ts#L9)

```ts
const layer = it.layer(Layer.provideMerge(GitServiceLive, NodeServices.layer));

layer("GitServiceLive", (it) => {
  it.effect("runGit executes successful git commands", () =>
    Effect.gen(function* () {
      const gitService = yield* GitService;
      const result = yield* gitService.execute({ /* ... */ });
      assert.equal(result.code, 0);
    }),
  );
});
```

The layer is constructed once for the suite, then each `it.effect` test runs against it. Services are available through `yield*`. No manual setup/teardown.

For more complex scenarios, `ManagedRuntime` gives you explicit control over the lifecycle.

[OrchestrationEngine.test.ts:37-53](/apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts#L37)

```ts
async function createOrchestrationSystem() {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}
```

`ManagedRuntime.make` constructs the full layer graph -- SQLite database, migrations, projection pipeline, everything. `runtime.runPromise` executes effects within that context. `runtime.dispose()` tears it all down: closes database connections, releases scoped resources, runs finalizers. Every test creates its own universe and destroys it when done.

## The WebSocket bridge

Now the second problem. Your Effect computations are pure descriptions. A WebSocket callback is `ws.on("message", (raw) => { ... })`. How do they meet?

[wsServer.ts:977-978](/apps/server/src/wsServer.ts#L977)

```ts
ws.on("message", (raw) => {
  void runPromise(handleMessage(ws, raw).pipe(Effect.ignoreCause({ log: true })));
});
```

`runPromise` is the bridge. It takes an Effect value and executes it, returning a Promise. The `void` discards the Promise -- the WebSocket callback is fire-and-forget. `Effect.ignoreCause({ log: true })` converts any failure into a logged warning rather than an unhandled rejection. The `handleMessage` function is pure Effect all the way down: decode the request, route it, encode the response, send it back.

The `runPromise` used here isn't the global one. It's built from the server's runtime services:

```ts
const runtimeServices = yield* Effect.services<
  ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
>();
const runPromise = Effect.runPromiseWith(runtimeServices);
```

This captures the full service context -- database, orchestration engine, terminal manager, git, everything -- and hands it to every effect that runs inside a callback. The callback world gets a single function; the Effect world gets its full dependency graph.

For wrapping Node.js callback-style APIs themselves, there's `Effect.callback`:

[wsServer.ts:580-592](/apps/server/src/wsServer.ts#L580)

```ts
const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
  wss.close((error) => {
    if (error && !isServerNotRunningError(error)) {
      resume(Effect.fail(new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error })));
    } else {
      resume(Effect.void);
    }
  });
});
```

`Effect.callback` converts a callback-based API into an Effect. Call `resume` with either `Effect.fail(...)` or `Effect.void` to complete it. The result is a regular Effect value that can be composed, retried, or used in a finalizer -- which is exactly what happens here.

## Resource lifecycle and graceful shutdown

In the real world, resources need cleanup. Database connections close. Child processes terminate. WebSocket connections drop. If your process crashes, you want cleanup to still happen.

`Effect.acquireRelease` pairs creation with destruction, guaranteed.

[Manager.ts:1180-1183](/apps/server/src/terminal/Layers/Manager.ts#L1180)

```ts
const runtime = yield* Effect.acquireRelease(
  Effect.sync(() => new TerminalManagerRuntime({ logsDir, ptyAdapter })),  // acquire
  (r) => Effect.sync(() => r.dispose()),                                   // release
);
```

The acquire effect creates the terminal runtime. The release effect disposes it. The release runs when the enclosing scope closes -- whether that's normal shutdown, an error, or a signal interrupt. You don't write cleanup logic in a `finally` block. You don't track whether the resource was created. The runtime handles it.

For services that manage collections of child resources, `Effect.addFinalizer` registers cleanup on the current scope:

[ProviderService.ts:524-528](/apps/server/src/provider/Layers/ProviderService.ts#L524)

```ts
yield* Effect.addFinalizer(() =>
  Effect.catch(runStopAll(), (cause) =>
    Effect.logWarning("failed to stop provider service", { cause }),
  ),
);
```

When the provider service's scope closes, `runStopAll()` stops every active provider session. The `Effect.catch` ensures that a cleanup failure doesn't mask the original error. This runs whether the server shuts down gracefully or gets SIGTERM'd.

## Process bootstrap

One line starts the whole thing.

[index.ts:23](/apps/server/src/index.ts#L23)

```ts
Command.run(t3Cli, { version }).pipe(Effect.provide(RuntimeLayer), NodeRuntime.runMain);
```

`NodeRuntime.runMain` is the entry point for a Node.js process. It executes the Effect, handles process signals (SIGINT, SIGTERM), and ensures all finalizers run on shutdown. The `RuntimeLayer` is the full production dependency graph -- every service, every adapter, every database connection. One function call. The pure world becomes the real world.

## The architecture is the test strategy

Here's what I want you to see. The testing story isn't a separate feature bolted on after the architecture was designed. It's the natural consequence of every decision in this book.

Chapter 1: computations are values. That means you can construct a computation, inspect it, provide it with different contexts, and run it in different ways. A test and a production server both do the same thing: provide context, then run.

Chapter 3: services are interfaces, layers are providers. That means any service can be replaced with a fake that satisfies the same contract. No patching, no monkey-patching, no dependency injection framework. `Layer.succeed(Tag, fakeValue)` -- done.

Chapter 4: schemas validate at boundaries. That means your fakes don't need to duplicate validation logic. The schema layer catches invalid data before it reaches your code, whether that code is real or fake.

Chapter 5: streams and queues decouple producers from consumers. That means your test harness can produce scripted events through the same queue interface that a real Codex subprocess would use. The consumer doesn't know the difference.

And the real-world story is the same pattern in reverse. Because everything is a value, `runPromise` can execute any Effect inside any callback. Because cleanup is declared (not implemented in ad-hoc `finally` blocks), shutdown is automatic. Because the dependency graph is a value -- a Layer -- the process entry point is one line.

This is what it means to take "computation as a value" seriously. You don't get testability and manageability as bonuses. You get them as theorems. They follow from the axioms.
