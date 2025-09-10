import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
// import from bundled dist to avoid unresolved deps in Vitest
import { readSummaryNormalized } from '../dist/index.js';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hist-'));

describe('readSummaryNormalized', () => {
  it('repairs double-encoded JSON and persists pretty JSON', () => {
    const root = mkTmp();
    const dlg = 'dlg1';
    const dir = path.join(root, '.chat-history', dlg);
    fs.mkdirSync(dir, { recursive: true });
    const sumPath = path.join(dir, 'summary.json');
    const original = { version: 1, decisions: ['a', 'b'] };
    // write double-encoded string
    fs.writeFileSync(sumPath, JSON.stringify(JSON.stringify(original)), 'utf8');

    const normalized = readSummaryNormalized(root, dlg);
    expect(normalized).toBeTruthy();
    // should parse back to the original object
    const reparsed = JSON.parse(normalized!);
    expect(reparsed).toEqual(original);
    // file should now contain pretty JSON (not a quoted string)
    const fileNow = fs.readFileSync(sumPath, 'utf8');
    expect(() => JSON.parse(fileNow)).not.toThrow();
    expect(fileNow.startsWith('{')).toBe(true);
  });
});
