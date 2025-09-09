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


## System Prompt (copy‑paste into Codex's AGENTS.md or other prompt guidance)
```text
##Agents MUST use this MCP `history` tool to manage dialog history and the structured JSON summary.
- MCP tool name: history
  - history_list_dialogs({projectRoot}) -> {dialogs}
  - history_get_summary({projectRoot, dialog}) -> {summary|null}
  - history_set_summary({projectRoot, dialog, summary}) -> {ok:true}
  - history_fetch({projectRoot, dialog, recentTurns?}) -> {messages:[{role,text,ts}]}
  - history_save({projectRoot, dialog, entry:{role:'user'|'assistant',text,ts?}}) -> {ok:true}
  - history_clear({projectRoot, dialog}) -> {ok:true}

- Conventions
  - projectRoot = <ABS_PROJECT_ROOT>
  - Tool returns are in the first text content item; use JSON.parse(content[0].text)

- Session initialization (do once)
  - First call history_list_dialogs to select a dialog
  - Then call history_get_summary + history_fetch(6)

- Save policy (low-frequency; thresholds adjustable verbally)
  - Only call save tools in these cases; otherwise call nothing:
    - Important answers: the reply includes structured headings like “Decisions/Constraints/TODO/Issues/Refs” → save immediately
    - Turn cap K: after every K assistant turns (default K=5)
    - Byte cap B: when accumulated unsaved text ≥ B (default B=48KB)
    - Manual: when the user says “save”/“sync”
  - When saving:
    - Call history_save in chronological order for all messages since the last save (batch)
    - Summary throttling: call history_set_summary only on “important saves” or every M-th save (default M=3; ~700 tokens, organized by Decisions/Constraints/TODO/Issues/Facts/Refs)
  - Any tool failure: do not interrupt the conversation; skip saving for this round
```

## Notes
- Tool functions implemented: `history.fetch`, `history.save`, `history.getSummary`, `history.setSummary`, `history.clear`.
- Storage layout per session: `messages.json` (rolling raw turns), `summary.json` (structured JSON string).
- For quick inspection, set `CODEX_HISTORY_ROOT=/tmp/codex_history` before `pnpm start`.

## License
Licensed under the Apache License, Version 2.0. See `LICENSE` for details.

 
