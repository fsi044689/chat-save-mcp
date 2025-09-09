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

## 系统提示词（粘贴到 Codex 的 System Prompt）
```text
- MCP 工具名：history（以下为工具名称）
  - history_list_dialogs({projectRoot}) -> {dialogs}
  - history_get_summary({projectRoot, dialog}) -> {summary|null}
  - history_set_summary({projectRoot, dialog, summary}) -> {ok:true}
  - history_fetch({projectRoot, dialog, recentTurns?}) -> {messages:[{role,text,ts}]}
  - history_save({projectRoot, dialog, entry:{role:'user'|'assistant',text,ts?}}) -> {ok:true}
  - history_clear({projectRoot, dialog}) -> {ok:true}

- 约定
  - projectRoot = <ABS_PROJECT_ROOT>
  - 工具返回在第一个 text 内容项里，需 JSON.parse(content[0].text)

- 会话初始化（只做一次）
  - 先 history_list_dialogs 选定 dialog
  - 然后 history_get_summary + history_fetch(6)

- 保存策略（低频、可口头修改阈值）
  - 仅以下情况调用保存，否则不调用任何工具：
    - 重要回答：答案含“决策/约束/TODO/ISSUE/引用”等结构化信号 → 立即保存
    - 回合上限 K：每满 K 个助手回合保存一次（默认 K=5）
    - 字节上限 B：累计未保存文本 ≥ B 立即保存（默认 B=48KB）
    - 手动：用户说“保存/同步”时立即保存
  - 执行保存时：
    - 依次调用 history_save 写入自上次保存以来的全部消息（批量，按时间顺序）
    - 摘要节流：仅在“重要保存”或每满 M 次保存后调用一次 history_set_summary（默认 M=3；~700 tokens，按 决策/约束/TODO/ISSUE/事实/引用 组织）
  - 任一工具失败：不中断对话，直接跳过本次保存
```

## 注意事项
- 工具离线、确定性；不进行网络调用。
- 写入采用原子方式，避免半写损坏。
- `summary.json` 若为历史双重转义格式，服务器在读取时会自动修复并回写为标准 JSON。
