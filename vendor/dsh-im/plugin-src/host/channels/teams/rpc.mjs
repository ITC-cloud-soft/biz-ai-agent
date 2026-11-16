// care fork: `/teams` management RPC (same endpoint names as the token channels).
import { createWebhookBotRpcHandler, installWebhookBotRpc, WEBHOOK_BOT_ENDPOINTS } from '../shared/webhook-rpc.mjs';

export const TEAMS_RPC_CHANNEL = '/teams';
export const TEAMS_ENDPOINTS = WEBHOOK_BOT_ENDPOINTS;
export const TEAMS_RPC_ENDPOINTS = Object.freeze(Object.values(TEAMS_ENDPOINTS));

export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateTeamsCredentials(payload) {
  const appId = typeof payload.appId === 'string' ? payload.appId.trim() : '';
  const password = typeof payload.appPassword === 'string' ? payload.appPassword.trim() : '';
  if (!GUID_PATTERN.test(appId)) return 'appId must be the Microsoft App ID (GUID).';
  if (!password || password.length > 1024) return 'appPassword must be the client secret (1–1024 characters).';
  if (payload.tenantId !== undefined && payload.tenantId !== null && payload.tenantId !== '') {
    if (typeof payload.tenantId !== 'string' || !GUID_PATTERN.test(payload.tenantId.trim())) {
      return 'tenantId must be a tenant GUID, or empty for a multi-tenant bot.';
    }
  }
  return null;
}

export function teamsOperationError(error) {
  if (error?.code === 'teams-invalid-credentials') {
    return { code: 'invalid-credentials', message: 'Microsoft 登录拒绝了此 App ID / 密码（或租户），请重新填写。' };
  }
  if (/^teams(-login)?-(transport-error|timeout|5\d\d|429)$/.test(String(error?.code ?? ''))) {
    return { code: 'teams-network-error', message: '无法访问 Microsoft 登录或 Bot Connector，请检查网络后重试。' };
  }
  return null;
}

const DEFINITION = Object.freeze({
  channel: 'teams',
  label: 'Teams',
  idPattern: /^teams_[a-f0-9]{24}$/,
  credentialKeys: ['appId', 'appPassword', 'tenantId'],
  // care fork: field-level reasons for a rejected bind (validation-reason.mjs).
  credentialFields: Object.freeze([
    { name: 'appId', valid: (value) => typeof value === 'string' && GUID_PATTERN.test(value.trim()) },
    { name: 'appPassword', valid: (value) => typeof value === 'string' && value.trim().length <= 1024 },
    { name: 'tenantId', valid: (value) => typeof value === 'string' && GUID_PATTERN.test(value.trim()), optional: true },
  ]),
  validateCredentials: validateTeamsCredentials,
  operationError: teamsOperationError,
});

export function createTeamsRpcHandler(controller) {
  return createWebhookBotRpcHandler(controller, DEFINITION);
}

export function installTeamsRpc(ctx, controller, authority) {
  return installWebhookBotRpc(ctx, controller, { ...DEFINITION, rpcChannel: TEAMS_RPC_CHANNEL, authority });
}
