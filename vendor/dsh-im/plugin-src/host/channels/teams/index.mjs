// care fork: Microsoft Teams (Bot Framework) channel (webhook `/dsh-hooks/teams`).
import { resolve } from 'node:path';

import { TeamsConfigStore } from '../../../../src/channels/teams/config-store.mjs';
import { TeamsController } from '../../../../src/channels/teams/teams-controller.mjs';
import { TeamsHarnessClient } from '../../../../src/channels/teams/harness-client.mjs';
import { TeamsConnector, TeamsReferenceStore, inspectTeamsCredentials } from '../../../../src/channels/teams/teams-api.mjs';
import { BotFrameworkJwtVerifier, BotFrameworkTokenProvider } from '../../../../src/channels/teams/teams-auth.mjs';
import { TeamsRuntime } from '../../../../src/channels/teams/teams-runtime.mjs';
import { TeamsStateStore } from '../../../../src/channels/teams/state-store.mjs';
import { installProductionChannel } from '../shared/startup.mjs';
import { createWebhookProductionController } from '../shared/webhook-production.mjs';
import { createTeamsRpcHandler, installTeamsRpc, TEAMS_RPC_CHANNEL } from './rpc.mjs';

export const name = 'dsh-im-teams-host';
export const inject = ['connection', 'credentials', 'typertGateway'];

export function createProductionController(ctx, config = {}, internals = {}) {
  // Overrides exist for mock endpoints (tests / local checks); production uses the defaults.
  const loginBase = typeof config.loginBase === 'string' && config.loginBase ? config.loginBase : undefined;
  const metadataUrl = typeof config.openIdMetadataUrl === 'string' && config.openIdMetadataUrl ? config.openIdMetadataUrl : undefined;
  const verifier = new BotFrameworkJwtVerifier(metadataUrl ? { metadataUrl } : {});
  const createTokenProvider = (options) => new BotFrameworkTokenProvider({ ...options, ...(loginBase ? { loginBase } : {}) });
  return createWebhookProductionController(ctx, config, {
    ...(loginBase ? { inspectCredentials: (values) => inspectTeamsCredentials(values, { createTokenProvider }) } : {}),
    ...internals,
  }, {
    channel: 'teams',
    ConfigStore: TeamsConfigStore,
    StateStore: TeamsStateStore,
    HarnessClient: TeamsHarnessClient,
    Controller: TeamsController,
    Runtime: TeamsRuntime,
    perBotOptions: async ({ dataDir }) => ({
      verifier,
      references: await new TeamsReferenceStore(resolve(dataDir, 'references.json')).load(),
      createConnector: (options) => new TeamsConnector({
        ...options,
        tokenProvider: createTokenProvider(options),
        allowInsecureServiceUrl: config.allowInsecureServiceUrl === true,
      }),
    }),
  });
}

export async function apply(ctx, config = {}) {
  if (config?.controller) return installTeamsRpc(ctx, config.controller, config.rpcAuthority);
  return installProductionChannel(ctx, config, {
    channel: 'teams',
    rpcChannel: TEAMS_RPC_CHANNEL,
    createProduction: () => createProductionController(ctx, config, config.internals ?? {}),
    createHandler: (controller) => createTeamsRpcHandler(controller),
  });
}

export { TEAMS_ENDPOINTS, TEAMS_RPC_CHANNEL, createTeamsRpcHandler, installTeamsRpc } from './rpc.mjs';
export { TeamsController, TeamsRuntime };
