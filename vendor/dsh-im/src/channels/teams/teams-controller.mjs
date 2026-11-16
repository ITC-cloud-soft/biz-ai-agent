// care fork: Teams bot lifecycle (App ID + app password, optional tenant).
import { createWebhookBotControllerClass } from '../shared/webhook-bot-controller.mjs';
import { WEBHOOK_PATHS } from '../shared/webhook-hub.mjs';
import { TEAMS_IDENTITY, maskTeamsBotId } from './config-store.mjs';
import { inspectTeamsCredentials } from './teams-api.mjs';

export const TeamsController = createWebhookBotControllerClass({
  channel: 'teams',
  label: 'Teams',
  webhookPath: WEBHOOK_PATHS.teams,
  identity: TEAMS_IDENTITY,
  // The App ID travels in the payload but is the bot identity, not a secret.
  secretFields: { appPassword: 'passwordRef' },
  configFields: ['appId', 'tenantId'],
  inspectCredentials: (values) => inspectTeamsCredentials(values),
  publicBot: (config) => ({
    name: config.name,
    username: null,
    idMasked: maskTeamsBotId(config.platformId),
    appId: config.platformId,
    tenantMode: config.tenantId ? 'single' : 'multi',
    tenantId: config.tenantId ?? null,
  }),
});
