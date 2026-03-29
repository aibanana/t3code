# Computation as a Value

A command arrives over a WebSocket. Create a thread. The server must: check whether this command was already processed (idempotency), decide what events it produces (business logic), write those events inside a transaction (persistence), update an in-memory read model (projection), and notify every connected client (pub/sub). Each step can fail in its own way. Each step needs services -- a database client, an event store, a receipt repository -- that weren't passed as arguments.

Here's what you might write first:

```ts
async function processCommand(command: Command) {
  const receipt = await receiptRepo.get(command.commandId);
  if (receipt) return receipt;

  const events = decide(command, readModel);        // can throw invariant errors
  await db.transaction(async (tx) => {
    for (const e of events) {
      await eventStore.append(tx, e);               // can throw SQL errors
      readModel = project(readModel, e);             // can throw decode errors
    }
    await receiptRepo.upsert(tx, command, events);
  });

  for (const e of events) pubsub.publish(e);
}
```

Where did `receiptRepo`, `eventStore`, `readModel`, `pubsub`, and `db` come from? They're module-level singletons, or they're threaded through four layers of function arguments, or they live on a class instance that's becoming a god object. And every error is `unknown` -- the caller has no idea whether `processCommand` might fail with a SQL timeout or a schema violation or a business rule rejection. The type signature is `Promise<void>`. Good luck.

There's a deeper problem. The moment you `await`, the computation is *gone*. You have the result (or the exception), but the description of what was supposed to happen has evaporated. You can't wrap it in a retry. You can't compose two of these into a larger unit. You can't hand it to a scheduler that decides *when* to run it. You evaluated the equation at a point and threw away the equation.

## The computation that hasn't happened yet

Here's how the same command processing actually works in T3 Code.

**`processEnvelope()`:** [OrchestrationEngine.ts:84](/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L84)

```ts
return Effect.gen(function* () {
  const existingReceipt = yield* commandReceiptRepository.getByCommandId({
    commandId: envelope.command.commandId,
  });
  if (Option.isSome(existingReceipt)) {
    // ...handle idempotency...
    return;
  }

  const eventBase = yield* decideOrchestrationCommand({
    command: envelope.command,
    readModel,
  });
  // ...transaction, projection, publishing...
});
```

`Effect.gen(function* () { ... })` does not execute anything. It returns a value -- an `Effect` -- that *describes* the computation. Think of it as writing down the recipe instead of cooking the meal. The recipe is a first-class object. You can transform it, compose it with other recipes, or hand it to someone else to execute later.

Inside the generator, `yield*` plays the role that `await` plays in async functions, but it does two things `await` cannot. First, it can pull services out of the environment -- we'll see this momentarily. Second, every `yield*` that might fail contributes its error type to the final Effect's type signature. The compiler accumulates them automatically. No `unknown` in sight.

The return type of `processEnvelope` is `Effect.Effect<void>` -- a computation that, *when run*, produces nothing on success and never requires services from outside (the closure already captured them). But the real action is in the general form: `Effect<Success, Error, Requirements>`. Three type parameters. What you produce, how you fail, what you need. This is the fundamental shape, and it's worth staring at for a moment. A regular function signature tells you inputs and outputs. This one also tells you the failure modes and the dependencies. The type *is* the specification.

## Pulling services from thin air

Scroll up to where the engine is constructed.

**`makeOrchestrationEngine`:** [OrchestrationEngine.ts:52](/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L52)

```ts
const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;

  let readModel = createEmptyReadModel(new Date().toISOString());
  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  // ...
```

The first four `yield*` statements don't await promises. They reach into the environment and pull out services. `yield* SqlClient.SqlClient` says: "I need a SQL client. Whoever runs me must provide one." The Effect runtime tracks this as a type-level requirement. If you try to run this Effect without providing an `SqlClient`, it won't compile. Not a runtime error. Not a "container not initialized" message at 3 AM. A red squiggle in your editor.

The next two `yield*` calls -- `Queue.unbounded()` and `PubSub.unbounded()` -- *do* create things. They allocate a concurrent queue and a pub/sub channel. Same syntax, different meaning. The generator doesn't care whether `yield*` resolves a dependency or performs an effectful allocation. It's all just "give me the next thing."

After pulling services and creating infrastructure, the function builds mutable state (`readModel`), forks a background worker, and returns the service shape:

**Worker fork and service return:** [OrchestrationEngine.ts:206](/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L206)

```ts
  const worker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope))
  );
  yield* Effect.forkScoped(worker);

  return {
    getReadModel,
    readEvents,
    dispatch,
    get streamDomainEvents() {
      return Stream.fromPubSub(eventPubSub);
    },
  } satisfies OrchestrationEngineShape;
});
```

`Effect.forever` takes a computation and repeats it indefinitely -- take a command from the queue, process it, take the next one. `Effect.forkScoped` runs this loop in a background fiber tied to the current scope's lifetime. When the scope closes, the fiber gets interrupted. No manual cleanup, no forgotten `clearInterval`.

The whole thing -- service resolution, state initialization, worker spawning, API surface construction -- is one `Effect.gen`. It's a single value. It hasn't run. It's a blueprint for an orchestration engine. The actual engine comes into existence when the Effect runtime interprets this blueprint, providing all the required services.

The same pattern shows up in the provider layer.

**`makeProviderService`:** [ProviderService.ts:126](/apps/server/src/provider/Layers/ProviderService.ts#L126)

```ts
const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const analytics = yield* Effect.service(AnalyticsService);
    const registry = yield* ProviderAdapterRegistry;
    const directory = yield* ProviderSessionDirectory;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    // ...wire up workers, register finalizers, return service shape...
  });
```

Three services pulled from the environment. Two concurrent data structures allocated. Workers forked. A finalizer registered (so that when the scope tears down, all provider sessions get stopped). Then the service shape is returned. Same pattern. The entire provider service is a computation that hasn't happened yet, waiting to be handed its dependencies and told to go.

## Pipe: transforming computations without running them

Inside the event store, events get appended to SQLite and decoded back into domain objects. Here's the `append` method.

**`append()`:** [OrchestrationEventStore.ts:181](/apps/server/src/persistence/Layers/OrchestrationEventStore.ts#L181)

```ts
const append: OrchestrationEventStoreShape["append"] = (event) =>
  appendEventRow({
    eventId: event.eventId,
    aggregateKind: event.aggregateKind,
    // ...
  }).pipe(
    Effect.mapError(
      toPersistenceSqlOrDecodeError(
        "OrchestrationEventStore.append:insert",
        "OrchestrationEventStore.append:decodeRow",
      ),
    ),
    Effect.flatMap((row) =>
      decodeEvent(row).pipe(
        Effect.mapError(
          toPersistenceDecodeError("OrchestrationEventStore.append:rowToEvent"),
        ),
      ),
    ),
  );
```

`.pipe()` is method chaining for Effects. It takes the Effect on the left and passes it through a series of transformations. Nothing executes. You're building a pipeline description.

`Effect.mapError` transforms the error channel. The raw `appendEventRow` might fail with a generic SQL error. `mapError` rewrites that into a domain-specific `PersistenceSqlError` with an operation label. The success value passes through untouched. It's a funnel for the error path only.

`Effect.flatMap` transforms the success channel, but the transformation itself can be effectful. Here, if `appendEventRow` succeeds, its result (a database row) gets passed into `decodeEvent(row)`, which returns a *new* Effect that might fail with a decode error. `flatMap` sequences them: run the first thing, feed its success into the second thing. If the first thing fails, the second never runs.

This is the same idea as promise chaining (`.then`), except the chain is a value you're constructing, not a series of callbacks already scheduled on the microtask queue.

For completeness, here's a `pipe` chain from the provider layer.

**`publishRuntimeEvent()`:** [ProviderService.ts:142](/apps/server/src/provider/Layers/ProviderService.ts#L142)

```ts
const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
  Effect.succeed(event).pipe(
    Effect.tap((e) =>
      canonicalEventLogger ? canonicalEventLogger.write(e, null) : Effect.void,
    ),
    Effect.flatMap((e) => PubSub.publish(runtimeEventPubSub, e)),
    Effect.asVoid,
  );
```

`Effect.succeed(event)` wraps a plain value into an Effect -- a computation that immediately succeeds with that value. `Effect.tap` runs a side effect (logging) without changing what flows downstream. `Effect.flatMap` publishes to the pub/sub. `Effect.asVoid` discards the success value, because the caller doesn't need it. Four transformations, each doing one thing. The pipeline reads top-to-bottom, like a signal flow diagram.

## The transaction: composing descriptions

Back in `processEnvelope`, the core logic runs inside a SQL transaction.

**Transaction block:** [OrchestrationEngine.ts:110](/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L110)

```ts
const committedCommand = yield* sql
  .withTransaction(
    Effect.gen(function* () {
      const committedEvents: OrchestrationEvent[] = [];
      let nextReadModel = readModel;

      for (const nextEvent of eventBases) {
        const savedEvent = yield* eventStore.append(nextEvent);
        nextReadModel = yield* projectEvent(nextReadModel, savedEvent);
        yield* projectionPipeline.projectEvent(savedEvent);
        committedEvents.push(savedEvent);
      }
      // ...upsert receipt, return result...
    }),
  )
  .pipe(
    Effect.catchTag("SqlError", (sqlError) =>
      Effect.fail(
        toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
      ),
    ),
  );
```

`sql.withTransaction(...)` takes an Effect -- a computation description -- and wraps it so that all SQL operations inside share a single transaction. If any `yield*` inside fails, the transaction rolls back. This only works because the inner block is a *value* that hasn't run yet. `withTransaction` doesn't execute it; it wraps it. The execution happens later, when the outer `Effect.gen` is itself run.

Then `.pipe(Effect.catchTag("SqlError", ...))` handles one specific error variant by its tag. If the transaction fails with a `SqlError`, it gets rewritten into a domain-specific `PersistenceSqlError`. Any other error passes through unchanged. The error channel narrows. The type system tracks this.

This is the payoff of computation-as-a-value. You built a description of "append events, project them, upsert a receipt," then handed that description to `withTransaction` which added transactional semantics, then handed *that* to `catchTag` which added error remapping. Three layers of behavior, composed by passing values through functions. No callback hell. No try/catch nesting. No runtime dependency injection framework.

## The equation and the evaluation

In physics, you often care more about the Lagrangian than about any specific trajectory. The Lagrangian is a compact description of all possible motions. You derive the equations of motion from it. You evaluate those equations for specific initial conditions only at the very end, when you need a number.

Effect works the same way. `makeOrchestrationEngine` is the Lagrangian -- a complete description of what the orchestration engine does, what it needs, and how it can fail. The `Layer.effect(OrchestrationEngineService, makeOrchestrationEngine)` call at the bottom of the file is where you bind it to a service tag. And the actual evaluation -- the moment the engine starts processing real commands -- happens at the top of the application, when `Effect.runFork` (or equivalent) interprets the entire assembled program.

This separation is what makes the architecture tractable. The orchestration engine is built from an event store, a receipt repository, a projection pipeline, and a SQL client. Each of those is itself an Effect that describes its own construction, its own dependencies, its own failure modes. You compose these descriptions into a tree. The runtime resolves the tree, provides concrete implementations, and runs the whole thing. But until that moment, you have the equation, not the evaluation. You can inspect it, test it, swap out pieces, add cross-cutting concerns.

A `Promise<void>` is a computation that's already running. An `Effect<void, OrchestrationDispatchError, OrchestrationEventStore | CommandReceiptRepository | SqlClient>` is a computation that hasn't started, with its failure modes and dependencies visible in the type. The first is a number. The second is the equation that produces the number. You want the equation.
