# Errors That Mean Something

The orchestration engine just tried to save an event to the database. The database said no.

In a typical async/await codebase, here's what happens next: the `await` throws, and the exception travels up the call stack until it hits a `try/catch` — or it doesn't, and the process crashes. If someone *did* catch it, they got `catch(e)` with `e: unknown`. Was this a schema validation failure? A business rule violation? A dead database connection? You'd have to `console.log(e)` and read the tea leaves.

This is not a theoretical problem. T3 Code's orchestration engine processes commands that can fail in at least five structurally different ways: malformed JSON, schema mismatch, invariant violation, database write failure, projector decode error. Each of these failures demands different recovery logic. Treating them all as "something went wrong" is like a physicist declaring that all states above the ground state are "excited" and leaving it at that.

## Errors as Data

Effect gives you `Schema.TaggedErrorClass` — a way to define error types that are not just strings, but structured values with a discriminant tag.

**`OrchestrationCommandJsonParseError`:** [Errors.ts:5](/apps/server/src/orchestration/Errors.ts#L5)

```ts
export class OrchestrationCommandJsonParseError
  extends Schema.TaggedErrorClass<OrchestrationCommandJsonParseError>()(
    "OrchestrationCommandJsonParseError",
    {
      detail: Schema.String,
      cause: Schema.optional(Schema.Defect),
    },
  )
{
  override get message(): string {
    return `Invalid orchestration command JSON: ${this.detail}`;
  }
}
```

What's happening: `Schema.TaggedErrorClass` creates a class that extends `Data.TaggedError`, which itself extends `Error`. The first string — `"OrchestrationCommandJsonParseError"` — becomes the `_tag` field, a literal type discriminant baked into every instance. The second argument is a `Schema.Struct` that defines the error's structured payload.

You construct it like any other value: `new OrchestrationCommandJsonParseError({ detail: "unexpected EOF" })`. No `throw`. You get back an object that knows what it is, carries context, and generates human-readable messages.

Now look at the invariant error, which carries richer context:

**`OrchestrationCommandInvariantError`:** [Errors.ts:29](/apps/server/src/orchestration/Errors.ts#L29)

```ts
export class OrchestrationCommandInvariantError
  extends Schema.TaggedErrorClass<OrchestrationCommandInvariantError>()(
    "OrchestrationCommandInvariantError",
    {
      commandType: Schema.String,
      detail: Schema.String,
      cause: Schema.optional(Schema.Defect),
    },
  )
{
  // ...
}
```

This one carries `commandType` — *which* command hit the invariant. And `detail` — *what* invariant was violated. When this error surfaces in logs or is propagated to the caller, it tells you exactly what happened without anyone needing to `JSON.stringify` random context into a message string.

The provider layer follows the same pattern. A session-not-found error carries the `provider` name and `threadId`:

**`ProviderAdapterSessionNotFoundError`:** [Errors.ts:25](/apps/server/src/provider/Errors.ts#L25)

```ts
export class ProviderAdapterSessionNotFoundError
  extends Schema.TaggedErrorClass<ProviderAdapterSessionNotFoundError>()(
    "ProviderAdapterSessionNotFoundError",
    {
      provider: Schema.String,
      threadId: Schema.String,
      // ...
    },
  ) { /* ... */ }
```

Three error classes, three different shapes, three different `_tag` values. Each one is a point in the failure state space.

## The Error Channel

Remember from Chapter 1: an `Effect.Effect<A, E, R>` is a computation-as-value. `A` is the success type, `R` is the requirements. But we skipped over `E` — the error channel. This is where failure states live.

Look at the `ProviderServiceShape` interface — the contract for provider session management:

**`ProviderServiceShape`:** [ProviderService.ts:36](/apps/server/src/provider/Services/ProviderService.ts#L36)

```ts
interface ProviderServiceShape {
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;
  // ...
}
```

Every method declares: "I produce `A` or I fail with `ProviderServiceError`." Not `unknown`. Not `Error`. A specific union type.

And what is `ProviderServiceError`?

**`ProviderServiceError`:** [Errors.ts:157](/apps/server/src/provider/Errors.ts#L157)

```ts
export type ProviderServiceError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderAdapterError        // itself a 5-member union
  | CheckpointServiceError;
```

This is a discriminated union. Every member has a unique `_tag`. The type signature is telling you: "Here is the complete list of things that can go wrong when you call this service." If a new failure mode is added — say `ProviderRateLimitError` — it gets added to the union, and the compiler flags every place that does exhaustive matching but doesn't handle it yet.

The orchestration layer has its own error union:

**`OrchestrationDispatchError`:** [Errors.ts:81](/apps/server/src/orchestration/Errors.ts#L81)

```ts
export type OrchestrationDispatchError =
  | ProjectionRepositoryError
  | OrchestrationCommandInvariantError
  | OrchestrationCommandPreviouslyRejectedError
  | OrchestrationProjectorDecodeError
  | OrchestrationListenerCallbackError;
```

This is the failure state space for command dispatch. Five possible failure states, each structurally distinct. The `Deferred` that carries the dispatch result is typed accordingly:

```ts
interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
}
```

The caller that `await`s this `Deferred` gets either a sequence number or one of exactly those five error types. Not a mystery. Not `unknown`.

## Error Recovery in the Engine

Now the payoff. The orchestration engine's `processEnvelope` function is where all of this comes together. It is the most interesting error-handling code in the codebase, and it's worth reading carefully.

The happy path runs inside a database transaction:

**`processEnvelope` happy path:** [OrchestrationEngine.ts:110](/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L110)

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
      // ... record acceptance receipt, return result
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

There's a lot here. The transaction body is an `Effect.gen` — familiar from Chapter 1. Every `yield*` inside could fail. `eventStore.append` might hit a database constraint. `projectEvent` might fail to decode. If *any* of them fail, the transaction rolls back.

The `.pipe(Effect.catchTag("SqlError", ...))` at the bottom is the first piece of error handling. `catchTag` matches on the `_tag` field of the error. If the transaction fails with an `SqlError` (Effect's built-in SQL error), this intercepts it and wraps it in a `PersistenceSqlError` — a domain error with operation context. All other error types pass through untouched.

This is pattern matching on the error channel. In a physics analogy: you're writing the Hamiltonian for a specific interaction. `SqlError` gets one treatment. Everything else propagates.

Now the outer error handler — the fallback for *all* failures:

**`processEnvelope` error recovery:** [OrchestrationEngine.ts:161](/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L161)

```ts
).pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      // 1. Reconcile in-memory read model with persisted events
      yield* reconcileReadModelAfterDispatchFailure.pipe(
        Effect.catch(() =>
          Effect.logWarning(
            "failed to reconcile orchestration read model after dispatch failure",
          ),
        ),
      );

      // 2. If invariant error, record a rejection receipt
      if (Schema.is(OrchestrationCommandInvariantError)(error)) {
        const aggregateRef = commandToAggregateRef(envelope.command);
        yield* commandReceiptRepository
          .upsert({
            commandId: envelope.command.commandId,
            aggregateKind: aggregateRef.aggregateKind,
            aggregateId: aggregateRef.aggregateId,
            // ...
            status: "rejected",
            error: error.message,
          })
          .pipe(Effect.catch(() => Effect.void));
      }

      // 3. Propagate error to the caller
      yield* Deferred.fail(envelope.result, error);
    }),
  ),
);
```

Three things happen, in order:

**Step 1: Reconciliation.** The engine maintains an in-memory read model (a projection of all events). If the transaction failed partway — maybe the append succeeded but the projection didn't — the in-memory model might be out of sync with the database. `reconcileReadModelAfterDispatchFailure` re-reads persisted events and replays them through the projector.

**`reconcileReadModelAfterDispatchFailure`:** [OrchestrationEngine.ts:65](/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L65)

```ts
const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
  const persistedEvents = yield* Stream.runCollect(
    eventStore.readFromSequence(dispatchStartSequence),
  ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
  // ...
  let nextReadModel = readModel;
  for (const persistedEvent of persistedEvents) {
    nextReadModel = yield* projectEvent(nextReadModel, persistedEvent);
  }
  readModel = nextReadModel;
  // ... publish events to subscribers
});
```

Notice the reconciliation itself is wrapped in `Effect.catch(() => Effect.logWarning(...))`. If reconciliation also fails, we log and move on — we don't throw away the original error. Errors compose.

**Step 2: Record rejection.** If the original error was an `OrchestrationCommandInvariantError` — a business rule violation — the engine records a rejection receipt. The `Schema.is(OrchestrationCommandInvariantError)(error)` check is a runtime type guard using the same schema that defined the error. Invariant violations are permanent: the command will never succeed, so we persist the rejection to prevent re-processing.

Database errors, decode errors, listener errors — none of those get rejection receipts. They're transient or systemic, not business-logic rejections. The *type* of the error determines the recovery strategy.

**Step 3: Propagate.** `Deferred.fail(envelope.result, error)` sends the error to whoever dispatched the command. They'll get back an `OrchestrationDispatchError` — the exact union type from the `Deferred`'s type signature. They know what they're dealing with.

## This Is Not Java

If you've encountered Java's checked exceptions, you might be feeling a twitch. "Great, so every function declares its errors, and I have to handle them at every call site? That's why everyone switched to unchecked exceptions."

No. The difference is composition. In Java, checked exceptions force you to `try/catch` or declare `throws` at every method boundary — a tax on every function in the call chain. In Effect, errors propagate through composition automatically. If you call three functions that can each fail with different error types, your computation's error channel is the union of all three — with zero boilerplate.

```ts
// Not actual T3 Code — illustration
const program = Effect.gen(function* () {
  yield* parseCommand(raw);    // E: JsonParseError | DecodeError
  yield* validateInvariants(); // E: InvariantError
  yield* persistEvent();       // E: PersistenceSqlError
});
// program: Effect<void, JsonParseError | DecodeError | InvariantError | PersistenceSqlError>
```

The error channel widens automatically. You handle errors at *boundaries* — where you have enough context to decide what to do. Not at every intermediate call. The compiler tracks the accumulation for you, and it narrows the union when you handle a case with `catchTag`.

`catchTag("SqlError", handler)` removes `SqlError` from the union. What remains is what you haven't handled yet. When you've caught them all, `E` is `never` — proof that every failure mode has a handler.

## The State Space of Failure

Here's what's actually going on. In physics, a complete description of a system includes its failure modes. You don't describe a damped oscillator by only specifying the oscillation — you also specify the damping, the energy loss, the decay modes. The failure states are part of the state space.

Effect's error channel is exactly this. `Effect.Effect<A, E>` says: this computation lives in a state space where the success states have shape `A` and the failure states have shape `E`. The type system ensures that every composition of computations correctly computes the joint failure state space.

The orchestration engine's error union — `OrchestrationDispatchError` — is a complete enumeration of how command dispatch can fail. Not "it throws something." Not "check the docs." The type *is* the specification. If you add a new failure mode, the union grows, and the compiler tells you everywhere that needs to account for it.

`catch(e: unknown)` is a system where you've declared the failure state space to be "all possible values." You've told the compiler: "I know nothing about how this can fail." Effect inverts this. You start from precise failure types and compose them. The default is maximum information, not minimum.

The orchestration engine handles each failure differently because the *type* tells it what happened. Invariant errors get rejection receipts. SQL errors get domain wrappers. All errors trigger read-model reconciliation. And the caller gets back a typed union, not a mystery. Every failure state has a name, structured fields, and a recovery path.

That's what it means for errors to mean something.
