# Test Strategy Exploration

## Context
- T3 Code: minimal web GUI for code agents (Codex + Claude Code)
- Monorepo: server (Effect-TS, SQLite, node-pty), web (React 19), desktop (Electron), contracts, shared
- Event sourcing: commands → decider → events → projector → reactor
- Provider adapter pattern: each provider implements `ProviderAdapterShape`
- Two providers: Codex (mature), Claude Code (newly integrated via SDK)
- WebSocket protocol between client and server

## What this napkin is
An exploration — the human wants to think through testing strategy with a test architect before committing to a direction. No spec yet. The test architect's job here is to brainstorm, not execute.

## Open questions
- What are the real seams that break?
- Where does the event sourcing pipeline lose fidelity?
- How do you test provider adapters without real provider runtimes?
- What's the right split between small tests (vitest) and medium tests (Playwright + Electron)?
- What existing test coverage exists and where are the gaps?
- What testing patterns fit Effect-TS layers?
