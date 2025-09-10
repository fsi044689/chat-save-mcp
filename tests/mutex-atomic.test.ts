import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runExclusive } from '../dist/index.js';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hist-'));

describe('runExclusive', () => {
  it('serializes tasks for same key in order', async () => {
    const key = 'k1';
    const order: number[] = [];
    await Promise.all([
      runExclusive(key, async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(1);
      }),
      runExclusive(key, async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
