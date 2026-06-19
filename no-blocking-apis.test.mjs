import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

test('quota extension uses asynchronous filesystem APIs', () => {
  assert.doesNotMatch(source, /\b(readFileSync|writeFileSync|appendFileSync)\b/);
});

test('quota extension starts initial network polling in the background', () => {
  const sessionStart = source.slice(source.indexOf('pi.on("session_start"'));
  assert.match(sessionStart, /void refresh\(\)/);
  assert.doesNotMatch(sessionStart, /await refresh\(\)/);
});
