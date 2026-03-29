# How Information Flows

The Codex process just finished a tool call. It fires a callback. Somewhere in the system, a projector needs to fold that event into a read model. A checkpoint reactor needs to snapshot the working tree. A WebSocket server needs to push the event to every connected browser. Three independent consumers, one event, zero tolerance for dropped messages.

Meanwhile, in a parallel universe, the Claude Code SDK yields the same kind of event --- but from an async iterator, not a callback. Both adapters need to feed into the same downstream pipeline without the pipeline knowing or caring which adapter produced the event.

This is the problem of *information flow* in a concurrent system. And Effect solves it with three primitives: **Queue**, **PubSub**, and **Stream**.

If you have used RxJS or EventEmitters, the topology will feel familiar. The deep difference: everything here is pull-based. A Stream is not a firehose. It is a recipe for producing values on demand. Nothing runs until a consumer asks. That single property --- laziness --- is what makes the whole system composable and testable.

---

## The Bridge: Queue

The Codex adapter lives in imperative territory. The `CodexManager` is a plain Node.js object that emits events through an EventEmitter. Effect's world is functional --- computations as values, as we established in Chapter 1. Something needs to bridge the gap.

That bridge is `Queue`.

[`apps/server/src/provider/Layers/CodexAdapter.ts`, lines 1461--1497](apps/server/src/provider/Layers/CodexAdapter.ts)

```ts
// Create an unbounded mailbox for runtime events
const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

yield* Effect.acquireRelease(
  Effect.gen(function* () {
    const services = yield* Effect.services<never>();
    const listener = (event: ProviderEvent) =>
      Effect.gen(function* () {
        const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
        if (runtimeEvents.length === 0) return;
        yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
      }).pipe(Effect.runPromiseWith(services));
    manager.on("event", listener);
    return listener;
  }),
  // Cleanup: unsubscribe + shut down the queue
  (listener) =>
    Effect.gen(function* () {
      yield* Effect.sync(() => manager.off("event", listener));
      yield* Queue.shutdown(runtimeEventQueue);
    }),
);
```

`Queue.unbounded()` creates a mailbox with no backpressure limit. `Queue.offerAll` drops events into it. The queue itself does nothing with them --- it just holds them until someone asks.

Who asks? The adapter's `streamEvents` property:

[`apps/server/src/provider/Layers/CodexAdapter.ts`, line 1517](apps/server/src/provider/Layers/CodexAdapter.ts)

```ts
streamEvents: Stream.fromQueue(runtimeEventQueue),
```

`Stream.fromQueue` creates a Stream that, when consumed, pulls items from the queue one at a time. If the queue is empty, the consumer blocks (yields its fiber, not the thread) until something arrives. If the queue has items, they flow immediately.

This is the push-to-pull bridge. The EventEmitter pushes into the queue. The Stream pulls from the queue. The queue is the membrane between two worlds.

The Claude Code adapter does the same thing with a different push source. Instead of an EventEmitter callback, it uses a `for await` loop over the SDK's async iterator:

[`apps/server/src/provider/Layers/ClaudeCodeAdapter.ts`, lines 204--210, 518--523, 925](apps/server/src/provider/Layers/ClaudeCodeAdapter.ts)

```ts
const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

function emit(event: ProviderRuntimeEvent): void {
  Effect.runSync(Queue.offer(eventQueue, event));
}

// In the stream loop:
async function runStreamLoop(ctx: ClaudeSessionContext): Promise<void> {
  for await (const message of ctx.query) {
    if (ctx.stopped) break;
    processSdkMessage(ctx, message);  // calls emit() internally
  }
}

// Exposed the same way:
const streamEvents = Stream.fromQueue(eventQueue);
```

Different push mechanism, identical downstream interface. The rest of the system never knows whether events came from an EventEmitter or an async iterator. It just sees `Stream<ProviderRuntimeEvent>`.

Notice the `acquireRelease` in the Codex adapter. When the scope closes (Chapter 3's resource management), the listener is unsubscribed and the queue is shut down. A shut-down queue causes `Stream.fromQueue` to end cleanly. No dangling subscriptions. No leaked listeners.

---

## Fan-Out: PubSub

A Queue is single-consumer. Once an item is taken, it is gone. But multiple parts of the system need every event: the ingestion pipeline, the checkpoint reactor, the WebSocket push layer. We need fan-out.

That is what `PubSub` does. Every subscriber gets an independent copy of every published message.

[`apps/server/src/provider/Layers/ProviderService.ts`, lines 138--181](apps/server/src/provider/Layers/ProviderService.ts)

```ts
const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
  Effect.succeed(event).pipe(
    Effect.tap((e) =>
      canonicalEventLogger ? canonicalEventLogger.write(e, null) : Effect.void,
    ),
    Effect.flatMap((e) => PubSub.publish(runtimeEventPubSub, e)),
    Effect.asVoid,
  );

// Worker: single-threaded drain of the queue into the PubSub
const worker = Effect.forever(
  Queue.take(runtimeEventQueue).pipe(Effect.flatMap(processRuntimeEvent)),
);
yield* Effect.forkScoped(worker);

// Fork each adapter's stream into the shared queue
yield* Effect.forEach(adapters, (adapter) =>
  Stream.runForEach(adapter.streamEvents, (event) =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
  ).pipe(Effect.forkScoped),
).pipe(Effect.asVoid);
```

There are three stages here. Read them bottom-to-top:

1. **Adapter streams drain into a single Queue.** Each adapter's `streamEvents` is consumed in a background fiber. Events from all adapters merge into `runtimeEventQueue`. This is N-to-1 fan-in.

2. **A worker loop takes from the Queue and publishes to the PubSub.** One event at a time, strictly ordered. `processRuntimeEvent` calls `publishRuntimeEvent`, which writes to the PubSub.

3. **Subscribers create fresh streams from the PubSub.** The getter pattern ensures each access creates an independent subscription:

[`apps/server/src/provider/Layers/ProviderService.ts`, lines 543--545](apps/server/src/provider/Layers/ProviderService.ts)

```ts
get streamEvents(): ProviderServiceShape["streamEvents"] {
  return Stream.fromPubSub(runtimeEventPubSub);
}
```

The `get` keyword matters. It is not a cached property --- it is a function that runs on every access. Each call to `Stream.fromPubSub` creates a new subscription to the PubSub. Subscriber A and Subscriber B each see every event, independently, at their own pace. If A is slow and B is fast, B is not blocked.

This is the same pattern used in `OrchestrationEngine` for domain events:

[`apps/server/src/orchestration/Layers/OrchestrationEngine.ts`, lines 232--234](apps/server/src/orchestration/Layers/OrchestrationEngine.ts)

```ts
get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
  return Stream.fromPubSub(eventPubSub);
}
```

PubSub is the fan-out primitive. Queue merges. PubSub broadcasts. Stream.fromPubSub is how you subscribe.

---

## The Worker Loop

You have already seen it twice. Here it is three times, side by side. This is the most common pattern in the T3 Code server.

**ProviderService** --- merges adapter streams into PubSub:

```ts
yield* Effect.forkScoped(
  Effect.forever(
    Queue.take(runtimeEventQueue).pipe(Effect.flatMap(processRuntimeEvent)),
  ),
);
```

**OrchestrationEngine** --- processes commands sequentially:

[`apps/server/src/orchestration/Layers/OrchestrationEngine.ts`, lines 206--207](apps/server/src/orchestration/Layers/OrchestrationEngine.ts)

```ts
const worker = Effect.forever(
  Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)),
);
yield* Effect.forkScoped(worker);
```

**pushBus** --- sends WebSocket messages to clients:

[`apps/server/src/wsServer/pushBus.ts`, lines 76--88](apps/server/src/wsServer/pushBus.ts)

```ts
yield* Effect.forkScoped(
  Effect.forever(
    Queue.take(queue).pipe(
      Effect.flatMap((job) =>
        send(job).pipe(
          Effect.tap((delivered) => settleDelivery(job, delivered)),
          Effect.tapCause(() => settleDelivery(job, false)),
          Effect.ignoreCause({ log: true }),
        ),
      ),
    ),
  ),
);
```

The skeleton is always the same:

```
Effect.forkScoped(Effect.forever(Queue.take(q).pipe(Effect.flatMap(process))))
```

`Queue.take` blocks until an item arrives. `process` handles it. `Effect.forever` loops. `Effect.forkScoped` runs it in a background fiber that is automatically interrupted when the enclosing scope closes.

The pushBus variant adds error handling: `Effect.ignoreCause({ log: true })` logs failures but keeps the loop alive. One bad message does not kill the worker. This is the resilient worker pattern --- an error in one iteration does not break the loop. Compare this to Chapter 2's typed errors: here we *choose* to discard the error after logging, because the worker must keep running.

`Effect.forkScoped` deserves emphasis. Every fiber forked this way is tied to the scope that created it. When the scope closes --- whether because the server is shutting down, a test finished, or a session ended --- all forked fibers are interrupted. No manual cleanup. No forgotten `clearInterval`. The scope *is* the lifecycle.

---

## The Full Pipeline

Here is how a single event travels from a provider adapter to a browser:

```
                          PUSH SIDE                      PULL SIDE
                     (imperative world)             (Effect streams)

  Codex EventEmitter ─┐
                       ├─ Queue.offer ──▶ [Adapter Queue] ──▶ Stream.fromQueue
  Claude Code SDK ─────┘                                          │
     (for await)                                                  │
                                                                  ▼
                                                     ProviderService
                                              Queue.offer ──▶ [Merge Queue]
                                                                  │
                                                          Effect.forever
                                                         Queue.take + process
                                                                  │
                                                          PubSub.publish
                                                                  │
                              ┌────────────────┬──────────────────┤
                              ▼                ▼                  ▼
                   ProviderRuntime      Checkpoint          (other subscribers)
                     Ingestion           Reactor
                    Stream.fromPubSub   Stream.fromPubSub
                              │                │
                     DrainableWorker     DrainableWorker
                              │                │
                      OrchestrationEngine.dispatch
                              │
                      [Command Queue] ──▶ Effect.forever
                              │
                      Event Store (SQLite)
                              │
                      PubSub.publish(eventPubSub)
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
              wsServer              CheckpointReactor
        Stream.fromPubSub         Stream.fromPubSub
                    │
              pushBus.publishAll
                    │
              [Push Queue] ──▶ Effect.forever
                    │
              WebSocket.send ──▶ Browser
```

Trace it: A Codex callback fires. The listener maps the raw event, drops it into the adapter's Queue. `Stream.fromQueue` makes it available to whoever is consuming that stream. ProviderService's forked fiber pulls it out and offers it to the merge Queue. The worker loop takes from the merge Queue and publishes to the PubSub. ProviderRuntimeIngestion --- subscribed via `Stream.fromPubSub` --- receives the event, translates it to an orchestration command, and dispatches it to the OrchestrationEngine. The engine processes the command through the decider (event sourcing from Chapter 3's service layer), persists the resulting events, and publishes them to *its own* PubSub. The wsServer, subscribed to *that* PubSub, receives the domain event and drops it into the push Queue. The push worker takes it, serializes it, and sends it over WebSocket.

Five queues. Three PubSubs. Zero callbacks at the boundary. Every stage is independently testable because every stage is just a Stream consumer or a Queue producer.

---

## Draining: Deterministic Tests for Async Pipelines

The pipeline above has a problem for tests. Events flow through multiple queues and workers asynchronously. If you emit an event and immediately check the read model, the event might not have been processed yet. The naive fix is `sleep(100)`. The correct fix is `drain`.

[`packages/shared/src/DrainableWorker.ts`](packages/shared/src/DrainableWorker.ts)

```ts
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<A>();
    const initialIdle = yield* Deferred.make<void>();
    yield* Deferred.succeed(initialIdle, undefined).pipe(Effect.orDie);
    const state = yield* Ref.make({ outstanding: 0, idle: initialIdle });

    // The same worker loop pattern, with a twist
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((item) => process(item).pipe(Effect.ensuring(finishOne))),
        ),
      ),
    );

    // ...

    const drain: DrainableWorker<A>["drain"] = Ref.get(state).pipe(
      Effect.flatMap(({ idle }) => Deferred.await(idle)),
    );

    return { enqueue, drain };
  });
```

The trick is a counter and a `Deferred`. Every `enqueue` increments `outstanding`. Every completed processing step decrements it. When `outstanding` hits zero, the current `Deferred` is resolved. `drain` just waits for that `Deferred`.

`Deferred` is Effect's one-shot promise (we saw typed errors resolving through `Deferred` in the OrchestrationEngine's `dispatch`). It can be awaited by many fibers but completed only once. When `outstanding` drops to zero, the idle signal fires, and `drain` returns.

Here is `ProviderRuntimeIngestion` using it:

[`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, lines 1123--1143](apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts)

```ts
const worker = yield* makeDrainableWorker(processInputSafely);

const start: ProviderRuntimeIngestionShape["start"] = Effect.gen(function* () {
  yield* Effect.forkScoped(
    Stream.runForEach(providerService.streamEvents, (event) =>
      worker.enqueue({ source: "runtime", event }),
    ),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
      if (event.type !== "thread.turn-start-requested") return Effect.void;
      return worker.enqueue({ source: "domain", event });
    }),
  );
});

return { start, drain: worker.drain };
```

And the test harness:

[`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`, lines 162, 212](apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts)

```ts
const drain = () => Effect.runPromise(ingestion.drain);

// In a test:
harness.emit(turnStartedEvent);
harness.emit(turnCompletedEvent);
await harness.drain();  // blocks until both events are fully processed
// Now the read model is guaranteed to reflect both events
```

No sleep. No polling. No flaky timing. `drain()` returns exactly when the worker has finished processing everything that was enqueued before the `drain` call. The test is deterministic.

The `CheckpointReactor` uses the same pattern. So does `ProviderCommandReactor`. Anywhere you have a `makeDrainableWorker`, you have a testable async pipeline.

---

## The Pull Principle

Step back and look at the whole system. Nothing flows until someone asks. `Stream.fromQueue` does not consume until `Stream.runForEach` pulls. `Stream.fromPubSub` does not subscribe until something runs the stream. The ASCII diagram above looks like a push pipeline, but it is not. It is a network of lazy descriptions connected by queues and PubSubs.

This is why it composes. You can describe a stream, pass it around, transform it, and nothing happens. You can create a PubSub subscription and not consume it yet --- events will buffer. You can write a test that creates the whole pipeline, emits events synchronously, drains, and checks results, all without timing dependencies.

A Queue is where push meets pull. Imperative code pushes. Functional code pulls. The queue is the handshake point. A PubSub is a Queue that remembers to hand a copy to everyone.

If you have worked with lazy sequences in mathematics --- a sequence defined by its generating function rather than by enumeration --- this is the same idea applied to async I/O. The stream is the generating function. The queue is where the boundary conditions come from. And `Effect.forever` is the recurrence relation, evaluated one step at a time, forever, until the scope says stop.
