# Types That Cross Boundaries

The client sends a JSON blob over the wire. The server needs to trust it.

This sounds simple until you sit down and count the surface area. T3 Code's WebSocket protocol has 29+ RPC methods, 15+ domain event types, 20+ command types, and 40+ provider runtime event types. Each has a specific payload shape. A thread ID is a string. A project ID is also a string. A command ID -- also a string. The client sends `{ threadId: "abc", projectId: "def" }`, the server reads the fields, and everything works until someone transposes them. The types are structurally identical. The compiler says nothing. The bug ships.

Then there's the wire itself. The client encodes JSON. The server decodes it. If the client starts sending a new field, or stops sending an old one, the server's TypeScript types don't know. `JSON.parse` returns `any`. You can assign `any` to anything. The types that were supposed to protect you evaporated the moment the data crossed the network boundary.

In most TypeScript projects, you solve piece one (validation) with Zod, piece two (nominal types) with branded types or newtypes, and piece three (serialization) with custom encoder/decoder functions. Three systems. Three sets of tests. Three places where a contract change can go wrong. Effect's Schema module replaces all three.

## Strings That Know What They Are

Open `baseSchemas.ts` and look at the factory that builds every entity identifier in the system.

**`makeEntityId`:** [baseSchemas.ts:15](/packages/contracts/src/baseSchemas.ts#L15)

```ts
const makeEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
```

Both `ThreadId` and `ProjectId` resolve to `string` at runtime. But at the type level, they carry a phantom brand -- a tag invisible to JavaScript but visible to TypeScript. The compiler will reject `projectId: threadId` even though both are strings, the same way a physicist labels a quantity in meters versus seconds: dimensionally incompatible, even if the number is the same.

The base type, `TrimmedNonEmptyString`, is itself a refined schema:

**`TrimmedNonEmptyString`:** [baseSchemas.ts:4](/packages/contracts/src/baseSchemas.ts#L4)

```ts
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());
```

So when you decode a `ThreadId` from the wire, you get three guarantees in one pass: the value is a string, it is not empty after trimming whitespace, and it is branded as a `ThreadId` -- not a `ProjectId`, not a `CommandId`, not a generic string. The schema definition *is* the validation logic *is* the type definition.

The codebase builds ten of these branded IDs from the same factory -- `CommandId`, `EventId`, `MessageId`, `TurnId`, `RuntimeSessionId`, and more. Each is two lines. Each is a distinct type. You can grep for every function that accepts a `ThreadId` and know with certainty that nobody passed a `ProjectId` there by accident.

## Building Shapes

With branded scalars in hand, you build structs.

**`OrchestrationProject`:** [orchestration.ts:136](/packages/contracts/src/orchestration.ts#L136)

```ts
export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;
```

Notice the pattern on the last line: `typeof OrchestrationProject.Type` extracts the TypeScript type from the schema value. You write the schema once and derive the type from it, not the other way around. The schema is the source of truth.

`Schema.NullOr(TrimmedNonEmptyString)` means the field can be a validated non-empty string or `null` -- no `undefined` ambiguity. `Schema.optional(...)` means the field can be absent from the wire entirely. These are distinct concepts. The schema encodes both, and the derived type reflects the difference precisely.

A session has more interesting constraints:

**`OrchestrationSession`:** [orchestration.ts:186](/packages/contracts/src/orchestration.ts#L186)

```ts
export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE),
  ),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
```

That `runtimeMode` field uses `Schema.withDecodingDefault` -- we'll come back to why in a moment.

## Enumerations That Close the Set

Where does `OrchestrationSessionStatus` come from?

**`OrchestrationSessionStatus`:** [orchestration.ts:175](/packages/contracts/src/orchestration.ts#L175)

```ts
export const OrchestrationSessionStatus = Schema.Literals([
  "idle", "starting", "running", "ready",
  "interrupted", "stopped", "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;
```

`Schema.Literals` creates a union of literal string types -- the equivalent of a string enum, but it's a schema. It validates, it types, and it serializes. If the wire sends `"paused"`, decoding fails. No `default` case in a switch statement silently swallowing unknown states.

The provider runtime layer uses the same pattern at every level of granularity:

**`ProviderRuntimeEventType`:** [providerRuntime.ts:142](/packages/contracts/src/providerRuntime.ts#L142)

```ts
const ProviderRuntimeEventType = Schema.Literals([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "turn.started",
  "turn.completed",
  "turn.plan.updated",
  "content.delta",
  "request.opened",
  // ... 40+ event types total
]);
```

Forty-plus event types, one literal union. Every one is both a runtime validator and a compile-time discriminant. This is important for what comes next.

## Discriminated Unions: One Type for 40 Events

Each of those 40+ event types has its own payload shape. A `turn.plan.updated` event carries an array of plan steps. A `content.delta` carries a text fragment and a stream kind. A `session.exited` carries an optional reason and an exit kind. These are not interchangeable.

The codebase builds each variant by spreading a shared base into a specific struct:

**`ProviderRuntimeEventBase` and a variant:** [providerRuntime.ts:241](/packages/contracts/src/providerRuntime.ts#L241)

```ts
const ProviderRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
  // ...
});

const ProviderRuntimeTurnPlanUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnPlanUpdatedType,             // Schema.Literal("turn.plan.updated")
  payload: TurnPlanUpdatedPayload,
});
```

Then the union ties them all together:

**`ProviderRuntimeEvent`:** [providerRuntime.ts:918](/packages/contracts/src/providerRuntime.ts#L918)

```ts
export const ProviderRuntimeEventV2 = Schema.Union([
  ProviderRuntimeSessionStartedEvent,
  ProviderRuntimeSessionConfiguredEvent,
  // ... 35+ more members
  ProviderRuntimeErrorEvent,
]);
export type ProviderRuntimeEvent = ProviderRuntimeEventV2;
```

This is a discriminated union on the `type` field. When you decode an unknown blob into a `ProviderRuntimeEvent`, Schema checks the `type` literal, picks the matching branch, and validates that branch's specific payload shape. The result is fully narrowed: after `if (event.type === "turn.plan.updated")`, TypeScript knows `event.payload` has an `explanation` and a `plan` array. No casting. No `as any`.

The WebSocket protocol itself is built the same way. The server accepts 29+ request types over a single WebSocket connection, differentiated by a `_tag` field:

**`tagRequestBody` and `WebSocketRequestBody`:** [ws.ts:90](/packages/contracts/src/ws.ts#L90)

```ts
const tagRequestBody = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  schema: Schema.Struct<Fields>,
) =>
  schema.mapFields(
    Struct.assign({ _tag: Schema.tag(tag) }),
    { unsafePreserveChecks: true },
  );

const WebSocketRequestBody = Schema.Union([
  tagRequestBody(ORCHESTRATION_WS_METHODS.dispatchCommand,
    Schema.Struct({ command: ClientOrchestrationCommand })),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getSnapshot, OrchestrationGetSnapshotInput),
  tagRequestBody(WS_METHODS.gitPull, GitPullInput),
  tagRequestBody(WS_METHODS.terminalOpen, TerminalOpenInput),
  // ... 25+ more methods
]);
```

`tagRequestBody` takes a method name and a schema, then stamps a `_tag` discriminant onto it. The union discriminates on `_tag`. This replaces the classic pattern of `switch (message.method)` on an untyped string -- the schema does the dispatch and validation in one pass.

## Cross-Field Validation

Sometimes validity isn't per-field. Sometimes it's relational.

**`TurnCountRange`:** [orchestration.ts:876](/packages/contracts/src/orchestration.ts#L876)

```ts
export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);
```

`.check()` takes a filter that sees the *whole struct* after individual field validation passes. The filter returns `true` for valid, or an `InvalidValue` issue for invalid. Both fields are fine individually -- they're non-negative integers. But together, `from > to` is nonsensical. The schema catches it, with a specific error message, before the value ever reaches business logic.

This schema then gets reused:

```ts
export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({ threadId: ThreadId }),
  { unsafePreserveChecks: true },
);
```

`mapFields` extends the struct with additional fields while preserving the cross-field check. The `fromTurnCount <= toTurnCount` invariant carries forward into every schema that includes the range. Write the rule once.

## Validation at the Boundary

All these schemas would be academic without a place to enforce them. That place is the WebSocket message handler on the client.

**`decodeUnknownJsonResult`:** [schemaJson.ts:16](/packages/shared/src/schemaJson.ts#L16)

```ts
export const decodeUnknownJsonResult = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
) => {
  const decode = Schema.decodeUnknownExit(Schema.fromJsonString(schema));
  return (input: unknown) => {
    const result = decode(input);
    if (Exit.isFailure(result)) {
      return Result.fail(result.cause);
    }
    return Result.succeed(result.value);
  };
};
```

`Schema.fromJsonString(schema)` composes JSON parsing with schema decoding -- one step from raw string to validated type. `Schema.decodeUnknownExit` runs decoding synchronously and returns an `Exit` (success or cause-of-failure) rather than throwing. The wrapper converts this to a `Result`, which is Effect's synchronous success-or-failure type.

Now watch how `WsTransport` uses it:

**`handleMessage` in WsTransport:** [wsTransport.ts:195](/apps/web/src/wsTransport.ts#L195)

```ts
private handleMessage(raw: unknown) {
  const result = decodeWsResponse(raw);
  if (Result.isFailure(result)) {
    console.warn("Dropped inbound WebSocket envelope",
      formatSchemaError(result.failure));
    return;                                   // invalid message → drop and warn
  }

  const message = result.success;             // fully typed from here on
  if (isWsPushMessage(message)) {
    // ...dispatch to listeners...
  }
  // ...
}
```

Where `decodeWsResponse` was created earlier as:

```ts
const decodeWsResponse = decodeUnknownJsonResult(WsResponseSchema);
```

The boundary is sharp. On one side: `unknown`. On the other side: `WsResponse`, a union of `WebSocketResponse | WsPush`, fully validated, every field typed, every branded ID checked. Invalid messages get logged with structured error formatting and dropped. No exception propagation, no `try/catch`, no `as any`.

This is the same principle you saw in Chapter 1 with `yield*` and typed errors -- the computation knows its failure modes. Here, the schema knows its validation modes. The `Result.fail` branch carries the cause, which `formatSchemaError` can render into a human-readable description of exactly which field failed and why.

## Evolution: Fields That Weren't Always There

Systems evolve. You add a field. Old events in the database, persisted before the field existed, don't have it. Old clients, not yet updated, don't send it. You need backward compatibility without giving up validation.

**`OrchestrationThread.interactionMode`:** [orchestration.ts:263](/packages/contracts/src/orchestration.ts#L263)

```ts
export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  // ...
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  // ...
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  // ...
});
```

`Schema.withDecodingDefault` says: if this field is missing during decoding, use this default. But if the field *is* present, validate it normally. Old events stored before `interactionMode` existed decode with the default `"default"`. Old events stored before `proposedPlans` existed decode with an empty array. New events carry the real values. The schema handles both without branching logic in the business layer.

This shows up repeatedly in commands too -- the `ThreadCreateCommand` and `ThreadTurnStartCommand` both default `interactionMode` and `runtimeMode` during decoding, because these fields were added after the original command shape was established.

The key insight: `withDecodingDefault` is asymmetric. Decoding fills in the gap. Encoding outputs whatever value is there. Old data reads cleanly. New data writes completely. The schema encodes the *migration policy* for each field.

## The Contract Test That Reads Like Documentation

**`providerRuntime.test.ts`:** [providerRuntime.test.ts:1](/packages/contracts/src/providerRuntime.test.ts#L1)

```ts
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "codex",
      threadId: "thread-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });
```

Read this test three ways.

As **documentation**: it shows you the exact shape of a `turn.plan.updated` event. What fields exist, what their values look like, how the payload is structured. You don't need to chase through type definitions.

As a **contract test**: if someone changes `TurnPlanUpdatedPayload` -- renames `plan` to `steps`, changes the status literals -- this test breaks. The raw object is the wire format. The decode call is the contract. If they diverge, the test fails.

As a **validation test**: it proves that `Schema.decodeUnknownSync` accepts this exact shape. The next test in the file proves it *rejects* invalid shapes:

```ts
it("rejects empty branded canonical ids", () => {
  expect(() =>
    decodeRuntimeEvent({
      // ...
      threadId: "   ",            // whitespace-only → fails TrimmedNonEmptyString
      // ...
    }),
  ).toThrow();
});
```

Remember `TrimmedNonEmptyString` from the branded IDs? It trims whitespace and checks non-empty. A `threadId` of `"   "` trims to `""`, which fails the non-empty check. The branded type's validation rule fires at decode time, and the test documents this behavior. One system -- schema, type, validation, serialization -- tested in one place.

## One System, Three Jobs

In Chapters 1 through 3, you saw computation as a value, errors as structured data, and services wired through layers. Schema is the fourth piece, and it connects to all three.

When `yield*` suspends on a decode operation in a `gen` block, the failure is a `SchemaError` -- a structured error in the typed error channel, just like the `TaggedErrorClass` errors from Chapter 2. When a service layer (Chapter 3) needs to parse incoming messages, it calls `Schema.decode*` functions that return `Effect` values -- computations that haven't happened yet, composable with everything else in the pipeline.

But Schema's deepest contribution is at the boundary. Inside the application, types are trustworthy -- the compiler enforces them. At the edge -- WebSocket messages, database rows, JSON files -- types are aspirational until validated. Schema turns aspiration into enforcement, and it does so with one definition that simultaneously creates the TypeScript type, the runtime validator, the serializer, and the backward-compatibility policy.

The `packages/contracts` directory contains zero runtime logic. No database calls, no WebSocket handlers, no business rules. Just schemas. And yet it is the most critical package in the monorepo, because it is the contract between every other package. The server trusts that a decoded `OrchestrationCommand` is structurally sound because the schema proved it. The client trusts that a decoded `WsPush` carries the right payload for its channel because the schema proved it. Neither side needs defensive checks past the boundary. The schema did the work once, at the gate, and everyone inside the walls can reason without paranoia.

That's the core idea. Not "use Schema instead of Zod." Not "branded types are neat." The idea is: define the shape once, in one system, and let that single definition be your type, your validator, your serializer, your migration strategy, and your contract test -- simultaneously. One equation, five predictions.
