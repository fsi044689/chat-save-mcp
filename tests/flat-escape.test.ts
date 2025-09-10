import { describe, it, expect } from 'vitest';
import { escFlatText } from '../dist/index.js';

describe('escFlatText', () => {
  it('escapes backslashes and newlines', () => {
    const input = 'line1\\next\\line\nline2\rline3';
    const out = escFlatText(input);
    expect(out).toBe('line1\\\\next\\\\line\\nline2\\rline3');
  });
});
