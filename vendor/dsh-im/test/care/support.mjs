// care fork: shared fixtures for the care tests (no network, no real accounts).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { imExtensions } from '../../src/channels/shared/im-extensions.mjs';

export const quiet = { warn() {}, error() {}, info() {}, debug() {} };

export async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

export const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** Isolated hub state per test: a temp store and the given access default. */
export async function useHub(t, { accessDefault = 'closed' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-care-'));
  imExtensions.reset();
  imExtensions.configure({ accessDefault, storePath: join(dir, 'care-delivery.json'), logger: quiet });
  const inbound = [];
  imExtensions.setInboundEmitter((event) => inbound.push(event));
  t.after(async () => {
    imExtensions.reset();
    await rm(dir, { recursive: true, force: true });
  });
  return { hub: imExtensions, dir, inbound };
}

/** One access-policy scope in the canonical persisted shape. */
export function scope(mode, users = []) {
  return {
    mode,
    open: { defaultCanExecuteCommands: mode === 'open', commandPermissionOverrides: [] },
    allowlist: { users: users.map((id) => ({ id, canExecuteCommands: false })) },
  };
}

/** The live provider shape production builds with accessPolicyProvider(). */
export function policyProvider(botId, { direct = scope('open'), group = scope('open'), privileged = [] } = {}) {
  return {
    botId,
    getSettings: () => ({ direct, group }),
    isPrivileged: (senderIds) => (Array.isArray(senderIds) ? senderIds : [senderIds]).some((id) => privileged.includes(id)),
  };
}

export function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessions,
    seen,
    state: {
      sessionFor: (key) => sessions.get(key) ?? null,
      async setSession(key, value) { sessions.set(key, value); return true; },
      async clearSession(key) { sessions.delete(key); },
      hasSeen: (id) => seen.has(id),
      async markSeen(id) { seen.add(id); },
      snapshot: () => ({ sessions: Object.fromEntries(sessions) }),
    },
  };
}

/** A Harness double that records prompts and what sourceForTurn() saw meanwhile. */
export function harnessFixture({ answer = '了解しました' } = {}) {
  const asked = [];
  return {
    asked,
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async (sessionId, prompt) => {
        asked.push({ sessionId, prompt, source: imExtensions.sourceForTurn(sessionId) });
        return answer;
      },
    },
  };
}

export class FakeSocket {
  #listeners = new Map();
  sent = [];
  readyState = 1;

  addEventListener(name, listener) {
    const listeners = this.#listeners.get(name) ?? [];
    listeners.push(listener);
    this.#listeners.set(name, listeners);
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close(code = 1000) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit('close', { code });
  }

  emit(name, event) {
    for (const listener of this.#listeners.get(name) ?? []) listener(event);
  }

  envelope(packet) {
    this.emit('message', { data: JSON.stringify(packet) });
  }
}
