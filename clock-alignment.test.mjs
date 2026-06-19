import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

const sessionStartIdx = source.indexOf('pi.on("session_start"');
const sessionShutdownIdx = source.indexOf('pi.on("session_shutdown"');
assert.notStrictEqual(sessionStartIdx, -1, 'session_start handler must exist');
assert.notStrictEqual(sessionShutdownIdx, -1, 'session_shutdown handler must exist');
const sessionStartSource =
  sessionStartIdx < sessionShutdownIdx
    ? source.slice(sessionStartIdx, sessionShutdownIdx)
    : source.slice(sessionStartIdx);

test('nextMarkAfter helper is defined and has the expected signature', () => {
  assert.match(
    source,
    /function\s+nextMarkAfter\s*\(\s*time\s*:\s*Date\s*\)\s*:\s*Date/,
  );
});

test('pollIntervalMs has been removed from QuotaConfig and the session handler', () => {
  assert.doesNotMatch(source, /pollIntervalMs/);
});

test('legacy poll interval constants have been removed', () => {
  assert.doesNotMatch(source, /MIN_POLL_INTERVAL_MS/);
  assert.doesNotMatch(source, /DEFAULT_POLL_INTERVAL_MS/);
});

test('scheduleCheck aligns to the next wall-clock mark after each poll', () => {
  assert.match(
    sessionStartSource,
    /scheduleCheck[\s\S]{0,400}?nextMarkAfter\([\s\S]{0,80}?new Date\(\)[\s\S]{0,200}?Math\.max\(0,/,
  );
});

test('session_start still kicks off an immediate poll in the background', () => {
  assert.match(sessionStartSource, /void\s+refresh\(\)/);
});
