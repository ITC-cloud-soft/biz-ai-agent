// care fork: production wiring for the webhook channels (LINE, Teams). Mirrors
// the Slack production controller: workspace store, per-bot state, access
// policy, Harness client, connection supervisor and delivery adapter.

import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import { getImageInputSettingsStore } from '../../../../src/channels/shared/image-input-settings-store.mjs';
import {
  BotWorkspaceStore,
  createBotWorkspaceScope,
  createWorkspaceAwareController,
  observeBotWorkspaceRemovals,
} from '../../../../src/channels/shared/bot-workspace-store.mjs';
import { prepareBotWorkspace } from '../../../../src/channels/shared/default-workspace.mjs';
import { listAgentPresetCatalog } from '../../../../src/channels/shared/agent-preset.mjs';
import { listModelCatalog } from '../../../../src/channels/shared/model-setting.mjs';
import { webhookHub } from '../../../../src/channels/shared/webhook-hub.mjs';
import { createDeliveryAdapter } from '../../delivery-adapter.mjs';
import { createHarnessCommandExecutor } from '../../harness-command-executor.mjs';
import { harnessConnection } from '../../harness-connection.mjs';
import { createHarnessSessionExecutors } from '../../harness-session-coordinator.mjs';
import { getInboundTtlRuntime, registerInboundTtlWorkspaces } from '../../inbound-ttl-runtime.mjs';
import { createTokenConnectionSupervisor } from './connection-supervisor.mjs';
import { pluginPaths } from './production.mjs';
import { accessPolicyProvider, initialAccessPolicyFor } from './access-policy-production.mjs';

export async function createWebhookProductionController(ctx, config = {}, internals = {}, definitions) {
  const { channel, ConfigStore, StateStore, HarnessClient, Controller, Runtime } = definitions;
  if (!ctx?.credentials) throw new TypeError(`dsh-im ${channel} requires ctx.credentials`);
  const connection = harnessConnection(ctx, config, { competitiveApprovals: true });
  const ResolvedConfigStore = internals.ConfigStore ?? ConfigStore;
  const ResolvedStateStore = internals.StateStore ?? StateStore;
  const ResolvedHarness = internals.HarnessClient ?? HarnessClient;
  const ResolvedController = internals.Controller ?? Controller;
  const ResolvedRuntime = internals.Runtime ?? Runtime;
  const createSupervisor = internals.createConnectionSupervisor ?? createTokenConnectionSupervisor;
  const logger = typeof ctx.logger === 'function' ? ctx.logger(`dsh-im:${channel}`) : (ctx.logger ?? console);
  const agentPresetCatalog = () => listAgentPresetCatalog(ctx);
  const paths = pluginPaths(config, channel);
  const configStore = await new ResolvedConfigStore(paths.config).load();
  const { defaultWorkspace, ungroupedWorkspace } = await prepareBotWorkspace(config);
  const WorkspaceStore = internals.WorkspaceStore ?? BotWorkspaceStore;
  const workspaces = internals.workspaces
    ?? await new WorkspaceStore(paths.workspaces, { defaultWorkspace, ungroupedWorkspace }).load();
  const configuredBots = configStore.list();
  await workspaces.reconcile(configuredBots.map((bot) => bot.botId));
  const ensureWorkspace = (botId, botConfig) => workspaces.ensure(botId, {
    defaultAgentPreset: config.agentPreset,
    initialAccessPolicy: initialAccessPolicyFor(channel, botConfig),
  });
  await Promise.all(configuredBots.map((bot) => ensureWorkspace(bot.botId, bot)));
  const observedConfigStore = observeBotWorkspaceRemovals(configStore, { workspaces });
  const stateStores = new Map();
  const statePath = (botId) => resolve(paths.bots, botId, 'state.json');
  const stateFor = async (botId) => {
    let state = stateStores.get(botId);
    if (!state) {
      state = await new ResolvedStateStore(statePath(botId)).load();
      stateStores.set(botId, state);
    }
    return state;
  };
  const commandExecutor = createHarnessCommandExecutor(ctx, internals.commandExecutor);
  const inboundTtl = internals.inboundTtl ?? getInboundTtlRuntime(ctx, config);
  const inboundTtlService = inboundTtl?.service ?? inboundTtl;
  registerInboundTtlWorkspaces(ctx, inboundTtlService, { workspaces, configStore: observedConfigStore, defaultWorkspace });
  const { controlExecutor, sessionMaintenanceExecutor, fileIngressExecutor } = createHarnessSessionExecutors(ctx, {
    controlExecutor: internals.controlExecutor,
    sessionMaintenanceExecutor: internals.sessionMaintenanceExecutor,
    fileIngressExecutor: internals.fileIngressExecutor,
    inboundTtlService,
  });
  const harness = new ResolvedHarness({
    ...connection,
    workspace: defaultWorkspace,
    ungroupedWorkspace,
    autostart: false,
    dshBin: config.dshBin ?? 'dsh',
    ...(commandExecutor ? { commandExecutor } : {}),
    ...(controlExecutor ? { controlExecutor } : {}),
    ...(sessionMaintenanceExecutor ? { sessionMaintenanceExecutor } : {}),
    ...(fileIngressExecutor ? { fileIngressExecutor } : {}),
    imageInputPolicy: () => getImageInputSettingsStore(config).get(),
  });
  const modelCatalog = (options) => listModelCatalog(harness, options);
  const coreController = new ResolvedController({
    credentials: ctx.credentials,
    configStore: observedConfigStore,
    logger,
    ...(internals.inspectCredentials ? { inspectCredentials: internals.inspectCredentials } : {}),
    createRuntime: async ({ botId, config: botConfig, secrets }) => {
      const state = await stateFor(botId);
      await ensureWorkspace(botId, botConfig);
      const workspaceScope = createBotWorkspaceScope(harness, {
        dsBot: config.deliveryService?.dsBot,
        botId, workspaces, state, agentPresetCatalog,
      });
      const perBot = typeof definitions.perBotOptions === 'function'
        ? await definitions.perBotOptions({ botId, config: botConfig, dataDir: resolve(paths.bots, botId), channelConfig: config })
        : {};
      return new ResolvedRuntime({
        ...perBot,
        config: botConfig,
        secrets,
        harness: workspaceScope.harness,
        state: workspaceScope.state,
        contextEnhancement: { botId, getSettings: () => workspaces.contextEnhancementFor(botId) },
        accessPolicy: accessPolicyProvider(workspaces, botId, { channel, config: botConfig }),
        replyTimeoutMs: config.replyTimeoutMs ?? 600_000,
        webhooks: internals.webhooks ?? webhookHub,
        logger: {
          error: (...args) => logger.error?.(`[${botId}]`, ...args),
          warn: (...args) => logger.warn?.(`[${botId}]`, ...args),
          info: (...args) => logger.info?.(`[${botId}]`, ...args),
          debug: (...args) => logger.debug?.(`[${botId}]`, ...args),
        },
      });
    },
    deleteState: async ({ botId }) => {
      const state = stateStores.get(botId);
      stateStores.delete(botId);
      if (state && typeof state.remove === 'function') {
        await state.remove();
      } else {
        try { await unlink(statePath(botId)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
    },
  });
  const controller = createWorkspaceAwareController(coreController, { workspaces, stateFor, agentPresetCatalog, modelCatalog });
  const supervisor = createSupervisor({
    channel, controller, harness, logger,
    retryDelaysMs: config.retryDelaysMs,
    healthyIntervalMs: config.healthyIntervalMs,
  }).start();
  return {
    controller,
    deliveryAdapter: createDeliveryAdapter({ dsBot: config.deliveryService?.dsBot, channel, workspaces, coreController, stateFor }),
    ready: supervisor.ready,
    async close() {
      await supervisor.close();
      await controller.close();
      harness.stopManagedProcess();
    },
  };
}
