// care fork: answer filters and the access resolver's text (care-ai-native docs/design/SNS_HELP_QA.md §4.3・D1).
//  - setAnswerFilter: the final answer of an IM turn (a trusted inbound source) is passed through the filters before it is sent;
//    a turn without an IM source (Web UI, commands) is not; a failing filter keeps the text; disposal removes the filter
//  - resolveAccess / decide: the resolver gets the message text as its second argument
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BotWorkspaceStore, createBotWorkspaceScope } from '../../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../../src/channels/shared/conversation-state-store.mjs';
import { createImExtensions } from '../../src/channels/shared/im-extensions.mjs';
import { askInWorkspaceSession } from '../../src/channels/shared/workspace-session.mjs';

const quiet = { warn() {}, error() {}, info() {} };
const SOURCE = Object.freeze({
  platform: 'slack', botId: 'slack_bot', teamId: 'T1', userId: 'U1', conversationId: 'D1', conversationKind: 'direct', messageId: 'm1',
});

async function fixture(t, answer) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-im-answer-filter-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'default');
  await mkdir(workspace);
  const workspaces = await new BotWorkspaceStore(join(root, 'workspaces.json'), { defaultWorkspace: workspace }).load();
  await workspaces.ensure('bot');
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  const sessions = [];
  const harness = {
    async listWorkspaces() { return [workspace]; },
    async listWorkspaceSessions() { return { workspace, sessions }; },
    async adoptWorkspaceSession(sessionId) { return sessions.find((s) => s.sessionId === sessionId); },
    async createSession() { const sessionId = `s-${sessions.length}`; sessions.push({ sessionId, workspace }); return sessionId; },
    async sessionExists(sessionId) { return sessions.some((s) => s.sessionId === sessionId); },
    async ask() { return answer; },
  };
  return createBotWorkspaceScope(harness, { botId: 'bot', workspaces, state });
}

test('an IM turn\'s final answer passes through the answer filters; other turns do not', async (t) => {
  const scope = await fixture(t, 'see https://bad.example/x');
  const ext = createImExtensions({ logger: quiet });
  const seen = [];
  const dispose = ext.setAnswerFilter(({ sessionId, source, text }) => {
    seen.push({ sessionId, userId: source?.userId });
    return text.replace('https://bad.example/x', '（リンクを省きました）');
  });
  assert.equal(ext.hasAnswerFilter(), true);
  const im = await askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: 'k1', text: 'q', imSource: SOURCE, extensions: ext });
  assert.equal(im.answer, 'see （リンクを省きました）');
  assert.deepEqual(seen, [{ sessionId: im.sessionId, userId: 'U1' }]);
  // no IM source (Web UI, commands): unchanged
  const web = await askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: 'k2', text: 'q', extensions: ext });
  assert.equal(web.answer, 'see https://bad.example/x');
  dispose.dispose?.() ?? dispose();
  assert.equal(ext.hasAnswerFilter(), false);
  const after = await askInWorkspaceSession({ harness: scope.harness, state: scope.state, key: 'k3', text: 'q', imSource: SOURCE, extensions: ext });
  assert.equal(after.answer, 'see https://bad.example/x');
});

test('filters run in order; a throwing filter or a non-string result keeps the text', async () => {
  const ext = createImExtensions({ logger: quiet });
  ext.setAnswerFilter(({ text }) => `${text}A`);
  ext.setAnswerFilter(() => { throw new Error('boom'); });
  ext.setAnswerFilter(() => 42);
  ext.setAnswerFilter(async ({ text }) => `${text}B`);
  assert.equal(await ext.filterAnswer({ sessionId: 's', source: SOURCE, text: 'x' }), 'xAB');
  assert.equal(await ext.filterAnswer({ text: '' }), '');
  assert.equal(await ext.filterAnswer({ text: undefined }), undefined);
  assert.throws(() => ext.setAnswerFilter('nope'), /answer filter must be a function/);
  ext.reset();
  assert.equal(ext.hasAnswerFilter(), false);
});

test('the access resolver gets the message text', async () => {
  const ext = createImExtensions({ logger: quiet });
  const calls = [];
  ext.setAccessResolver((source, extra) => { calls.push([source.userId, extra]); return { deny: true, reply: 'guide' }; });
  const replies = [];
  const decision = await ext.decide({ source: SOURCE, text: '  ログインできない  ', reply: async (m) => { replies.push(m); } });
  assert.deepEqual(decision, { handled: true, kind: 'denied' });
  assert.deepEqual(calls, [['U1', { text: 'ログインできない' }]]);
  assert.deepEqual(replies, ['guide']);
  assert.deepEqual(await ext.resolveAccess(SOURCE), { verdict: 'deny', reply: 'guide' });
  assert.deepEqual(calls.at(-1), ['U1', { text: '' }]);
});
