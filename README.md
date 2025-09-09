# MCP History Store

[Chinese README](README.zh-CN.md)

A minimal Model Context Protocol (MCP) server that provides local, file‑based storage for conversation history and a rolling JSON summary. The model (LLM) manages summarization; this MCP only stores/reads.

## Quickstart
- Requirements: Node 20+, pnpm 9+
- Install: `pnpm install`
- Build: `pnpm build`
- Run (stdio): `pnpm start`
- Register in Codex MCP tools:
  - Command: `mcp-history-store --stdio`
  - Name: `history` (must match the prompt below)

Files are stored per project under `<PROJECT_ROOT>/.chat-history/<DIALOG>/` as `messages.json` and `summary.json` (set `CODEX_HISTORY_ROOT=/another/base` to override the base directory if needed).

## Agent Integration (Required)
Agents MUST use this MCP to manage dialog history and summary. The tool name must be `history`.

Tool methods
- `history_list_dialogs({ projectRoot }) -> { dialogs }`
- `history_get_summary({ projectRoot, dialog }) -> { summary | null }`
- `history_set_summary({ projectRoot, dialog, summary }) -> { ok: true }`
- `history_fetch({ projectRoot, dialog, recentTurns? }) -> { messages: [{ role, text, ts }] }`
- `history_save({ projectRoot, dialog, entry:{ role: 'user'|'assistant', text, ts? } }) -> { ok: true }`
- `history_clear({ projectRoot, dialog }) -> { ok: true }`

Conventions
- `projectRoot` is an absolute path of the active project.
- MCP tool responses are returned in the first content item: parse with `JSON.parse(content[0].text)`.

Session initialization (do once per dialog)
1) `dialogs = JSON.parse(call history_list_dialogs({ projectRoot }))`
2) Ask user to pick an existing dialog or provide a new short kebab-case name (≤ 40 chars). Maintain a working variable `dialog` and reuse it in later turns.
3) Load context for the chosen dialog:
   - `summary = JSON.parse(call history_get_summary({ projectRoot, dialog }))`
   - `messages = JSON.parse(call history_fetch({ projectRoot, dialog, recentTurns: 6 }))`
   Use `summary + messages` as authoritative history in reasoning and answers.

Low-frequency save policy (thresholds are verbally adjustable)
- Save only in these cases; otherwise do not call tools:
  - Important answers: response includes clearly structured sections like “Decisions/Constraints/TODO/Issues/Refs” → save immediately.
  - Turn budget K: after every K assistant turns (default `K = 5`).
  - Byte budget B: when accumulated unsaved text ≥ B (default `B = 48KB`).
  - Manual: when the user says “save”/“sync”.
- When saving:
  - Call `history_save` sequentially for all messages since last save (chronological order), e.g., user then assistant.
  - Summary throttling: update via `history_set_summary` only on “important saves” or every M-th save (default `M = 3`). Target ~700 tokens; structure:
    `{ version: 1, decisions: [], constraints: [], todos: [], issues: [], facts: [], refs: [{ type: 'file'|'api'|'url', value, hint }] }`.
  - If any tool call fails, do not interrupt the conversation; skip saving for this round.

## Notes
- Tool functions implemented: `history.fetch`, `history.save`, `history.getSummary`, `history.setSummary`, `history.clear`.
- Storage layout per session: `messages.json` (rolling raw turns), `summary.json` (structured JSON string).
- For quick inspection, set `CODEX_HISTORY_ROOT=/tmp/codex_history` before `pnpm start`.

## License
Licensed under the Apache License, Version 2.0. See `LICENSE` for details.

 
