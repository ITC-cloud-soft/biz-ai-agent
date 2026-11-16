// care fork: LINE bot lifecycle (channel secret + channel access token).
import { createWebhookBotControllerClass } from '../shared/webhook-bot-controller.mjs';
import { WEBHOOK_PATHS } from '../shared/webhook-hub.mjs';
import { LINE_IDENTITY, maskLineBotId } from './config-store.mjs';
import { inspectLineCredentials } from './line-api.mjs';

export const LineController = createWebhookBotControllerClass({
  channel: 'line',
  label: 'LINE',
  webhookPath: WEBHOOK_PATHS.line,
  identity: LINE_IDENTITY,
  secretFields: { channelSecret: 'secretRef', channelAccessToken: 'tokenRef' },
  inspectCredentials: (values) => inspectLineCredentials(values),
  publicBot: (config) => ({
    name: config.name,
    username: config.username ? config.username.replace(/^@/, '') : null,
    idMasked: maskLineBotId(config.platformId),
  }),
});
