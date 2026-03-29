# Effect Through T3 Code

A study guide for learning Effect-TS through a production codebase.

T3 Code is a web GUI that orchestrates AI code agents — Codex and Claude Code. Its server is built entirely on Effect-TS: services and layers for dependency injection, tagged errors for typed failure handling, streams and queues for event pipelines, and Schema for contracts between server and client. The architecture and the library teach each other.

This book follows a single thread through the system: what happens when a user types a message and presses Enter. Each chapter picks up where the previous one left off, using the next architectural challenge to motivate the next Effect concept.

## Chapters

1. **[Computation as a Value](01-computation-as-a-value.md)** — Effect.gen, yield*, pipe. The core mental model: computations are descriptions, not executions. You keep the equation, not just the answer.

2. **[Errors That Mean Something](02-errors-that-mean-something.md)** — Tagged errors, the error channel, catchTag. Failure states as part of the type — the compiler tracks what can go wrong.

3. **[The Dependency Graph](03-the-dependency-graph.md)** — Services, Layers, composition. 30+ services wired together through a typed dependency graph that the compiler verifies before anything runs.

4. **[Types That Cross Boundaries](04-types-that-cross-boundaries.md)** — Effect Schema. Branded IDs, discriminated unions, validation, serialization — one system replacing three.

5. **[How Information Flows](05-how-information-flows.md)** — Streams, Queues, PubSub. The full event pipeline from provider callback to browser push. Pull-based, lazy, testable.

6. **[Testing and the Real World](06-testing-and-the-real-world.md)** — Layer.succeed for fakes, in-memory databases, scripted test harnesses. Plus: how pure descriptions meet WebSocket callbacks and process lifecycle.

## How to Read This

Straight through, or jump to the chapter that matches your question. Each chapter is self-contained enough to be useful alone, but the narrative builds — concepts from earlier chapters are referenced, not re-explained.

The code snippets are curated extracts from the actual codebase with links to source files. They show the lines that reveal purpose, not the first N lines of a file.

## What This Is Not

This is not the Effect documentation. It doesn't cover every API or every pattern. It covers the patterns that T3 Code actually uses, in the context where they solve real problems. If you want the complete reference, the [Effect docs](https://effect.website) are excellent. This book is what you read first, to build the intuition that makes the docs make sense.
