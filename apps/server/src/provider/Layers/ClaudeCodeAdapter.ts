/**
 * ClaudeCodeAdapterLive - Scoped live implementation for the Claude Code provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` behind the `ClaudeCodeAdapter` service
 * contract and maps SDK messages into the shared `ProviderRuntimeEvent` algebra.
 *
 * @module ClaudeCodeAdapterLive
 */
import type {
  CanonicalItemType,
  CanonicalRequestType,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Deferred, Effect, Layer, Queue, Stream } from "effect";
import type {
  Query as ClaudeQuery,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
  CanUseTool,
  Options as ClaudeQueryOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { query as createClaudeQuery } from "@anthropic-ai/claude-agent-sdk";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterShape,
} from "../Services/ClaudeCodeAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeCode" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaudeResumeCursor {
  readonly sessionId?: string;
  readonly turnCount?: number;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly deferred: Deferred.Deferred<"accept" | "acceptForSession" | "decline" | "cancel">;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly assistantItemId: string;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  emittedTextDelta: boolean;
  fallbackAssistantText: string;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  query: ClaudeQuery;
  readonly turns: Array<{ id: TurnId; items: ReadonlyArray<unknown> }>;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly inFlightTools: Map<number, { toolName: string; toolUseId: string }>;
  turnState: ClaudeTurnState | undefined;
  resumeCursor: ClaudeResumeCursor;
  stopped: boolean;
  lastAssistantUuid: string | undefined;
}

export interface ClaudeCodeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: string | AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQuery;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoNow(): ProviderRuntimeEvent["createdAt"] {
  return new Date().toISOString() as ProviderRuntimeEvent["createdAt"];
}

function newEventId(): ProviderRuntimeEvent["eventId"] {
  return EventId.makeUnsafe(crypto.randomUUID());
}

function asRuntimeItemId(id: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(id as ProviderItemId);
}

function classifyTool(toolName: string): CanonicalItemType {
  const lower = toolName.toLowerCase();
  if (
    lower.includes("bash") ||
    lower.includes("command") ||
    lower.includes("shell") ||
    lower.includes("terminal")
  )
    return "command_execution";
  if (
    lower.includes("edit") ||
    lower.includes("write") ||
    lower.includes("file") ||
    lower.includes("patch") ||
    lower.includes("notebook")
  )
    return "file_change";
  if (lower.includes("mcp")) return "mcp_tool_call";
  if (lower.includes("agent") || lower.includes("collab")) return "collab_agent_tool_call";
  if (lower.includes("web") || lower.includes("search")) return "web_search";
  return "dynamic_tool_call";
}

function classifyToolRequest(toolName: string): CanonicalRequestType {
  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("command") || lower.includes("shell"))
    return "command_execution_approval";
  if (lower.includes("read") || lower.includes("glob") || lower.includes("grep"))
    return "file_read_approval";
  if (
    lower.includes("edit") ||
    lower.includes("write") ||
    lower.includes("file") ||
    lower.includes("patch")
  )
    return "file_change_approval";
  return "command_execution_approval";
}

function toolItemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "collab_agent_tool_call":
      return "Agent call";
    default:
      return undefined;
  }
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string | undefined {
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") return input.pattern;
  return toolName;
}

function turnStateFromResult(
  result: SDKResultMessage,
): "completed" | "failed" | "cancelled" | "interrupted" {
  if (result.subtype === "success") return "completed";
  if (result.subtype === "error_during_execution") {
    const errors =
      "errors" in result && Array.isArray(result.errors)
        ? result.errors.join(" ").toLowerCase()
        : "";
    if (errors.includes("interrupt")) return "interrupted";
    if (errors.includes("cancel")) return "cancelled";
    return "failed";
  }
  return "failed";
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

function makeClaudeCodeAdapter(options?: ClaudeCodeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const sessions = new Map<string, ClaudeSessionContext>();
    const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const queryFactory = options?.createQuery ?? createClaudeQuery;
    const nativeEventLogger = options?.nativeEventLogger;

    function emit(event: ProviderRuntimeEvent): void {
      Effect.runSync(Queue.offer(eventQueue, event));
    }

    function makeEventBase(
      threadId: ThreadId,
      turnId?: TurnId,
    ): Omit<ProviderRuntimeEvent, "type" | "payload"> {
      return {
        eventId: newEventId(),
        provider: PROVIDER,
        threadId,
        createdAt: isoNow(),
        ...(turnId ? { turnId } : {}),
      };
    }

    function logNativeEvent(threadId: ThreadId, method: string, message: SDKMessage): void {
      if (!nativeEventLogger) return;
      nativeEventLogger.write({ method: `claude/${method}`, payload: message }, threadId).pipe(
        Effect.runFork,
      );
    }

    // -----------------------------------------------------------------------
    // SDK Message handlers
    // -----------------------------------------------------------------------

    function handleStreamEvent(
      ctx: ClaudeSessionContext,
      message: SDKPartialAssistantMessage,
    ): void {
      const event = message.event;
      const turnId = ctx.turnState?.turnId;
      if (!turnId) return;

      if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          ctx.turnState!.emittedTextDelta = true;
          emit({
            ...makeEventBase(ctx.session.threadId, turnId),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: delta.text,
            },
            raw: {
              source: "claude.agent-sdk.message",
              method: "stream_event/content_block_delta/text_delta",
              payload: message,
            },
          });
        } else if (delta.type === "thinking_delta") {
          emit({
            ...makeEventBase(ctx.session.threadId, turnId),
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: delta.thinking,
            },
            raw: {
              source: "claude.agent-sdk.message",
              method: "stream_event/content_block_delta/thinking_delta",
              payload: message,
            },
          });
        }
      } else if (event.type === "content_block_start" && event.content_block) {
        const block = event.content_block;
        if (
          block.type === "tool_use" ||
          block.type === "server_tool_use" ||
          block.type === "mcp_tool_use"
        ) {
          const toolName = block.name ?? "unknown";
          const toolUseId = block.id ?? crypto.randomUUID();
          const toolItemType = classifyTool(toolName);
          ctx.inFlightTools.set(event.index, { toolName, toolUseId });

          const itemId = asRuntimeItemId(toolUseId);
          const title = toolItemTitle(toolItemType);
          emit({
            ...makeEventBase(ctx.session.threadId, turnId),
            itemId,
            type: "item.started",
            payload: {
              itemType: toolItemType,
              status: "inProgress",
              ...(title ? { title } : {}),
              detail: toolName,
            },
            raw: {
              source: "claude.agent-sdk.message",
              method: `stream_event/content_block_start/${block.type}`,
              payload: message,
            },
          });
        }
      } else if (event.type === "content_block_stop") {
        const inFlight = ctx.inFlightTools.get(event.index);
        if (inFlight) {
          ctx.inFlightTools.delete(event.index);
          const toolItemType = classifyTool(inFlight.toolName);
          const itemId = asRuntimeItemId(inFlight.toolUseId);
          const title = toolItemTitle(toolItemType);
          emit({
            ...makeEventBase(ctx.session.threadId, turnId),
            itemId,
            type: "item.completed",
            payload: {
              itemType: toolItemType,
              status: "completed",
              ...(title ? { title } : {}),
              detail: inFlight.toolName,
            },
          });
        }
      }
    }

    function handleAssistantMessage(
      ctx: ClaudeSessionContext,
      message: SDKAssistantMessage,
    ): void {
      ctx.lastAssistantUuid = message.uuid;

      if (ctx.turnState && message.message?.content) {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null && "type" in block) {
              if (block.type === "text" && "text" in block && typeof block.text === "string") {
                ctx.turnState.fallbackAssistantText += block.text;
              }
            }
          }
        }
      }
    }

    function handleResultMessage(ctx: ClaudeSessionContext, message: SDKResultMessage): void {
      const turnState = ctx.turnState;
      if (!turnState) return;

      // Emit fallback text if no stream deltas were emitted
      if (!turnState.emittedTextDelta && turnState.fallbackAssistantText.length > 0) {
        emit({
          ...makeEventBase(ctx.session.threadId, turnState.turnId),
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: turnState.fallbackAssistantText,
          },
        });
      }

      // Emit item.completed for the assistant message
      emit({
        ...makeEventBase(ctx.session.threadId, turnState.turnId),
        itemId: asRuntimeItemId(turnState.assistantItemId),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
        },
      });

      // Push completed turn to history
      ctx.turns.push({
        id: turnState.turnId,
        items: [...turnState.items],
      });

      // Update resume cursor
      ctx.resumeCursor = {
        sessionId: message.session_id,
        turnCount: (ctx.resumeCursor.turnCount ?? 0) + 1,
      };

      // Emit turn.completed
      const usage = "usage" in message ? (message as any).usage : undefined;
      const totalCost =
        "total_cost_usd" in message ? (message as any).total_cost_usd : undefined;

      emit({
        ...makeEventBase(ctx.session.threadId, turnState.turnId),
        type: "turn.completed",
        payload: {
          state: turnStateFromResult(message),
          ...(usage ? { usage } : {}),
          ...(typeof totalCost === "number" ? { totalCostUsd: totalCost } : {}),
        },
        raw: {
          source: "claude.agent-sdk.message",
          method: "result",
          payload: message,
        },
      });

      // Update session status
      ctx.session = {
        ...ctx.session,
        status: "ready",
        activeTurnId: undefined,
        resumeCursor: ctx.resumeCursor,
        updatedAt: isoNow() as ProviderSession["updatedAt"],
      };
      ctx.turnState = undefined;
    }

    function handleSystemMessage(ctx: ClaudeSessionContext, message: SDKMessage): void {
      const turnId = ctx.turnState?.turnId;
      const msg = message as any;

      if (msg.subtype === "status") {
        const status = msg.status;
        emit({
          ...makeEventBase(ctx.session.threadId, turnId),
          type: "session.state.changed",
          payload: {
            state: status === "compacting" ? ("waiting" as const) : ("running" as const),
            ...(status ? { reason: String(status) } : {}),
          },
        });
      } else if (msg.subtype === "compact_boundary") {
        emit({
          ...makeEventBase(ctx.session.threadId, turnId),
          type: "thread.state.changed",
          payload: {
            state: "compacted" as const,
          },
        });
      }
    }

    function processSdkMessage(ctx: ClaudeSessionContext, message: SDKMessage): void {
      logNativeEvent(ctx.session.threadId, message.type, message);

      switch (message.type) {
        case "stream_event":
          handleStreamEvent(ctx, message as SDKPartialAssistantMessage);
          break;
        case "assistant":
          handleAssistantMessage(ctx, message as SDKAssistantMessage);
          break;
        case "result":
          handleResultMessage(ctx, message as SDKResultMessage);
          break;
        case "system":
          handleSystemMessage(ctx, message);
          break;
        case "auth_status": {
          const authMsg = message as any;
          emit({
            ...makeEventBase(ctx.session.threadId, ctx.turnState?.turnId),
            type: "auth.status",
            payload: {
              isAuthenticating: authMsg.isAuthenticating ?? false,
              output: authMsg.output ?? [],
              ...(authMsg.error ? { error: authMsg.error } : {}),
            },
          });
          break;
        }
        case "rate_limit_event": {
          const rlMsg = message as any;
          emit({
            ...makeEventBase(ctx.session.threadId, ctx.turnState?.turnId),
            type: "account.rate-limits.updated",
            payload: {
              rateLimits: rlMsg.rate_limit_info ?? {},
            },
          });
          break;
        }
        case "tool_progress": {
          const tpMsg = message as any;
          emit({
            ...makeEventBase(ctx.session.threadId, ctx.turnState?.turnId),
            type: "tool.progress",
            payload: {
              toolName: tpMsg.tool_name ?? undefined,
              toolUseId: tpMsg.tool_use_id ?? undefined,
              summary: tpMsg.summary ?? undefined,
            },
          });
          break;
        }
        case "tool_use_summary": {
          const tsMsg = message as any;
          emit({
            ...makeEventBase(ctx.session.threadId, ctx.turnState?.turnId),
            type: "tool.summary",
            payload: {
              summary: tsMsg.summary ?? tsMsg.tool_name ?? "tool",
            },
          });
          break;
        }
        default:
          break;
      }
    }

    // -----------------------------------------------------------------------
    // Stream processing loop
    // -----------------------------------------------------------------------

    async function runStreamLoop(ctx: ClaudeSessionContext): Promise<void> {
      try {
        for await (const message of ctx.query) {
          if (ctx.stopped) break;
          processSdkMessage(ctx, message);
        }
      } catch (error) {
        if (!ctx.stopped) {
          emit({
            ...makeEventBase(ctx.session.threadId, ctx.turnState?.turnId),
            type: "runtime.error",
            payload: {
              message: error instanceof Error ? error.message : "Claude query stream error",
              class: "provider_error",
              detail: error,
            },
          });
        }
      }
    }

    // -----------------------------------------------------------------------
    // Approval callback
    // -----------------------------------------------------------------------

    function makeCanUseTool(ctx: ClaudeSessionContext): CanUseTool {
      return async (toolName, input, callbackOptions) => {
        const runtimeMode = ctx.session.runtimeMode;

        if (runtimeMode === "full-access") {
          return { behavior: "allow", toolUseID: callbackOptions.toolUseID };
        }

        const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
        const requestType = classifyToolRequest(toolName);
        const detail = summarizeToolInput(toolName, input);
        const deferred = Effect.runSync(
          Deferred.make<"accept" | "acceptForSession" | "decline" | "cancel">(),
        );

        ctx.pendingApprovals.set(requestId, {
          requestType,
          detail,
          deferred,
        });

        emit({
          ...makeEventBase(ctx.session.threadId, ctx.turnState?.turnId),
          requestId: RuntimeRequestId.makeUnsafe(requestId),
          type: "request.opened",
          payload: {
            requestType,
            ...(detail ? { detail } : {}),
            args: { toolName, input },
          },
          raw: {
            source: "claude.agent-sdk.tool-use",
            method: `canUseTool/${toolName}`,
            payload: { toolName, input },
          },
        });

        const decision = await Effect.runPromise(Deferred.await(deferred));

        ctx.pendingApprovals.delete(requestId);

        emit({
          ...makeEventBase(ctx.session.threadId, ctx.turnState?.turnId),
          requestId: RuntimeRequestId.makeUnsafe(requestId),
          type: "request.resolved",
          payload: {
            requestType,
            decision,
          },
        });

        if (decision === "accept" || decision === "acceptForSession") {
          return {
            behavior: "allow" as const,
            toolUseID: callbackOptions.toolUseID,
          };
        }

        return {
          behavior: "deny" as const,
          message: decision === "cancel" ? "User cancelled" : "User declined",
          toolUseID: callbackOptions.toolUseID,
        };
      };
    }

    // -----------------------------------------------------------------------
    // ProviderAdapterShape implementation
    // -----------------------------------------------------------------------

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider "${PROVIDER}", got "${input.provider}"`,
          });
        }

        const threadId = input.threadId;
        const runtimeMode = input.runtimeMode ?? "full-access";
        const model = input.model ?? "claude-sonnet-4-20250514";
        const cwd = input.cwd ?? process.cwd();
        const binaryPath = input.providerOptions?.claudeCode?.binaryPath;
        const resumeCursorRaw = input.resumeCursor as ClaudeResumeCursor | undefined;

        const permissionMode =
          runtimeMode === "full-access" ? ("bypassPermissions" as const) : undefined;

        const queryOptions: ClaudeQueryOptions = {
          cwd,
          model,
          ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          includePartialMessages: true,
          env: process.env as Record<string, string>,
          ...(resumeCursorRaw?.sessionId ? { resume: resumeCursorRaw.sessionId } : {}),
        };

        const sessionNow = isoNow();
        const sessionData: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode,
          cwd,
          model,
          threadId,
          resumeCursor: resumeCursorRaw,
          createdAt: sessionNow as ProviderSession["createdAt"],
          updatedAt: sessionNow as ProviderSession["updatedAt"],
        };

        const ctx: ClaudeSessionContext = {
          session: sessionData,
          query: undefined as any,
          turns: [],
          pendingApprovals: new Map(),
          inFlightTools: new Map(),
          turnState: undefined,
          resumeCursor: resumeCursorRaw ?? {},
          stopped: false,
          lastAssistantUuid: undefined,
        };

        if (runtimeMode !== "full-access") {
          (queryOptions as any).canUseTool = makeCanUseTool(ctx);
        }

        // Start with empty prompt — sendTurn will create queries per turn
        const query = queryFactory({
          prompt: (async function* () {
            // Empty generator — no initial prompt
          })(),
          options: queryOptions,
        });

        ctx.query = query;
        sessions.set(threadId, ctx);

        emit({
          ...makeEventBase(threadId),
          type: "session.started",
          payload: {},
        });

        void runStreamLoop(ctx);

        return sessionData;
      });

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = sessions.get(input.threadId);
        if (!ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const assistantItemId = crypto.randomUUID();

        ctx.turnState = {
          turnId,
          assistantItemId,
          startedAt: isoNow(),
          items: [],
          emittedTextDelta: false,
          fallbackAssistantText: "",
        };

        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: isoNow() as ProviderSession["updatedAt"],
        };

        emit({
          ...makeEventBase(input.threadId, turnId),
          type: "turn.started",
          payload: {},
        });

        // Create a new query for each turn with the user input as the prompt
        if (input.input) {
          const runtimeMode = ctx.session.runtimeMode;
          const permissionMode =
            runtimeMode === "full-access" ? ("bypassPermissions" as const) : undefined;

          const queryOptions: ClaudeQueryOptions = {
            cwd: ctx.session.cwd ?? process.cwd(),
            model: input.model ?? ctx.session.model ?? "claude-sonnet-4-20250514",
            ...(permissionMode ? { permissionMode } : {}),
            ...(permissionMode === "bypassPermissions"
              ? { allowDangerouslySkipPermissions: true }
              : {}),
            includePartialMessages: true,
            env: process.env as Record<string, string>,
            ...(ctx.resumeCursor.sessionId ? { resume: ctx.resumeCursor.sessionId } : {}),
          };

          if (runtimeMode !== "full-access") {
            (queryOptions as any).canUseTool = makeCanUseTool(ctx);
          }

          const newQuery = queryFactory({
            prompt: input.input,
            options: queryOptions,
          });

          ctx.query = newQuery;

          if (input.model && input.model !== ctx.session.model) {
            ctx.session = {
              ...ctx.session,
              model: input.model,
              updatedAt: isoNow() as ProviderSession["updatedAt"],
            };
          }

          void runStreamLoop(ctx);
        }

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.resumeCursor,
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        yield* Effect.tryPromise({
          try: () => ctx.query.interrupt(),
          catch: () => undefined,
        }).pipe(Effect.ignore);
      });

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: `No pending approval for request ${requestId}`,
          });
        }

        yield* Deferred.succeed(pending.deferred, decision);
      });

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (
      threadId,
      _requestId,
      _answers,
    ) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
      });

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        if (!ctx) return;

        ctx.stopped = true;

        for (const [, pending] of ctx.pendingApprovals) {
          Deferred.unsafeDone(pending.deferred, Effect.succeed("cancel"));
        }
        ctx.pendingApprovals.clear();

        try {
          ctx.query.return(undefined);
        } catch {
          // Ignore close errors
        }

        sessions.delete(threadId);

        emit({
          ...makeEventBase(threadId),
          type: "session.exited",
          payload: {
            reason: "stopped",
          },
        });
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values()).map((ctx) => ctx.session));

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        return {
          threadId,
          turns: ctx.turns,
        } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        const keepCount = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(keepCount);
        ctx.resumeCursor = {
          ...ctx.resumeCursor,
          turnCount: keepCount,
        };

        return {
          threadId,
          turns: ctx.turns,
        } satisfies ProviderThreadSnapshot;
      });

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const threadIds = Array.from(sessions.keys());
        for (const threadId of threadIds) {
          yield* stopSession(ThreadId.makeUnsafe(threadId));
        }
      });

    const streamEvents: ClaudeCodeAdapterShape["streamEvents"] = Stream.fromQueue(eventQueue);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents,
    } satisfies ClaudeCodeAdapterShape;
  });
}

// ---------------------------------------------------------------------------
// Layer exports
// ---------------------------------------------------------------------------

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}

export const ClaudeCodeAdapterLive = makeClaudeCodeAdapterLive();
