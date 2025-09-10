import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { mkdirpSync } from "mkdirp";
import { z } from "zod";

const SUBDIR = ".chat-history"; // hidden folder in project root
const ROOT_OVERRIDE = process.env.CODEX_HISTORY_ROOT; // optional override for base dir (testing)
const MAX_CONTEXT_BYTES = Number.parseInt(process.env.HISTORY_CONTEXT_MAX_BYTES || "65536"); // 64KB default
const MAX_CONTEXT_MESSAGES = Number.parseInt(process.env.HISTORY_CONTEXT_MAX_MESSAGES || "200");
const BACKUP_RETENTION = Math.max(1, Number.parseInt(process.env.HISTORY_BACKUP_RETENTION || "5"));

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
// Atomic write: write to tmp file in same dir then rename
const writeFileAtomic = (targetPath: string, data: string | Buffer) => {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, ".tmp-" + crypto.randomBytes(6).toString("hex") + ".tmp");
  fs.writeFileSync(tmp, data, { encoding: typeof data === "string" ? "utf8" : undefined });
  fs.renameSync(tmp, targetPath);
};

const writeJSON = (p: string, v: unknown) => {
  writeFileAtomic(p, JSON.stringify(v, null, 2));
};

const fileSize = (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : 0);

export const readSummaryNormalized = (projectRoot: string, dialog: string): string | null => {
  const sumPath = pSum(projectRoot, dialog);
  if (!fs.existsSync(sumPath)) return null;
  let summary: string | null = null;
  try {
    summary = fs.readFileSync(sumPath, "utf8");
  } catch {
    return null;
  }
  if (summary != null) {
    try {
      const outer = JSON.parse(summary);
      if (typeof outer === "string") {
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
      // leave as-is
    }
  }
  return summary;
};

const checkComfort = (projectRoot: string, dialog: string) => {
  const msgPath = pMsg(projectRoot, dialog);
  const sumPath = pSum(projectRoot, dialog);
  const arr = readJSON<any[]>(msgPath, []);
  const bytes = fileSize(msgPath) + fileSize(sumPath);
  const overMsgs = arr.length > MAX_CONTEXT_MESSAGES;
  const overBytes = bytes > MAX_CONTEXT_BYTES;
  const needsCompaction = overMsgs || overBytes;
  const reason = overMsgs
    ? "messages_count_exceeds_comfort_zone"
    : overBytes
    ? "bytes_exceed_comfort_zone"
    : null;
  return {
    needsCompaction,
    reason,
    metrics: { messages: arr.length, approxBytes: bytes },
    thresholds: { maxMessages: MAX_CONTEXT_MESSAGES, maxBytes: MAX_CONTEXT_BYTES },
  } as const;
};

export const escFlatText = (s: string): string =>
  String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");

const transport = new StdioServerTransport();
const server = new McpServer(
  { name: "mcp-history-store", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Simple per-dialog in-process mutex to serialize writes
const dialogLocks = new Map<string, Promise<any>>();
export const runExclusive = async <T>(dialogKey: string, fn: () => Promise<T>): Promise<T> => {
  const prev = dialogLocks.get(dialogKey) ?? Promise.resolve();
  let resolveNext: (v: any) => void;
  const next = new Promise((r) => (resolveNext = r));
  dialogLocks.set(dialogKey, prev.then(() => next));
  // Ensure execution starts only after previous completes
  await prev;
  try {
    const result = await fn();
    resolveNext!(undefined);
    const tail = dialogLocks.get(dialogKey);
    if (tail === next) dialogLocks.delete(dialogKey);
    return result;
  } catch (e) {
    resolveNext!(undefined);
    const tail = dialogLocks.get(dialogKey);
    if (tail === next) dialogLocks.delete(dialogKey);
    throw e;
  }
};

// Shared handler for dialog detail (summary + messages)
const handleGetDialogDetail = async ({ projectRoot, dialog, recentTurns = 6, format = "flat", includeSummary = true, includeMessages = true }: any) => {
  const root = projectRoot ?? (undefined as any);
  const dlg = dialog ?? "default";
  const arr = readJSON<any[]>(pMsg(root, dlg), []);
  const slice = includeMessages ? arr.slice(-recentTurns) : [];
  const summaryPretty = includeSummary ? readSummaryNormalized(root, dlg) : null;

  // Compute comfort based on the actual returned content: slice + summary
  const sliceBytes = includeMessages ? Buffer.byteLength(JSON.stringify(slice)) : 0;
  const sumBytes = includeSummary ? Buffer.byteLength(summaryPretty ?? "") : 0;
  const overMsgs = includeMessages ? slice.length > MAX_CONTEXT_MESSAGES : false;
  const overBytes = sliceBytes + sumBytes > MAX_CONTEXT_BYTES;
  const needsCompaction = overMsgs || overBytes;
  const maintenance = needsCompaction
    ? {
        action: "compact",
        importance: "high",
        reason: overMsgs ? "messages_count_exceeds_comfort_zone" : "bytes_exceed_comfort_zone",
        guidance:
          "Summarize conversation, then call history_clear (backup-enabled), history_set_summary({mode:'merge'}) with the new summary, and re-seed essentials via history_save.",
        thresholds: { maxMessages: MAX_CONTEXT_MESSAGES, maxBytes: MAX_CONTEXT_BYTES },
        metrics: { messages: slice.length, approxBytes: sliceBytes + sumBytes },
        backup: { enabled: true, retention: BACKUP_RETENTION },
      }
    : undefined;

  if (format === "flat") {
    // raw text for LLM-only; include maintenance and summary as prefixed compact JSON lines
    const parts: string[] = [];
    if (maintenance) {
      try {
        parts.push(`M:${JSON.stringify(maintenance)}`);
      } catch {}
    }
    if (includeSummary && summaryPretty && summaryPretty.trim().length > 0) {
      let compact = summaryPretty;
      try {
        compact = JSON.stringify(JSON.parse(summaryPretty));
      } catch {}
      parts.push(`S:${compact}`);
    }
    if (includeMessages) {
      const esc = (s: string) =>
        String(s)
          .replace(/\\/g, "\\\\")
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r");
      for (const m of slice) parts.push(`${m.role === "user" ? "U" : "A"}: ${esc(m.text)}`);
    }
    return { content: [{ type: "text", text: parts.join("\n") }] } as any;
  }
  const result: any = {};
  if (includeSummary) result.summary = summaryPretty;
  if (includeMessages) result.messages = slice;
  if (maintenance) result.maintenance = maintenance;
  return { content: [{ type: "text", text: JSON.stringify(result) }] } as any;
};

// history.get_dialog_detail — preferred
server.registerTool(
  "history_get_dialog_detail",
  {
    description: "Get recent summary + messages (flat by default)",
    inputSchema: {
      projectRoot: z.string(),
      dialog: z.string(),
      recentTurns: z.number().optional(),
      format: z.enum(["json", "flat"]).optional(),
      includeSummary: z.boolean().optional(),
      includeMessages: z.boolean().optional(),
    },
  },
  handleGetDialogDetail
);

// history.fetch — deprecated alias
server.registerTool(
  "history_fetch",
  {
    description: "[DEPRECATED] Use history_get_dialog_detail instead",
    inputSchema: {
      projectRoot: z.string(),
      dialog: z.string(),
      recentTurns: z.number().optional(),
      format: z.enum(["json", "flat"]).optional(),
      includeSummary: z.boolean().optional(),
      includeMessages: z.boolean().optional(),
    },
  },
  handleGetDialogDetail
);

// history.save — Append one message
server.registerTool(
  "history_save",
  {
    description: "Append message(s)",
    inputSchema: {
      projectRoot: z.string(),
      dialog: z.string(),
      entry: z
        .object({
          role: z.enum(["user", "assistant"]),
          text: z.string(),
          ts: z.number().optional(),
          meta: z.record(z.any()).optional(),
        })
        .optional(),
      entries: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            text: z.string(),
            ts: z.number().optional(),
            meta: z.record(z.any()).optional(),
          })
        )
        .optional(),
    },
  },
  async ({ projectRoot, dialog, entry, entries }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    const key = `${root}::${dlg}`;
    return runExclusive(key, async () => {
      const arr = readJSON<any[]>(pMsg(root, dlg), []);
      const toAppend: any[] = [];
      if (entries && Array.isArray(entries)) {
        let baseTs = Date.now();
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          toAppend.push({ ...e, ts: e?.ts ?? baseTs + i });
        }
      }
      if (entry) {
        toAppend.push({ ...entry, ts: entry?.ts ?? Date.now() });
      }
      if (toAppend.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "No entry/entries provided" }) }] } as any;
      }
      // append in given order
      for (const e of toAppend) arr.push(e);
      if (arr.length > 300) {
        const keep = arr.slice(-300);
        writeJSON(pMsg(root, dlg), keep);
      } else {
        writeJSON(pMsg(root, dlg), arr);
      }
      // Do not return maintenance here; detection moved to query (get_dialog_detail)
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, saved: toAppend.length }) }] } as any;
    });
  }
);

// history_get_summary has been removed in favor of history_get_dialog_detail

// history.setSummary — Set rolling summary JSON string
server.registerTool(
  "history_set_summary",
  {
    description: "Set rolling summary JSON string",
    inputSchema: {
      projectRoot: z.string(),
      dialog: z.string(),
      summary: z.string(),
      mode: z.enum(["replace", "merge"]).optional(),
    },
  },
  async ({ projectRoot, dialog, summary, mode = "merge" }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    // Validate incoming JSON first
    let next: any;
    try {
      next = JSON.parse(summary);
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

    let toWrite: any = next;
    if (mode === "merge") {
      // Read existing summary (if any) and deep-merge with de-dup for arrays
      let prev: any = null;
      try {
        const raw = fs.existsSync(pSum(root, dlg)) ? fs.readFileSync(pSum(root, dlg), "utf8") : null;
        if (raw) prev = JSON.parse(raw);
      } catch {}

      const isObject = (v: any) => v && typeof v === "object" && !Array.isArray(v);
      const dedupArray = (a: any[], b: any[]) => {
        // prefer b (new) items first, then a (old) items that are not duplicates
        const out: any[] = [];
        const seen = new Set<string>();
        const keyOf = (x: any) => {
          if (x && typeof x === "object") {
            if (x.value != null) return `v:${String(x.value)}`;
            if (x.id != null) return `i:${String(x.id)}`;
          }
          try {
            return JSON.stringify(x);
          } catch {
            return String(x);
          }
        };
        for (const item of b) {
          const k = keyOf(item);
          if (!seen.has(k)) {
            seen.add(k);
            out.push(item);
          }
        }
        for (const item of a) {
          const k = keyOf(item);
          if (!seen.has(k)) {
            seen.add(k);
            out.push(item);
          }
        }
        return out;
      };
      const deepMerge = (a: any, b: any): any => {
        if (Array.isArray(a) && Array.isArray(b)) return dedupArray(a, b);
        if (isObject(a) && isObject(b)) {
          const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
          const o: any = {};
          for (const k of keys) o[k] = k in b ? deepMerge(a[k], b[k]) : a[k];
          return o;
        }
        return b; // b wins for scalars or mismatched types
      };

      if (prev && (isObject(prev) || Array.isArray(prev))) {
        toWrite = deepMerge(prev, next);
      } else {
        toWrite = next;
      }
    }

    try {
      const pretty = JSON.stringify(toWrite, null, 2);
      const key = `${root}::${dlg}::summary`;
      await runExclusive(key, async () => {
        writeFileAtomic(pSum(root, dlg), pretty);
      });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, mode }) }] } as any;
    } catch (e: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: "Failed to write summary", detail: String(e?.message ?? e) }),
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
    const dialogDir = resolveDialogDir(root, dlg);
    const msgPath = pMsg(root, dlg);
    const sumPath = pSum(root, dlg);
    const existedFiles = [msgPath, sumPath].filter((p) => fs.existsSync(p));

    // Backup into timestamped subdir under backups/
    let backupInfo: any = null;
    if (existedFiles.length > 0) {
      const backupsRoot = path.join(dialogDir, "backups");
      mkdirpSync(backupsRoot);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const suffix = crypto.randomBytes(3).toString("hex");
      const backupDir = path.join(backupsRoot, `${stamp}_${suffix}`);
      mkdirpSync(backupDir);
      const copied: string[] = [];
      for (const p of existedFiles) {
        const dest = path.join(backupDir, path.basename(p));
        try {
          fs.copyFileSync(p, dest);
          copied.push(path.basename(dest));
        } catch {
          // fallback to read/write
          try {
            fs.writeFileSync(dest, fs.readFileSync(p));
            copied.push(path.basename(dest));
          } catch {}
        }
      }
      backupInfo = { dir: backupDir, files: copied };

      // Prune old backups, keep most recent BACKUP_RETENTION
      try {
        const entries = fs
          .readdirSync(backupsRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => ({ name: e.name, full: path.join(backupsRoot, e.name), mtime: fs.statSync(path.join(backupsRoot, e.name)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        const toDelete = entries.slice(BACKUP_RETENTION);
        for (const d of toDelete) {
          try {
            fs.rmSync(d.full, { recursive: true, force: true });
          } catch {}
        }
      } catch {}
    }

    // Remove originals
    for (const p of [msgPath, sumPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    return { content: [{ type: "text", text: JSON.stringify({ ok: true, backup: backupInfo }) }] } as any;
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

// history.get_messages_since — Incremental messages fetch (simple)
server.registerTool(
  "history_get_messages_since",
  {
    description: "Get messages with ts > sinceTs, limited (default 50, hard cap 200)",
    inputSchema: { projectRoot: z.string(), dialog: z.string(), sinceTs: z.number().optional(), limit: z.number().optional() },
  },
  async ({ projectRoot, dialog, sinceTs, limit }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    const arr = readJSON<any[]>(pMsg(root, dlg), []);
    const lim = Math.max(1, Math.min(Number(limit ?? 50), 200));
    let out: any[];
    if (sinceTs == null) {
      out = arr.slice(-lim);
    } else {
      out = arr.filter((m) => (m?.ts ?? 0) > sinceTs).slice(0, lim);
    }
    return { content: [{ type: "text", text: JSON.stringify({ messages: out }) }] } as any;
  }
);

// history.stats — Quick stats for a dialog
server.registerTool(
  "history_stats",
  {
    description: "Get message count, bytes, last timestamp, backups",
    inputSchema: { projectRoot: z.string(), dialog: z.string() },
  },
  async ({ projectRoot, dialog }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    const msgPath = pMsg(root, dlg);
    const sumPath = pSum(root, dlg);
    const arr = readJSON<any[]>(msgPath, []);
    const lastTs = arr.length ? arr[arr.length - 1]?.ts ?? null : null;
    const bytes = fileSize(msgPath) + fileSize(sumPath);
    const dialogDir = resolveDialogDir(root, dlg);
    const backupsRoot = path.join(dialogDir, "backups");
    let backups = 0;
    if (fs.existsSync(backupsRoot)) {
      try {
        backups = fs.readdirSync(backupsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
      } catch {}
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            messages: arr.length,
            approxBytes: bytes,
            lastTs,
            backups,
            thresholds: { maxMessages: MAX_CONTEXT_MESSAGES, maxBytes: MAX_CONTEXT_BYTES },
          }),
        },
      ],
    } as any;
  }
);

// history.list_backups — List available backups for a dialog
server.registerTool(
  "history_list_backups",
  {
    description: "List backups (id, mtime, files) for a dialog",
    inputSchema: { projectRoot: z.string(), dialog: z.string() },
  },
  async ({ projectRoot, dialog }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    const dialogDir = resolveDialogDir(root, dlg);
    const backupsRoot = path.join(dialogDir, "backups");
    let list: any[] = [];
    if (fs.existsSync(backupsRoot)) {
      try {
        list = fs
          .readdirSync(backupsRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => {
            const full = path.join(backupsRoot, e.name);
            const files = fs.readdirSync(full).filter((f) => f.endsWith(".json"));
            const mtime = fs.statSync(full).mtimeMs;
            return { id: e.name, mtime, files };
          })
          .sort((a, b) => b.mtime - a.mtime);
      } catch {}
    }
    return { content: [{ type: "text", text: JSON.stringify({ backups: list }) }] } as any;
  }
);

// history.restore_backup — Restore a specific backup (creates a new backup of current before restoring)
server.registerTool(
  "history_restore_backup",
  {
    description: "Restore a backup by id; current files are backed up first",
    inputSchema: { projectRoot: z.string(), dialog: z.string(), id: z.string() },
  },
  async ({ projectRoot, dialog, id }) => {
    const root = projectRoot ?? (undefined as any);
    const dlg = dialog ?? "default";
    const dialogDir = resolveDialogDir(root, dlg);
    const backupsRoot = path.join(dialogDir, "backups");
    const srcDir = path.join(backupsRoot, id);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Backup not found" }) }] } as any;
    }
    // Backup current first via history_clear's backup logic but without deleting; implement lightweight backup
    const nowStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = crypto.randomBytes(3).toString("hex");
    const destBackup = path.join(backupsRoot, `${nowStamp}_pre-restore_${suffix}`);
    mkdirpSync(destBackup);
    const msgPath = pMsg(root, dlg);
    const sumPath = pSum(root, dlg);
    const tryCopy = (from: string, to: string) => {
      try {
        if (fs.existsSync(from)) fs.copyFileSync(from, to);
      } catch {}
    };
    tryCopy(msgPath, path.join(destBackup, path.basename(msgPath)));
    tryCopy(sumPath, path.join(destBackup, path.basename(sumPath)));

    // Restore files atomically with mutex
    const key = `${root}::${dlg}::restore`;
    await runExclusive(key, async () => {
      const srcMsg = path.join(srcDir, path.basename(msgPath));
      const srcSum = path.join(srcDir, path.basename(sumPath));
      if (fs.existsSync(srcMsg)) writeFileAtomic(msgPath, fs.readFileSync(srcMsg));
      if (fs.existsSync(srcSum)) writeFileAtomic(sumPath, fs.readFileSync(srcSum));
    });

    return { content: [{ type: "text", text: JSON.stringify({ ok: true, restored: id }) }] } as any;
  }
);

// Allow disabling auto-connect for tests via MCP_AUTOSTART=0
if (process.env.MCP_AUTOSTART !== '0') {
  await server.connect(transport);
}

export const serverInstance = server;
