// care fork: the `ctx.dshIm` service exposes EVERY care extension (FORK.md「公開 API」).
//  - found 2026-11-15 on a real DSH (biz-ai-agent e2e): installCareExtensions() returned setAnswerFilter, but the Host's
//    ctx.provide('dshIm', …) did not pass it on, so no answer filter (bridge-identity's link guard, the citation guard)
//    was ever installed; the plugins only logged "setAnswerFilter is missing" and sent the answer unchanged
//  - the source Host and the BUILT lib/index.js (what DSH actually loads) are both checked, so a forgotten
//    `npm run build` fails here too
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createImHostPlugin } from '../../plugin-src/host/index.mjs';
import { installCareExtensions } from '../../plugin-src/host/care-extensions.mjs';
import { createImExtensions, imExtensions } from '../../src/channels/shared/im-extensions.mjs';
import { useHub } from './support.mjs';

const CHANNELS = ['applyFeishu', 'applyWeixin', 'applyDingtalk', 'applyWecom', 'applyWecomApp', 'applyQq', 'applySlack',
  'applyTelegram', 'applyDiscord', 'applyWhatsapp', 'applyIMessage', 'applyEmail', 'applyMatrix', 'applyOffice', 'applyLine', 'applyTeams'];

/** The names installCareExtensions() returns (the care API), on a private hub (nothing is sent or stored). */
function careExtensionNames() {
  const quiet = { warn() {}, error() {}, info() {} };
  const care = installCareExtensions({}, {}, { async listBots() { return []; } }, { extensions: createImExtensions({ logger: quiet }), logger: quiet });
  return Object.keys(care).sort();
}

async function provideHost(t) {
  const { dir } = await useHub(t);
  const internals = {
    createDeliveryService: () => ({
      async send() { return { sent: true }; },
      async listBots() { return []; },
      async listTargets() { return { targets: [] }; },
    }),
    installUpdateRpc: () => {}, installDeliveryRpc: () => {}, installDeliveryHttp: () => {},
    installSessionSyncCoordinator: () => {},
  };
  for (const name of CHANNELS) internals[name] = async () => {};
  const provided = [];
  const effects = [];
  await createImHostPlugin(internals).apply({
    effect: (fn) => effects.push(fn),
    provide: (...args) => provided.push(args),
    emit: () => {},
  }, { dshHome: dir });
  t.after(() => { for (const effect of effects) effect()?.(); });
  const entry = provided.find(([name]) => name === 'dshIm');
  assert.ok(entry, 'the Host provides dshIm');
  return entry[1];
}

test('ctx.dshIm exposes every care extension, setAnswerFilter included', async (t) => {
  const names = careExtensionNames();
  assert.ok(names.includes('setAnswerFilter'), 'installCareExtensions returns setAnswerFilter');
  const dshIm = await provideHost(t);
  const missing = names.filter((name) => dshIm[name] === undefined);
  assert.deepEqual(missing, [], `care extensions missing from ctx.dshIm: ${missing.join(', ')}`);
  for (const name of names) {
    if (name !== 'careExtensionsVersion') assert.equal(typeof dshIm[name], 'function', name);
  }
});

test('an answer filter set through ctx.dshIm reaches the IM turns, and its disposer removes it', async (t) => {
  const dshIm = await provideHost(t);
  assert.equal(imExtensions.hasAnswerFilter(), false);
  const dispose = dshIm.setAnswerFilter(({ text }) => text.replace('https://evil.example/x', '（リンクを省きました）'));
  assert.equal(imExtensions.hasAnswerFilter(), true);
  const source = { platform: 'line', botId: 'line_bot', userId: 'U1', conversationId: 'U1', conversationKind: 'direct', messageId: 'm1' };
  assert.equal(await imExtensions.filterAnswer({ sessionId: 's', source, text: 'see https://evil.example/x' }), 'see （リンクを省きました）');
  assert.equal(dispose(), true);
  assert.equal(imExtensions.hasAnswerFilter(), false);
});

/** The object literal passed to provide("dshIm", Object.freeze({ … })) in the built bundle. */
function builtServiceLiteral(bundle) {
  const marker = /provide\(\s*["']dshIm["']\s*,\s*Object\.freeze\(\s*\{/u.exec(bundle);
  assert.ok(marker, 'lib/index.js provides dshIm');
  let depth = 0;
  for (let i = marker.index + marker[0].length - 1; i < bundle.length; i += 1) {
    if (bundle[i] === '{') depth += 1;
    else if (bundle[i] === '}' && (depth -= 1) === 0) return bundle.slice(marker.index + marker[0].length - 1, i + 1);
  }
  throw new Error('unbalanced dshIm service literal in lib/index.js');
}

test('the built lib/index.js (what DSH loads) names every care extension in ctx.dshIm', async () => {
  const bundle = await readFile(join(import.meta.dirname, '..', '..', 'lib', 'index.js'), 'utf8');
  const literal = builtServiceLiteral(bundle);
  const missing = careExtensionNames().filter((name) => !new RegExp(`[{,]\\s*${name}\\s*:`, 'u').test(literal));
  assert.deepEqual(missing, [], `lib/index.js is stale (run npm run build): ctx.dshIm lacks ${missing.join(', ')}`);
});
