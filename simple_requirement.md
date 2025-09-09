是的——让模型来做压缩更合理，MCP 只负责存取。
思路：把 MCP 做成“傻存储”（不做任何摘要逻辑），而把“滚动摘要/精简上下文”的工作交给 Codex 本身通过提示词完成。这样你继续只用 Codex 的 CLI/IDE 插件 + 一个极简 MCP，就能得到“AI 生成的高质量摘要 + 最近原文”的上下文管理。

下面给你两块内容：
	1.	一段可直接放进 Codex 的 系统指令（让模型自己做摘要并调用 MCP 存/取）；
	2.	一个超简 MCP（仅读写 summary 与消息，不做硬编码规则）。

⸻

1) 放进 Codex 的系统指令（让模型负责摘要）

把下面整段粘到 Codex 的“System Prompt / 前置上下文”：

You can call an MCP tool named `history` with these functions:
- history.getSummary({sessionId: string}) -> {summary: string | null}
- history.setSummary({sessionId: string, summary: string}) -> {ok: true}
- history.fetch({sessionId: string, recentTurns?: number}) -> {messages: Array<{role: "user"|"assistant", text: string, ts: number}>}
- history.save({sessionId: string, entry: {role: "user"|"assistant", text: string}}) -> {ok: true}
- history.clear({sessionId: string}) -> {ok: true}

Conversation Memory Policy (LLM-managed):
1) On every user turn:
   a) Call history.getSummary({ sessionId: <ABS_PROJECT_ROOT> }) to retrieve the rolling summary (may be empty).
   b) Call history.fetch({ sessionId: <ABS_PROJECT_ROOT>, recentTurns: 6 }) to get a small recent window.
   c) Use {summary + recent} as working context (target <= 2048 tokens).

2) After producing your final answer, update memory:
   a) Call history.save({ sessionId, entry: { role: "user", text: <USER_MESSAGE> }})
   b) Call history.save({ sessionId, entry: { role: "assistant", text: <YOUR_FINAL_ANSWER> }})
   c) Recompute the rolling summary:
      - Summarize only the NEW exchange against the EXISTING summary.
      - Keep the summary concise and structured with this JSON schema:

        {
          "version": 1,
          "decisions": [ "..." ],
          "constraints": [ "..." ],
          "todos": [ "..." ],
          "issues": [ "..." ],
          "facts": [ "..." ],
          "refs": [ { "type": "file|api|url", "value": "path/or/name", "hint": "short explanation" } ]
        }

      - Rules:
        * Prefer abstractions (e.g., function/class/file names, error codes, config keys) over long code blocks.
        * Merge duplicates; keep items atomic, imperative and testable.
        * Keep under ~700 tokens (truncate the least important).
        * Do NOT lose irreversible decisions or open TODO/ISSUE items.

   d) Call history.setSummary({ sessionId, summary: <UPDATED_JSON_STRING> })

3) If any tool fails, continue gracefully without memory.

要点：模型每轮先取 summary + 最近原文作为上下文，回答后由模型自己改写/合并成结构化 JSON 摘要并存回去。这样“压缩策略”是 AI 驱动的，不是硬编码。

⸻

2) 极简 MCP（只存取，不做摘要）

功能：
	•	getSummary / setSummary：读写滚动摘要（JSON 字符串）；
	•	fetch：取最近 K 条原文；
	•	save：追加一条原文；
	•	clear：清空会话文件。

目录：~/.codex_history/<hash>/summary.json 与 messages.json

package.json

{
  "name": "mcp-history-store",
  "version": "0.1.0",
  "type": "module",
  "bin": { "mcp-history-store": "dist/index.js" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.3.0",
    "mkdirp": "^3.0.1"
  },
  "devDependencies": { "esbuild": "^0.23.0" },
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js",
    "start": "node dist/index.js --stdio"
  }
}

src/index.ts

import { StdioServerTransport, Server } from "@modelcontextprotocol/sdk/server";
import fs from "fs"; import path from "path"; import crypto from "crypto"; import mkdirp from "mkdirp";

const HOME = process.env.HOME || process.env.USERPROFILE || ".";
const ROOT = path.join(HOME, ".codex_history"); mkdirp.sync(ROOT);
const dirFor = (sid: string) => { const h = crypto.createHash("sha1").update(sid).digest("hex").slice(0,16);
  const d = path.join(ROOT, h); mkdirp.sync(d); return d; };
const pMsg = (sid: string)=> path.join(dirFor(sid),"messages.json");
const pSum = (sid: string)=> path.join(dirFor(sid),"summary.json");

const readJSON = (p: string, def: any)=> fs.existsSync(p)? JSON.parse(fs.readFileSync(p,"utf8")||"null") ?? def : def;
const writeJSON = (p: string, v: any)=> fs.writeFileSync(p, JSON.stringify(v,null,2), "utf8");

const transport = new StdioServerTransport();
const server = new Server({ name: "mcp-history-store", version: "0.1.0" }, { capabilities: { tools: {} } });

// fetch recent messages
server.tool("history.fetch", {
  description: "Fetch recent raw messages",
  inputSchema: { type:"object", properties:{ sessionId:{type:"string"}, recentTurns:{type:"number",default:6} }, required:["sessionId"] },
  handler: async (input:any)=>{
    const {sessionId, recentTurns=6} = input;
    const arr = readJSON(pMsg(sessionId), []);
    return { messages: arr.slice(-recentTurns) };
  }
});

// save one entry
server.tool("history.save", {
  description: "Append one message",
  inputSchema: { type:"object",
    properties:{ sessionId:{type:"string"},
      entry:{ type:"object", properties:{ role:{type:"string","enum":["user","assistant"]}, text:{type:"string"}, ts:{type:"number"} }, required:["role","text"] } },
    required:["sessionId","entry"]
  },
  handler: async (input:any)=>{
    const { sessionId, entry } = input;
    const arr = readJSON(pMsg(sessionId), []);
    arr.push({ ...entry, ts: entry.ts ?? Date.now() });
    if (arr.length > 300) arr.splice(0, arr.length - 300); // 软上限
    writeJSON(pMsg(sessionId), arr);
    return { ok:true };
  }
});

// get summary
server.tool("history.getSummary", {
  description: "Get rolling summary JSON string",
  inputSchema: { type:"object", properties:{ sessionId:{type:"string"} }, required:["sessionId"] },
  handler: async (input:any)=>{
    const { sessionId } = input;
    if (!fs.existsSync(pSum(sessionId))) return { summary: null };
    return { summary: fs.readFileSync(pSum(sessionId), "utf8") };
  }
});

// set summary
server.tool("history.setSummary", {
  description: "Set rolling summary JSON string",
  inputSchema: { type:"object", properties:{ sessionId:{type:"string"}, summary:{type:"string"} }, required:["sessionId","summary"] },
  handler: async (input:any)=>{
    const { sessionId, summary } = input;
    writeJSON(pSum(sessionId), summary);
    return { ok:true };
  }
});

// clear
server.tool("history.clear", {
  description: "Clear session files",
  inputSchema: { type:"object", properties:{ sessionId:{type:"string"} }, required:["sessionId"] },
  handler: async (input:any)=>{
    for (const p of [pMsg(input.sessionId), pSum(input.sessionId)]) { if (fs.existsSync(p)) fs.unlinkSync(p); }
    return { ok:true };
  }
});

await server.connect(transport);

使用步骤

mkdir mcp-history-store && cd mcp-history-store
# 写入上面的 package.json 与 src/index.ts
npm i
npm run build
# 在 Codex 的 MCP 工具列表中添加：
# Command: mcp-history-store --stdio
# Name: history  (名称最好就叫 history，和系统提示一致)


⸻

为什么这更合理
	•	摘要质量：让模型基于当前问答 + 既有摘要做“增量合并”，比正则/启发式更稳，且能跨语言/多技术域。
	•	可演进：你可以直接在系统指令里微调“结构 JSON、压缩预算、优先级”，无需改 MCP 代码。
	•	安全与可控：MCP 不碰模型，也不联网，只管本地读写；你的代码/隐私不被长时间“黑盒存储”。

⸻

如果你愿意，我可以再给你：
	•	一个**“更严”的摘要模板**（例如把 decisions/constraints/todos 强制写成动词+对象+验收标准）；
	•	或者把“最近 K 轮”按token 预算动态决定（模型先拿 summary，再逐条向后拼最近消息，超过预算即止）的提示词。

要不要我基于你常用的技术栈（Java/Spring/MyBatis/Redis/Nacos/Cloudflare）把 示例 JSON 摘要填充几条模板句式，直接可用？