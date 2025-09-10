# MCP History Store（中文）

一个最小的 Model Context Protocol (MCP) 服务器，提供本地文件存储对话历史与“滚动摘要”。摘要由模型（LLM）负责生成，本服务只负责存取。

- Node 版本：20+
- 包管理器：pnpm 9+

## 快速开始
- 安装依赖：`pnpm install`
- 构建：`pnpm build`
- 运行（stdio）：`pnpm start`
- 在 Codex CLI 注册 MCP 工具：
  - 名称：`history`
  - 命令：`node /绝对路径/chat-save-mcp/dist/index.js --stdio`
  - 可选环境变量：`CODEX_HISTORY_ROOT=/your/base`（不设置则以项目根为基准）

存储路径（按项目与对话隔离）：`<PROJECT_ROOT>/.chat-history/<DIALOG>/{messages.json, summary.json}`。

## Agent 集成（必须）

## 系统提示词（粘贴到 Codex 的 AGENTS.md 或 其他设置 agent 提示词的地方）
```text
##Agent 必须使用本 MCP 的 `history` 工具来管理会话的“对话历史与结构化摘要”。
- MCP 工具名：history（以下为工具名称）
  - history_list_dialogs({projectRoot}) -> {dialogs}
  - history_set_summary({projectRoot, dialog, summary, mode?:'merge'|'replace'}) -> {ok:true, mode}
  - history_get_dialog_detail({projectRoot, dialog, recentTurns?, format?, includeSummary?, includeMessages?}) ->
    - 默认 format:'flat' 返回纯文本：首行可选 `M:<紧凑JSON维护信息>`，其后可选 `S:<紧凑JSON摘要>`，随后 `U:/A:` 行
    - 传 format:'json' 时返回 JSON：{ summary?, messages?, maintenance? }（字段是否出现由 include* 参数决定）
  - history_save({projectRoot, dialog, entry?:{role:'user'|'assistant',text,ts?}, entries?:[{role:'user'|'assistant',text,ts?},...]}) -> {ok:true, saved}
  - history_clear({projectRoot, dialog}) -> {ok:true}
  - history_stats({projectRoot, dialog}) -> {messages, approxBytes, lastTs, backups, thresholds}
  - history_list_backups({projectRoot, dialog}) -> {backups:[{id,mtime,files}]}
  - history_restore_backup({projectRoot, dialog, id}) -> {ok:true, restored}
  - history_get_messages_since({projectRoot, dialog, sinceTs?, limit?}) -> {messages}

- 约定
  - projectRoot = <ABS_PROJECT_ROOT>
  - 返回位于第一个 text 内容项。默认查询返回纯文本（flat）；如需 JSON 结构可传 format:'json' 获取 {summary?,messages?,maintenance?}。
  - 支持部分查询：通过 includeSummary:false 或 includeMessages:false，仅取所需内容以节省 tokens。
  - 平铺转义：多行消息在 `U:/A:` 行内会将换行输出为 `\n`（以及 `\r`）。
  - 更新摘要：默认使用 mode:"merge" 以保留既有重点；仅当需要重置时才用 mode:"replace"。

- 会话初始化（只做一次）
  - 先 history_list_dialogs 选定 dialog
  - 然后 history_get_dialog_detail({recentTurns:6})（默认 flat）一次性获取“摘要+最小体量上下文”（默认同时包含两者）
  - 循环使用（保持简单）: 记录上次看到的 `ts`，之后仅用 `history_get_messages_since({sinceTs:lastTs, limit:50})` 增量拉取。
  - 周期性检查维护: 每 K=5 轮或每 10 分钟，调用一次 `history_get_dialog_detail({recentTurns:6})` 检查是否返回 `M:`/`maintenance`；若出现则执行维护流程（见下）。
  - 提示：任何需要“压缩/重组”时，必须以 detail 返回的数据为准进行“总结与回灌”，包括且不限于：
    - S: 行中的 JSON 摘要内容（若有）
    - U:/A: 行中的历史消息文本（若有；这些行将直接决定回灌用的 entries 内容）
  - 后续当仅需要“消息”或仅需要“摘要”时，可用 include* 参数做精确查询，减少上下文体量

- 保存策略（低频、可口头修改阈值）
  - 仅以下情况调用保存，否则不调用任何工具：
    - 重要回答：答案含“决策/约束/TODO/ISSUE/引用”等小节标题或明显结构化信号 → 立即保存
    - 回合上限 K：每满 K 个助手回合保存一次（默认 K=5）
    - 字节上限 B：累计未保存文本 ≥ B 立即保存（默认 B=48KB）
    - 手动：用户说“保存/同步”时立即保存
  - 执行保存时：
    - 优先使用“批量”：history_save({entries:[...]}) 按时间顺序回灌“必要/关键”的历史消息；entries 的来源必须是本次 detail 的 U:/A: 行（不是只包含清理后的新对话）
    - 摘要节流：仅在“重要保存”或每满 M 次保存后调用一次 history_set_summary（默认 M=3；~700 tokens，按决策/约束/TODO/ISSUE/事实/引用组织）
  - 任何工具失败：不中断对话，直接跳过保存本次

- 当对话历史超出“上下文舒适区”时，由 `history_get_dialog_detail` 返回维护信息，提示 Agent 进行压缩整理：

  - flat（默认）返回：首行会出现 `M:<紧凑JSON维护信息>`，例如：
    `M:{"action":"compact","reason":"bytes_exceed_comfort_zone",...}`
  - json 返回：在结果对象中包含 `maintenance` 字段，例如：
  {
    "summary": "...可选...",
    "messages": [ {"role":"user","text":"...","ts":...}, ... ],
    "maintenance": {
      "action": "compact",
      "importance": "high",
      "reason": "messages_count_exceeds_comfort_zone" | "bytes_exceed_comfort_zone",
      "guidance": "先进行总结：必须基于本次 detail 返回的 S 摘要与 U/A 历史消息共同生成‘新的全量摘要’；然后依次调用 history_clear（会自动备份）、history_set_summary({mode:'merge'}) 写入新摘要；最后用 history_save({entries:[...]}) 批量回灌：entries 必须从 detail 的 U:/A: 行中挑选（或经最小合并重述）而来，不得只包含此次清理后的新对话。",
      "thresholds": { "maxMessages": 200, "maxBytes": 65536 },
      "metrics": { "messages": 321, "approxBytes": 91234 },
      "backup": { "enabled": true, "retention": 5 }
    }
  }


  落盘压缩建议流程：`history_clear` → `history_set_summary({mode:'merge'})` → 使用 `history_save({entries:[...]})` 批量回灌“仅核心/必要”的历史消息。

  环境变量（可覆盖默认）：
  - `HISTORY_CONTEXT_MAX_MESSAGES`（默认 200）
  - `HISTORY_CONTEXT_MAX_BYTES`（默认 65536）
  - `HISTORY_BACKUP_RETENTION`（默认 5）

`history_clear` 会将现有 `messages.json`/`summary.json` 备份到 `<DIALOG>/backups/<timestamp>_<rand>/`，并只保留最近 N 份（按 `retention`）。

其他说明：
- `history_save` 支持可选 `meta` 字段，便于记录 agent/model 等归因信息。
- 写入采用原子写与对话级互斥，避免并发写入时的交错与半写。
```

### 最小提示词（运行时粘贴，精简但不丢维护逻辑）
```text
AGENT 规则: 必须使用 MCP 工具 history。
初始化: history_list_dialogs({projectRoot}); history_get_dialog_detail({projectRoot,dialog,recentTurns:6}).
循环: 记录 lastTs → 仅调用 history_get_messages_since({projectRoot,dialog,sinceTs:lastTs,limit:50}) 做增量；每 K=5 轮或每 10 分钟调用一次 history_get_dialog_detail({recentTurns:6}) 检查是否返回 M:/maintenance。
维护: 仅当出现维护信号(M: 或 maintenance)时执行：基于“本次 detail”的 S+U/A 合成新摘要 → history_clear → history_set_summary({mode:'merge'}) → 从“本次 detail 的 U/A 行”挑选必要消息按时间顺序 history_save 回灌；不得只回灌新对话。
保存: 触发=重要|每K=5|未保存字节≥B=49152|用户“保存”；执行=优先批量 history_save；摘要 history_set_summary({mode:'merge'}) 每 M=3 次。
注意: flat 中多行以 \n/\r 转义；按需使用 includeSummary/includeMessages 做部分查询；任一工具失败直接跳过本轮维护/保存。
```

## 注意事项
- 工具离线、确定性；不进行网络调用。
- 写入采用原子方式，避免半写损坏。
- `summary.json` 若为历史双重转义格式，服务器在读取时会自动修复并回写为标准 JSON。

## 许可证
本项目采用 Apache-2.0 协议授权，详见 `LICENSE` 文件。
