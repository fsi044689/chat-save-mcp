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
  - history_set_summary({projectRoot, dialog, summary, mode?:'merge'|'replace'}) -> {ok:true, mode}
  - history_get_dialog_detail({projectRoot, dialog, recentTurns?, format?, includeSummary?, includeMessages?}) ->
    - default format:'flat' returns RAW STRING: first optional `M:<compact-json-maintenance>`, then optional `S:<compact-json-summary>`, then `U:/A:` lines
    - format:'json' returns JSON: { summary?, messages?, maintenance? } (fields present per include flags)
  - history_save({projectRoot, dialog, entry?:{role:'user'|'assistant',text,ts?}, entries?:[{role:'user'|'assistant',text,ts?},...]}) -> {ok:true, saved}
  - history_clear({projectRoot, dialog}) -> {ok:true}
  - history_stats({projectRoot, dialog}) -> {messages, approxBytes, lastTs, backups, thresholds}
  - history_list_backups({projectRoot, dialog}) -> {backups:[{id,mtime,files}]}
  - history_restore_backup({projectRoot, dialog, id}) -> {ok:true, restored}
  - history_get_messages_since({projectRoot, dialog, sinceTs?, limit?}) -> {messages}

- Conventions
  - projectRoot = <ABS_PROJECT_ROOT>
  - Returns are in the first text content item. Default query returns flat RAW STRING: first optional M:<json>, then optional S:<json>, then U:/A lines. Use format:'json' to get JSON.
  - Partial queries: pass includeSummary:false or includeMessages:false to fetch only what's needed.
  - Flat format escaping: multi-line message text is escaped as `\n`/`\r` in `U:/A:` lines.
  - Summary updates: default is mode:"merge" to preserve prior highlights; use mode:"replace" only for intentional reset.

- Session initialization (do once)
  - First call history_list_dialogs to select a dialog
  - Then call history_get_dialog_detail({recentTurns:6}) to get both summary + minimal-size context in one shot (defaults include both)
  - Loop usage (simple): track the last seen `ts` and call `history_get_messages_since({sinceTs:lastTs, limit:50})` for incremental pulls. Keep logic minimal.
  - Periodic maintenance check: every K=5 turns or ~10 minutes, call `history_get_dialog_detail({recentTurns:6})` and check for maintenance (flat `M:` or JSON `maintenance`). If present, run compaction as below.
  - Tip: whenever compaction is needed, you MUST base your new summary on the detail result (both S: summary JSON and U:/A: message lines), not only on the latest live turns.
  - Later, when you only need either messages or summary, call history_get_dialog_detail with include flags to reduce tokens

- Save policy (low-frequency; thresholds adjustable verbally)
  - Only call save tools in these cases; otherwise call nothing:
    - Important answers: the reply includes structured headings like “Decisions/Constraints/TODO/Issues/Refs” → save immediately
    - Turn cap K: after every K assistant turns (default K=5)
    - Byte cap B: when accumulated unsaved text ≥ B (default B=48KB)
    - Manual: when the user says “save”/“sync”
  - When saving:
    - Prefer batch: use history_save({entries:[...]}) in chronological order to avoid many single calls
    - Summary throttling: call history_set_summary only on “important saves” or every M-th save (default M=3; ~700 tokens, organized by Decisions/Constraints/TODO/Issues/Facts/Refs)
  - Any tool failure: do not interrupt the conversation; skip saving for this round

- The server will signal when history exceeds a comfortable context size via history_get_dialog_detail:

  - Flat (default): first line may be `M:<compact-json-maintenance>` like `M:{"action":"compact","reason":"bytes_exceed_comfort_zone",...}`
  - JSON: response includes a `maintenance` field, e.g.
  {
    "summary": "...optional...",
    "messages": [{"role":"user","text":"...","ts":...}, ...],
    "maintenance": {
      "action": "compact",
      "importance": "high",
      "reason": "messages_count_exceeds_comfort_zone" | "bytes_exceed_comfort_zone",
      "guidance": "First, synthesize a NEW summary that incorporates BOTH the S: summary line and all U:/A: message lines from the detail result; then call history_clear (backup-enabled), history_set_summary({mode:'merge'}) to write it; finally batch re-seed essentials via history_save({entries:[...]}): entries MUST be selected from the detail's U:/A: lines (optionally minimally merged/rephrased), NOT only from newly produced conversation.",
      "thresholds": { "maxMessages": 200, "maxBytes": 65536 },
      "metrics": { "messages": 321, "approxBytes": 91234 },
      "backup": { "enabled": true, "retention": 5 }
    }
  }


  Compaction procedure: `history_clear` → `history_set_summary({mode:'merge'})` → batch `history_save({entries:[...]})` of essential turns only.

  Environment overrides:
  - `HISTORY_CONTEXT_MAX_MESSAGES` (default 200)
  - `HISTORY_CONTEXT_MAX_BYTES` (default 65536)
  - `HISTORY_BACKUP_RETENTION` (default 5)

Additional notes:
- `history_save` accepts optional `meta` per entry for cross-agent/model attribution and is stored alongside messages.
- All writes are atomic; per-dialog mutex serializes concurrent writes to avoid interleaving.

  `history_clear` performs a backup to `<DIALOG>/backups/<timestamp>_<rand>/` and prunes old backups, keeping at most the configured retention.
```

### Minimal Prompt (copy‑paste)
```text
AGENT RULES:
USE MCP TOOL name=history.
RETURNS: Default query (flat) returns RAW STRING: first optional M:<compact-json-maintenance>, then optional S:<compact-json-summary>, then U:/A: lines. Multi-line text is escaped as "\n"/"\r" in flat. Pass format:'json' for {summary?,messages?,maintenance?}. Use includeSummary/includeMessages to partially query.
INIT: history_list_dialogs({projectRoot}); history_get_dialog_detail({projectRoot,dialog,recentTurns:6}).
LOOP: Track last ts → only call history_get_messages_since({projectRoot,dialog,sinceTs:lastTs,limit:50}); every K=5 turns or ~10min call history_get_dialog_detail({recentTurns:6}) to check for M:/maintenance.
MAINTENANCE: When M:/maintenance appears, do: synthesize NEW summary from THIS detail (S + U/A lines) → history_clear → history_set_summary({mode:'merge'}) → batch history_save essential turns selected FROM THIS detail's U/A lines (optionally minimally merged). Do not re-seed only new conversation.
SAVE POLICY: trigger on important|every K=5|unsaved bytes>=B=49152|user says save; prefer batch history_save; call history_set_summary({mode:'merge'}) on important or every M=3 saves.
NOTES: Any tool failure should not interrupt the conversation — skip the round. history_clear creates backups under .chat-history/<dialog>/backups/ keeping latest 5.
TOOLS: history_list_dialogs; history_get_dialog_detail; history_get_messages_since; history_save; history_set_summary(mode:'merge'); history_clear; history_stats; history_list_backups; history_restore_backup.
```

## Notes
- Tool functions implemented: `history_get_dialog_detail` (alias: `history_fetch`), `history_save` (batch supported), `history_set_summary` (merge default), `history_clear`, `history_list_dialogs`.
- Storage layout per session: `messages.json` (rolling raw turns), `summary.json` (structured JSON string).
- For quick inspection, set `CODEX_HISTORY_ROOT=/tmp/codex_history` before `pnpm start`.

## License
Licensed under the Apache License, Version 2.0. See `LICENSE` for details.

 
