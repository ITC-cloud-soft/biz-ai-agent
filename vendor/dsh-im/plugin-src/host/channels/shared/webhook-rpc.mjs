// care fork: management RPC for the webhook channels (`/line`, `/teams`).
// Endpoint names follow TOKEN_BOT_ENDPOINTS (shared/rpc.mjs); only the payload
// of `bot.bind-credentials` differs per channel. Responses never contain secrets.

import { SET_MESSAGE_MODE_ENDPOINT, validMessageModePayload } from '../../../../src/channels/shared/message-mode.mjs';
import { validationRejected } from '../../../../src/channels/shared/validation-reason.mjs';
import { validCreateOnly } from '../../../../src/channels/shared/create-only.mjs';
import { createConnectionDiagnostics, diagnosticRpcResult } from '../../../../src/channels/shared/connection-error.mjs';
import { publicConnectionTestResult } from '../../../../src/channels/shared/connection-test.mjs';
import { registerManagementRpc } from '../../../management-rpc.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';
import { SET_ALIAS_ENDPOINT, validAliasPayload } from './bot-alias-rpc.mjs';
import { SET_CONTEXT_ENHANCEMENT_ENDPOINT, validContextEnhancementPayload } from './context-enhancement-rpc.mjs';
import { SET_ACCESS_POLICY_ENDPOINT, validAccessPolicyPayload } from './access-policy-rpc.mjs';
import { publicWorkspaceError, SET_WORKSPACE_ENDPOINT, validWorkspacePayload } from './workspace-rpc.mjs';
import { SET_AGENT_PRESET_ENDPOINT, validAgentPresetPayload } from './agent-preset-rpc.mjs';
import { SET_MODEL_ENDPOINT, validModelPayload } from './model-setting-rpc.mjs';

export const WEBHOOK_BOT_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  bindCredentials: 'bot.bind-credentials',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',
  setWorkspace: SET_WORKSPACE_ENDPOINT,
  setModel: SET_MODEL_ENDPOINT,
  setAgentPreset: SET_AGENT_PRESET_ENDPOINT,
  setContextEnhancement: SET_CONTEXT_ENHANCEMENT_ENDPOINT,
  setBusyMessageMode: SET_MESSAGE_MODE_ENDPOINT,
  setAccessPolicy: SET_ACCESS_POLICY_ENDPOINT,
  setAlias: SET_ALIAS_ENDPOINT,
});
const ENDPOINTS = Object.freeze(Object.values(WEBHOOK_BOT_ENDPOINTS));

export const WEBHOOK_FORBIDDEN_PUBLIC_KEYS = new Set([
  'token', 'botToken', 'appToken', 'tokenRef', 'secret', 'secretRef', 'platformId',
  'channelSecret', 'channelAccessToken', 'appPassword', 'passwordRef', 'password',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

export function sanitizeWebhookPublic(value) {
  if (Array.isArray(value)) return value.map(sanitizeWebhookPublic);
  if (!isRecord(value)) return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (!WEBHOOK_FORBIDDEN_PUBLIC_KEYS.has(key)) safe[key] = sanitizeWebhookPublic(child);
  }
  return safe;
}

const cancelled = () => ({ ok: false, error: { code: 'cancelled', message: 'The request was cancelled.' } });

const SETTERS = Object.freeze({
  [WEBHOOK_BOT_ENDPOINTS.setWorkspace]: ['updateWorkspace', (p) => [p.workspace]],
  [WEBHOOK_BOT_ENDPOINTS.setModel]: ['updateModel', (p) => [p.model]],
  [WEBHOOK_BOT_ENDPOINTS.setAgentPreset]: ['updateAgentPreset', (p) => [p.agentPreset]],
  [WEBHOOK_BOT_ENDPOINTS.setBusyMessageMode]: ['updateBusyMessageMode', (p) => [p.busyMessageMode]],
  [WEBHOOK_BOT_ENDPOINTS.setContextEnhancement]: ['updateContextEnhancement', (p) => [p.config]],
  [WEBHOOK_BOT_ENDPOINTS.setAccessPolicy]: ['updateAccessPolicy', (p) => [p.policy]],
  [WEBHOOK_BOT_ENDPOINTS.setAlias]: ['updateAlias', (p) => [p.alias]],
});

/**
 * @param {object} definition
 * @param {string} definition.channel            'line' | 'teams'
 * @param {string} definition.label              'LINE' | 'Teams'
 * @param {RegExp} definition.idPattern
 * @param {string[]} definition.credentialKeys   allowed bind-credentials keys
 * @param {(payload) => string|null} definition.validateCredentials
 * @param {(error) => object|null} [definition.operationError]
 */
export function createWebhookBotRpcHandler(controller, definition) {
  const { channel, label, idPattern, credentialKeys, validateCredentials } = definition;
  const diagnostics = controller.diagnostics ?? createConnectionDiagnostics({ channel });
  for (const method of ['status', 'bindCredentials', 'reconnectBot', 'deleteBot']) {
    if (typeof controller?.[method] !== 'function') throw new TypeError(`A complete ${label} controller is required (${method})`);
  }
  const validId = (value) => typeof value === 'string' && idPattern.test(value);
  const payloadFailure = (endpoint, payload) => {
    if (!isRecord(payload)) return 'Payload must be an object.';
    switch (endpoint) {
      case WEBHOOK_BOT_ENDPOINTS.status:
        return exactKeys(payload, []) ? null : 'connection.status does not accept fields.';
      case WEBHOOK_BOT_ENDPOINTS.bindCredentials:
        return exactKeys(payload, [...credentialKeys, 'createOnly']) && validCreateOnly(payload.createOnly)
          ? validateCredentials(payload)
          : `bot.bind-credentials accepts only ${credentialKeys.join(', ')}.`;
      case WEBHOOK_BOT_ENDPOINTS.reconnectBot:
        return exactKeys(payload, ['botId', 'sendTest']) && validId(payload.botId)
          && (payload.sendTest === undefined || typeof payload.sendTest === 'boolean') ? null : 'bot.reconnect requires a botId.';
      case WEBHOOK_BOT_ENDPOINTS.deleteBot:
        return exactKeys(payload, ['botId', 'confirm']) && validId(payload.botId) && payload.confirm === true
          ? null : 'bot.delete requires a botId and confirm=true.';
      case WEBHOOK_BOT_ENDPOINTS.setWorkspace: return validWorkspacePayload(payload) ? null : '请输入工作区绝对路径。';
      case WEBHOOK_BOT_ENDPOINTS.setModel: return validModelPayload(payload) ? null : '请选择有效模型。';
      case WEBHOOK_BOT_ENDPOINTS.setAgentPreset: return validAgentPresetPayload(payload) ? null : '请选择 Agent Preset。';
      case WEBHOOK_BOT_ENDPOINTS.setBusyMessageMode: return validMessageModePayload(payload) ? null : '请提交有效的消息处理方式。';
      case WEBHOOK_BOT_ENDPOINTS.setContextEnhancement: return validContextEnhancementPayload(payload) ? null : '请提交有效的上下文增强设置。';
      case WEBHOOK_BOT_ENDPOINTS.setAccessPolicy: return validAccessPolicyPayload(payload) ? null : '请提交有效的访问设置。';
      case WEBHOOK_BOT_ENDPOINTS.setAlias: return validAliasPayload(payload) ? null : '请输入有效的别名（最多 80 个字符）。';
      default: return `Unknown ${label} endpoint.`;
    }
  };
  const operationError = (error) => {
    const workspaceError = publicWorkspaceError(error);
    if (workspaceError) return workspaceError;
    const mapped = definition.operationError?.(error);
    if (mapped) return mapped;
    return { code: `${channel}-operation-failed`, message: `${label} 操作失败，请稍后重试。` };
  };
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return cancelled();
    if (!ENDPOINTS.includes(endpoint)) return validationRejected(`Unknown ${label} endpoint.`, { endpoint, payload });
    const invalid = payloadFailure(endpoint, payload);
    if (invalid) return validationRejected(invalid, { endpoint, payload, credentials: definition.credentialFields });
    try {
      let value;
      if (endpoint === WEBHOOK_BOT_ENDPOINTS.status) value = await controller.status();
      else if (endpoint === WEBHOOK_BOT_ENDPOINTS.bindCredentials) value = await controller.bindCredentials(payload);
      else if (endpoint === WEBHOOK_BOT_ENDPOINTS.reconnectBot) {
        value = await controller.reconnectBot(payload.botId);
        if (signal?.aborted) return cancelled();
        if (payload.sendTest === true) {
          let testError = null;
          try {
            if (value?.bots?.find((bot) => bot?.botId === payload.botId)?.connected !== true) {
              throw Object.assign(new Error('Bot is not connected'), { code: 'test-target-unavailable' });
            }
            if (typeof controller.sendConnectionTest !== 'function') {
              throw Object.assign(new Error('Connection test is unavailable'), { code: 'test-target-unavailable' });
            }
            await controller.sendConnectionTest(payload.botId);
          } catch (error) {
            testError = error;
          }
          value = { ...value, testMessage: publicConnectionTestResult(testError, { diagnostics, botId: payload.botId }) };
        }
      } else if (endpoint === WEBHOOK_BOT_ENDPOINTS.deleteBot) value = await controller.deleteBot(payload.botId);
      else {
        const [method, args] = SETTERS[endpoint];
        if (typeof controller[method] !== 'function') throw new Error(`${method} is unavailable`);
        value = await controller[method](payload.botId, ...args(payload));
      }
      return signal?.aborted ? cancelled() : { ok: true, value: sanitizeWebhookPublic(value) };
    } catch (error) {
      return diagnosticRpcResult(diagnostics, error, signal?.aborted ? cancelled() : { ok: false, error: operationError(error) },
        { operation: endpoint, botId: payload?.botId });
    }
  };
}

export function installWebhookBotRpc(ctx, controller, { rpcChannel, authority, ...definition }) {
  return registerManagementRpc(ctx, rpcChannel, createWebhookBotRpcHandler(controller, definition), {
    authority: resolveRpcAuthority(authority),
  });
}
