// care fork: public webhook routes for the LINE and Teams channels.
//
// `POST /dsh-hooks/line` and `POST /dsh-hooks/teams` on the DSH webServer. The
// raw body is handed to the webhook hub; each channel runtime verifies the
// request itself (LINE X-Line-Signature, Bot Framework JWT). These routes need
// no DSH session: the gateway forwards them through `publicPaths` without
// admin authentication or cookies.

import { WEBHOOK_PATHS, webhookHub } from '../../src/channels/shared/webhook-hub.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

function send(response, status, body, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const text = body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    ...(text ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  });
  response.end(text);
}

async function readRaw(request) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length);
}

export function createWebhookHttpHandler(channel, { hub = webhookHub, logger = console } = {}) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      send(response, 405, { error: 'method-not-allowed' }, { allow: 'POST' });
      return;
    }
    let rawBody;
    try {
      rawBody = await readRaw(request);
    } catch {
      send(response, 400, { error: 'bad-request' });
      return;
    }
    if (rawBody === null) {
      send(response, 413, { error: 'payload-too-large' });
      return;
    }
    try {
      const result = await hub.dispatch(channel, { rawBody, headers: request.headers });
      send(response, result.status, result.body, result.headers);
    } catch (error) {
      logger.error?.(`[dsh-im] ${channel} webhook failed:`, error?.message ?? error);
      send(response, 500, { error: 'internal-error' });
    }
  };
}

export function installWebhookHttp(ctx, { hub = webhookHub, logger = console } = {}) {
  if (!ctx?.webServer || typeof ctx.webServer.register !== 'function' || typeof ctx.effect !== 'function') {
    throw new TypeError('DSH Host WebServer is required');
  }
  for (const [channel, path] of Object.entries(WEBHOOK_PATHS)) {
    const route = { kind: 'exact', path, handler: createWebhookHttpHandler(channel, { hub, logger }) };
    ctx.effect(() => ctx.webServer.register(route), `dsh-im: ${path}`);
  }
}
