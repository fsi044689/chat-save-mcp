import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { mkdirpSync } from "mkdirp";
import { z } from "zod";

const SUBDIR = ".chat-history"; // hidden folder in project root
const ROOT_OVERRIDE = process.env.CODEX_HISTORY_ROOT; // optional override for base dir (testing)

const safeName = (s: string) =>
  (s || "default")
    .replace(/[\\/:"*?<>|]+/g, "_")
    .replace(/\s+/g, "-")
    .slice(0, 64)
    .toLowerCase();

const resolveDialogDir = (projectRoot: string, dialog: string) => {
  const base = ROOT_OVERRIDE ? path.resolve(ROOT_OVERRIDE) : path.resolve(projectRoot);
  const d = path.join(base, SUBDIR, safeName(dialog));
  mkdirpSync(d);
  return d;
};

const pMsg = (projectRoot: string, dialog: string) =>
  path.join(resolveDialogDir(projectRoot, dialog), "messages.json");
const pSum = (projectRoot: string, dialog: string) =>
  path.join(resolveDialogDir(projectRoot, dialog), "summary.json");

const readJSON = <T>(p: string, def: T): T => {
  if (!fs.existsSync(p)) return def;
  try {
    const raw = fs.readFileSync(p, "utf8");
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    return (parsed ?? def) as T;
  } catch {
    return def;
  }
};
const writeJSON = (p: string, v: unknown) => {
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
};

const transport = new StdioServerTransport();
const server = new McpServer(
  { name: "mcp-history-store", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// history.fetch — Fetch recent raw messages
server.registerTool(
  "history_fetch",
  {
    description: "Fetch recent raw messages",
    inputSchema: {
      projectRoot: z.string(),
      dialog: z.string(),
      recentTurns: z.number().optional(),
    },
  },
  async ({ projectRoot, dialog, recentTurns = 6 }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    const arr = readJSON<any[]>(pMsg(root, dlg), []);
    const result = { messages: arr.slice(-recentTurns) };
    return { content: [{ type: "text", text: JSON.stringify(result) }] } as any;
  }
);

// history.save — Append one message
server.registerTool(
  "history_save",
  {
    description: "Append one message",
    inputSchema: {
      projectRoot: z.string(),
      dialog: z.string(),
      entry: z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string(),
        ts: z.number().optional(),
      }),
    },
  },
  async ({ projectRoot, dialog, entry }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    const arr = readJSON<any[]>(pMsg(root, dlg), []);
    arr.push({ ...entry, ts: entry?.ts ?? Date.now() });
    if (arr.length > 300) arr.splice(0, arr.length - 300);
    writeJSON(pMsg(root, dlg), arr);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } as any;
  }
);

// history.getSummary — Get rolling summary JSON string
server.registerTool(
  "history_get_summary",
  {
    description: "Get rolling summary JSON string",
    inputSchema: { projectRoot: z.string(), dialog: z.string() },
  },
  async ({ projectRoot, dialog }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    const sumPath = pSum(root, dlg);
    let summary: string | null = fs.existsSync(sumPath) ? fs.readFileSync(sumPath, "utf8") : null;

    // Auto-repair legacy double-encoded files: file contains a JSON string of JSON
    if (summary != null) {
      try {
        const outer = JSON.parse(summary);
        if (typeof outer === "string") {
          // outer was a JSON string; try to parse inner JSON and pretty-write back
          try {
            const innerParsed = JSON.parse(outer);
            const pretty = JSON.stringify(innerParsed, null, 2);
            summary = pretty;
            try {
              fs.writeFileSync(sumPath, pretty, "utf8");
            } catch {}
          } catch {}
        }
      } catch {
        // not JSON.parse-able; leave as-is
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ summary }) }] } as any;
  }
);

// history.setSummary — Set rolling summary JSON string
server.registerTool(
  "history_set_summary",
  {
    description: "Set rolling summary JSON string",
    inputSchema: {
      projectRoot: z.string(),
      dialog: z.string(),
      summary: z.string(),
    },
  },
  async ({ projectRoot, dialog, summary }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    // Validate and pretty-write raw JSON to avoid double-encoding/escaping
    try {
      const pretty = JSON.stringify(JSON.parse(summary), null, 2);
      fs.writeFileSync(pSum(root, dlg), pretty, "utf8");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } as any;
    } catch (e: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: "Invalid JSON for summary", detail: String(e?.message ?? e) }),
          },
        ],
      } as any;
    }
  }
);

// history.clear — Clear session files
server.registerTool(
  "history_clear",
  {
    description: "Clear session files",
    inputSchema: { projectRoot: z.string(), dialog: z.string() },
  },
  async ({ projectRoot, dialog }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    for (const p of [pMsg(root, dlg), pSum(root, dlg)]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } as any;
  }
);

// history.listDialogs — List existing dialogs for a project
server.registerTool(
  "history_list_dialogs",
  {
    description: "List dialog names under the project's hidden history directory",
    inputSchema: { projectRoot: z.string() },
  },
  async ({ projectRoot }) => {
    const root = projectRoot ?? (undefined as any);
    const base = ROOT_OVERRIDE ? path.resolve(ROOT_OVERRIDE) : path.resolve(root);
    const hidden = path.join(base, SUBDIR);
    let dialogs: string[] = [];
    if (fs.existsSync(hidden)) {
      try {
        const entries = fs.readdirSync(hidden, { withFileTypes: true });
        dialogs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      } catch {}
    }
    return { content: [{ type: "text", text: JSON.stringify({ dialogs }) }] } as any;
  }
);

await server.connect(transport);
