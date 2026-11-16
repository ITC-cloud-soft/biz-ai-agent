// care fork: LINE bot list. Secrets live in ctx.credentials under the refs.
import { createWebhookConfigStore, defineWebhookIdentity, maskPlatformId } from '../shared/webhook-config-store.mjs';

export const LINE_IDENTITY = defineWebhookIdentity({
  channel: 'line',
  refs: { secretRef: 'DSH_LINE_CHANNEL_SECRET_', tokenRef: 'DSH_LINE_ACCESS_TOKEN_' },
});

export const deriveLineBotIdentity = (platformId) => LINE_IDENTITY.derive(platformId);
export const maskLineBotId = (platformId) => maskPlatformId(platformId, 'LINE Bot');

export class LineConfigStore extends createWebhookConfigStore(LINE_IDENTITY, { extra: ['username'] }) {}
