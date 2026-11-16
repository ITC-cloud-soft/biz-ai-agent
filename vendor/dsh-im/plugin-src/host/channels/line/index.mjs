// care fork: LINE Messaging API channel (webhook `/dsh-hooks/line`).
import { LineConfigStore } from '../../../../src/channels/line/config-store.mjs';
import { LineController } from '../../../../src/channels/line/line-controller.mjs';
import { LineHarnessClient } from '../../../../src/channels/line/harness-client.mjs';
import { LineApi, inspectLineCredentials } from '../../../../src/channels/line/line-api.mjs';
import { LineRuntime } from '../../../../src/channels/line/line-runtime.mjs';
import { LineStateStore } from '../../../../src/channels/line/state-store.mjs';
import { installProductionChannel } from '../shared/startup.mjs';
import { createWebhookProductionController } from '../shared/webhook-production.mjs';
import { createLineRpcHandler, installLineRpc, LINE_RPC_CHANNEL } from './rpc.mjs';

export const name = 'dsh-im-line-host';
export const inject = ['connection', 'credentials', 'typertGateway'];

export const LINE_API_BASE_ENV = 'CARE_DSH_IM_LINE_API_BASE';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * care fork (e2e): `CARE_DSH_IM_LINE_API_BASE` points the channel at a mock
 * Messaging API on this machine. Only an http(s) loopback origin is accepted
 * (127.0.0.1 / localhost / [::1], no credentials); anything else is ignored
 * with a warning and the real `https://api.line.me` stays in use. Unset = no
 * effect. The profile key `line.apiBaseUrl` (if set) still wins.
 */
export function lineApiBaseFromEnv(env = process.env, logger = console) {
  const raw = typeof env?.[LINE_API_BASE_ENV] === 'string' ? env[LINE_API_BASE_ENV].trim() : '';
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    logger.warn?.(`[dsh-im:line] ignoring ${LINE_API_BASE_ENV}: not a URL`);
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password
    || url.search || url.hash) {
    logger.warn?.(`[dsh-im:line] ignoring ${LINE_API_BASE_ENV}: only an http(s) loopback origin (127.0.0.1, localhost, [::1]) is accepted`);
    return undefined;
  }
  logger.warn?.(`[dsh-im:line] ${LINE_API_BASE_ENV} is set: LINE Messaging API calls go to ${url.origin} (test override)`);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function createProductionController(ctx, config = {}, internals = {}) {
  // `apiBaseUrl` points the channel at a mock Messaging API (tests / local checks only).
  const apiBaseUrl = typeof config.apiBaseUrl === 'string' && config.apiBaseUrl
    ? config.apiBaseUrl
    : lineApiBaseFromEnv(internals.env ?? process.env, internals.logger ?? console);
  const createApi = (options) => new LineApi({ ...options, ...(apiBaseUrl ? { baseUrl: apiBaseUrl } : {}) });
  return createWebhookProductionController(ctx, config, {
    ...(apiBaseUrl ? { inspectCredentials: (values) => inspectLineCredentials(values, { createApi }) } : {}),
    ...internals,
  }, {
    channel: 'line',
    ConfigStore: LineConfigStore,
    StateStore: LineStateStore,
    HarnessClient: LineHarnessClient,
    Controller: LineController,
    Runtime: LineRuntime,
    perBotOptions: () => ({ createApi }),
  });
}

export async function apply(ctx, config = {}) {
  if (config?.controller) return installLineRpc(ctx, config.controller, config.rpcAuthority);
  return installProductionChannel(ctx, config, {
    channel: 'line',
    rpcChannel: LINE_RPC_CHANNEL,
    createProduction: () => createProductionController(ctx, config, config.internals ?? {}),
    createHandler: (controller) => createLineRpcHandler(controller),
  });
}

export { LINE_ENDPOINTS, LINE_RPC_CHANNEL, createLineRpcHandler, installLineRpc } from './rpc.mjs';
export { LineController, LineRuntime };
