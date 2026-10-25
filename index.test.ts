import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from './index.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

const hour = 3_600_000;
const minute = 60_000;

let agentDir: string;
const realFetch = globalThis.fetch;
const realPath = process.env['PATH'];

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'pi-quota-'));
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env['PATH'] = realPath;
  delete process.env['PI_CODING_AGENT_DIR'];
  mock.timers.reset();
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out');
}

async function settle(ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
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

function startSession(model = { provider: 'anthropic', id: 'claude-sonnet-4-5' }) {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  extension(pi);

  const statuses: (string | undefined)[] = [];
  const ctx = {
    cwd: agentDir,
    model,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        assert.equal(key, 'pi-quota');
        statuses.push(text);
      },
      notify: () => {},
      theme: { fg: (colour: string, text: string) => `<${colour}>${text}</>` },
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

test('shows the used Anthropic quota in the footer', async () => {
  await writeAuth();
  mockFetch(() => anthropicUsage([7, hour + 29 * minute + 30_000], [33, 85 * hour + 30 * minute]));

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  assert.equal(session.statuses.at(-1), '<dim>7% 1h29m · 33% 4d</>');
});

test('updates the Anthropic quota from response headers', async () => {
  await writeAuth();
  mockFetch(() => anthropicUsage([7, hour], [33, 2 * hour]));

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  const seconds = (ms: number) => String(Math.floor((Date.now() + ms) / 1000));
  session.emit('after_provider_response', {
    type: 'after_provider_response',
    status: 200,
    headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': seconds(2 * hour + minute),
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-7d-reset': seconds(26 * hour + minute),
    },
  });
  session.stop();

  assert.equal(session.statuses.at(-1), '<dim>25% 2h · 40% 1d2h</>');
});

test('calls the Anthropic usage endpoint only at session start', async () => {
  await writeAuth();
  const calls = mockFetch(() => anthropicUsage([7, 6 * hour], [33, 48 * hour]));
  mock.timers.enable({ apis: ['setTimeout'] });

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  mock.timers.tick(30 * minute);
  await settle(200);
  session.stop();

  assert.equal(calls.filter((url) => url.endsWith('/api/oauth/usage')).length, 1);
});

test('pings the active Anthropic model when a quota window resets', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'pi-bin-'));
  const argsFile = join(binDir, 'args');
  await writeFile(join(binDir, 'pi'), `#!/bin/sh\necho "$@" > "${argsFile}"\n`);
  await chmod(join(binDir, 'pi'), 0o755);
  process.env['PATH'] = `${binDir}:${realPath}`;

  await writeAuth();
  mockFetch(() => anthropicUsage([90, hour], [50, 2 * hour]));
  mock.timers.enable({ apis: ['setTimeout'] });

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  mock.timers.tick(hour);
  await waitFor(async () => {
    try {
      return (await readFile(argsFile, 'utf-8')).length > 0;
    } catch {
      return false;
    }
  });
  session.stop();

  const args = await readFile(argsFile, 'utf-8');
  assert.match(args, /--provider anthropic --model claude-sonnet-4-5 -p hi/);
});

test('shows the used OpenAI Codex quota for a Codex model', async () => {
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      'openai-codex': { access: 'token', refresh: 'r', expires: Date.now() + hour },
    }),
  );
  const seconds = (ms: number) => Math.floor((Date.now() + ms) / 1000);
  mockFetch((url) =>
    url.endsWith('/wham/usage')
      ? {
          rate_limit: {
            primary_window: { used_percent: 10, reset_at: seconds(2 * hour + 30_000) },
            secondary_window: { used_percent: 40, reset_at: seconds(26 * hour + 30_000) },
          },
        }
      : undefined,
  );

  const session = startSession({ provider: 'openai-codex', id: 'gpt-5.5' });
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  assert.equal(session.statuses.at(-1), '<dim>10% 2h · 40% 1d2h</>');
});

test('stops polling after session shutdown during a poll', async () => {
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      'openai-codex': { access: 'token', refresh: 'r', expires: Date.now() + hour },
    }),
  );
  let release = () => {};
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 2) await new Promise<void>((resolve) => (release = resolve));
    return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 });
  }) as typeof fetch;
  mock.timers.enable({ apis: ['setTimeout'] });

  const session = startSession({ provider: 'openai-codex', id: 'gpt-5.5' });
  await waitFor(() => session.statuses.length > 0);
  mock.timers.tick(10 * minute);
  await waitFor(() => calls === 2);
  session.stop();
  release();
  await settle(100);
  mock.timers.tick(20 * minute);
  await settle(100);

  assert.equal(calls, 2);
});

test('ignores an Anthropic usage response that arrives after shutdown', async () => {
  await writeAuth();
  let respond: (() => void) | undefined;
  globalThis.fetch = ((input: string | URL) =>
    String(input).endsWith('/api/oauth/usage')
      ? new Promise<Response>((resolve) => {
          respond = () =>
            resolve(new Response(JSON.stringify(anthropicUsage([7, hour], [33, 2 * hour]))));
        })
      : Promise.resolve(new Response('', { status: 500 }))) as typeof fetch;
  mock.timers.enable({ apis: ['setTimeout'] });

  const session = startSession();
  await waitFor(() => respond !== undefined);
  session.stop();
  for (const key of ['ui', 'model', 'cwd']) {
    Object.defineProperty(session.ctx, key, {
      get: () => {
        throw new Error('stale ctx');
      },
    });
  }
  respond?.();
  await settle(200);

  assert.doesNotThrow(() => mock.timers.tick(hour));
  assert.deepEqual(session.statuses, []);
  await assert.rejects(readFile(join(agentDir, 'pi-quota.log'), 'utf-8'));
});

test('shows the OpenAI Codex quota when the Anthropic request fails', async () => {
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      anthropic: { access: 'token', refresh: 'r', expires: Date.now() + hour },
      'openai-codex': { access: 'token', refresh: 'r', expires: Date.now() + hour },
    }),
  );
  const seconds = (ms: number) => Math.floor((Date.now() + ms) / 1000);
  globalThis.fetch = (async (input: string | URL) => {
    if (String(input).endsWith('/api/oauth/usage')) throw new Error('network down');
    return new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 10, reset_at: seconds(2 * hour + 30_000) },
          secondary_window: { used_percent: 40, reset_at: seconds(26 * hour + 30_000) },
        },
      }),
    );
  }) as typeof fetch;

  const session = startSession({ provider: 'openai-codex', id: 'gpt-5.5' });
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  assert.equal(session.statuses.at(-1), '<dim>10% 2h · 40% 1d2h</>');
});

test('reads a Codex reset expiry given as a millisecond string', async () => {
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      'openai-codex': { access: 'token', refresh: 'r', expires: Date.now() + hour },
    }),
  );
  const seconds = (ms: number) => Math.floor((Date.now() + ms) / 1000);
  mockFetch((url) => {
    if (url.endsWith('/wham/usage')) {
      return {
        rate_limit: {
          primary_window: { used_percent: 10, reset_at: seconds(2 * hour + 30_000) },
          secondary_window: { used_percent: 40, reset_at: seconds(26 * hour + 30_000) },
        },
        rate_limit_reset_credits: { available_count: 1 },
      };
    }
    if (url.endsWith('/wham/rate-limit-reset-credits')) {
      return {
        credits: [
          { id: 'c1', status: 'available', expires_at: String(Date.now() + 5 * hour + 30_000) },
        ],
      };
    }
    return undefined;
  });

  const session = startSession({ provider: 'openai-codex', id: 'gpt-5.5' });
  await waitFor(() => session.statuses.length > 0);
  session.stop();

  assert.equal(session.statuses.at(-1), '<dim>10% 2h · 40% 1d2h · 1x 5h</>');
});

test('polls Anthropic again when a new session starts during a poll', async () => {
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      anthropic: { access: 'token', refresh: 'r', expires: Date.now() + hour },
      'openai-codex': { access: 'token', refresh: 'r', expires: Date.now() + hour },
    }),
  );
  let release = () => {};
  let anthropicCalls = 0;
  let codexCalls = 0;
  globalThis.fetch = (async (input: string | URL) => {
    if (String(input).endsWith('/api/oauth/usage')) {
      anthropicCalls += 1;
      return new Response(JSON.stringify(anthropicUsage([7, 2 * hour], [33, 48 * hour])));
    }
    codexCalls += 1;
    if (codexCalls === 2) await new Promise<void>((resolve) => (release = resolve));
    return new Response(JSON.stringify({ rate_limit: {} }));
  }) as typeof fetch;
  mock.timers.enable({ apis: ['setTimeout'] });

  const session = startSession();
  await waitFor(() => session.statuses.length > 0);
  mock.timers.tick(10 * minute);
  await waitFor(() => codexCalls === 2);
  session.emit('session_start', {});
  release();
  await waitFor(() => anthropicCalls === 2);
  await settle(100);
  session.stop();

  assert.equal(session.statuses.at(-1), '<dim>7% 2h · 33% 2d</>');
});
