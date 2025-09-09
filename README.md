# MCP History Store

[中文说明 / Chinese README](README.zh-CN.md)

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

## System Prompt (copy‑paste into Codex)
```text
- MCP 工具名：history（以下为工具名称，已改为下划线以满足 ^[a-zA-Z0-9_-]+$）
  - history_list_dialogs({projectRoot}) -> {dialogs}
  - history_get_summary({projectRoot, dialog}) -> {summary|null}
  - history_set_summary({projectRoot, dialog, summary}) -> {ok:true}
  - history_fetch({projectRoot, dialog, recentTurns?}) -> {messages:[{role,text,ts}]}
  - history_save({projectRoot, dialog, entry:{role:'user'|'assistant',text,ts?}}) -> {ok:true}
  - history_clear({projectRoot, dialog}) -> {ok:true}

- 约定
  - projectRoot = <ABS_PROJECT_ROOT>
  - 工具返回在第一个 text 内容项里，需 JSON.parse(content[0].text)

- 对话名策略
  - 维护工作变量 dialog
  - 新任务且无活动对话：
    1) {dialogs}=JSON.parse(call history_list_dialogs({projectRoot}))
    2) 让用户选已有对话作为后续基准；若无，让用户给定新对话名：短横线小写 ≤40 字（如 refactor-message-store）
  - 后续轮次复用该 dialog

- 新对话读取记忆
  - {summary}=JSON.parse(call history_get_summary({projectRoot, dialog}))
  - {messages}=JSON.parse(call history_fetch({projectRoot, dialog, recentTurns:6}))
  - 回答时将 summary+messages 作为权威历史（无需用户提示）

- 重要回答后自动写回
  - call history_save({projectRoot, dialog, entry:{role:'user', text:<USER_MESSAGE>}})
  - call history_save({projectRoot, dialog, entry:{role:'assistant', text:<FINAL_ANSWER>}})
  - 基于“旧 summary + 本轮新问答”增量重写 summary，结构：
    {version:1, decisions:[], constraints:[], todos:[], issues:[], facts:[], refs:[{type:'file|api|url',value,hint}]}
    规则：偏抽象标识，去重，~700 tokens，勿丢决策/TODO/ISSUE
  - call history_set_summary({projectRoot, dialog, summary:<JSON_STRING>})
  - 任一工具失败：不中断作答，仅跳过记忆流程
```

## Notes
- Tool functions implemented: `history.fetch`, `history.save`, `history.getSummary`, `history.setSummary`, `history.clear`.
- Storage layout per session: `messages.json` (rolling raw turns), `summary.json` (structured JSON string).
- For quick inspection, set `CODEX_HISTORY_ROOT=/tmp/codex_history` before `pnpm start`.

 
