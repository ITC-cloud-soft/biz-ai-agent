// care fork: Teams bot list. The App ID is the platform id (not secret); the
// app password lives in ctx.credentials under `passwordRef`.
import { createWebhookConfigStore, defineWebhookIdentity, maskPlatformId } from '../shared/webhook-config-store.mjs';

export const TEAMS_IDENTITY = defineWebhookIdentity({
  channel: 'teams',
  refs: { passwordRef: 'DSH_TEAMS_APP_PASSWORD_' },
});

export const deriveTeamsBotIdentity = (platformId) => TEAMS_IDENTITY.derive(platformId);
export const maskTeamsBotId = (platformId) => maskPlatformId(platformId, 'Teams Bot');

export class TeamsConfigStore extends createWebhookConfigStore(TEAMS_IDENTITY, { extra: ['tenantId'] }) {}
