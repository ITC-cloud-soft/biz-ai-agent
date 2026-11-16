// care fork: `/line` management RPC (same endpoint names as the token channels).
import { createWebhookBotRpcHandler, installWebhookBotRpc, WEBHOOK_BOT_ENDPOINTS } from '../shared/webhook-rpc.mjs';

export const LINE_RPC_CHANNEL = '/line';
export const LINE_ENDPOINTS = WEBHOOK_BOT_ENDPOINTS;
export const LINE_RPC_ENDPOINTS = Object.freeze(Object.values(LINE_ENDPOINTS));

export const LINE_CHANNEL_SECRET_PATTERN = /^[0-9a-f]{32}$/i;
export const LINE_ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9+/=._-]{20,4096}$/;

export function validateLineCredentials(payload) {
  const secret = typeof payload.channelSecret === 'string' ? payload.channelSecret.trim() : '';
  const token = typeof payload.channelAccessToken === 'string' ? payload.channelAccessToken.trim() : '';
  if (!LINE_CHANNEL_SECRET_PATTERN.test(secret)) return 'channelSecret must be the 32-character hex Channel secret.';
  if (!LINE_ACCESS_TOKEN_PATTERN.test(token)) return 'channelAccessToken must be a long-lived Channel access token.';
  return null;
}

export function lineOperationError(error) {
  if (error?.code === 'line-401') {
    return { code: 'invalid-token', message: 'LINE Channel Access Token 无效，请重新填写。' };
  }
  if (error?.code === 'line-403') {
    return { code: 'forbidden', message: 'LINE 拒绝了此 Channel Access Token 的请求，请检查 Messaging API 渠道设置。' };
  }
  if (error?.code === 'line-identity-mismatch' || error?.code === 'line-invalid-identity') {
    return { code: 'identity-mismatch', message: 'LINE 返回的机器人身份与已保存的不一致，请移除后重新接入。' };
  }
  if (/^line-(transport-error|timeout|5\d\d|429)$/.test(String(error?.code ?? ''))) {
    return { code: 'line-network-error', message: '无法访问 LINE Messaging API，请检查网络后重试。' };
  }
  return null;
}

const DEFINITION = Object.freeze({
  channel: 'line',
  label: 'LINE',
  idPattern: /^line_[a-f0-9]{24}$/,
  credentialKeys: ['channelSecret', 'channelAccessToken'],
  // care fork: field-level reasons for a rejected bind (validation-reason.mjs).
  credentialFields: Object.freeze([
    { name: 'channelSecret', valid: (value) => typeof value === 'string' && LINE_CHANNEL_SECRET_PATTERN.test(value.trim()) },
    { name: 'channelAccessToken', valid: (value) => typeof value === 'string' && LINE_ACCESS_TOKEN_PATTERN.test(value.trim()) },
  ]),
  validateCredentials: validateLineCredentials,
  operationError: lineOperationError,
});

export function createLineRpcHandler(controller) {
  return createWebhookBotRpcHandler(controller, DEFINITION);
}

export function installLineRpc(ctx, controller, authority) {
  return installWebhookBotRpc(ctx, controller, { ...DEFINITION, rpcChannel: LINE_RPC_CHANNEL, authority });
}
