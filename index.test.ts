import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import extension from './index.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

const hour = 3_600_000;
const minute = 60_000;

let agentDir: string;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'pi-quota-'));
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['PI_CODING_AGENT_DIR'];
  mock.timers.reset();
});

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out');
}

function anthropicUsage(fiveHour: [number, number], sevenDay: [number, number]) {
  return {
    five_hour: {
      utilization: fiveHour[0],
      resets_at: new Date(Date.now() + fiveHour[1]).toISOString(),
    },
    seven_day: {
      utilization: sevenDay[0],
      resets_at: new Date(Date.now() + sevenDay[1]).toISOString(),
    },
  };
}

function mockFetch(handler: (url: string) => unknown) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const body = handler(url);
    if (body === undefined) return new Response('', { status: 500 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return calls;
}

async function writeAuth() {
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({ anthropic: { access: 'token', refresh: 'r', expires: Date.now() + hour } }),
  );
}

function startSession() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  extension(pi);

  const statuses: (string | undefined)[] = [];
  const ctx = {
    cwd: agentDir,
    model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
    ui: {
      setWidget: (_key: string, content: (() => Component) | undefined) => {
        statuses.push(content?.().render(80).join('\n').trimEnd());
      },
      notify: () => {},
      theme: { fg: (_colour: string, text: string) => text },
    },
  };
  handlers.get('session_start')?.({}, ctx);

  return {
    statuses,
    ctx,
    emit: (event: string, payload: unknown) => handlers.get(event)?.(payload, ctx),
    stop: () => handlers.get('session_shutdown')?.({}, ctx),
  };
}

test('shows the remaining Anthropic quota above the editor', async () => {
  await writeAuth();
  mockFetch(() => anthropicUsage([7, hour + 29 * minute + 30_000], [33, 85 * hour + 30 * minute]));

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  assert.equal(session.statuses.at(-1), '93% 1h29m · 67% 3d13h');
});
