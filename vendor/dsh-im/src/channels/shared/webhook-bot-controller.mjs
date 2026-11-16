// care fork: bot lifecycle for the webhook channels (LINE, Teams). Same shape
// and guarantees as SlackController (credentials only in ctx.credentials,
// per-bot serialized transitions, rollback on a failed save), parameterized by
// the channel's credential fields.

import { atConnectionStage, createConnectionDiagnostics, extractConnectionEvidence } from './connection-error.mjs';
import { connectionTestMessage } from './connection-test.mjs';
import { publicMessageFailure } from './message-failure.mjs';
import { t } from './i18n.mjs';
import { assertCreatable } from './create-only.mjs';

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeError(code, message) {
  return Object.freeze({ code, message });
}

/**
 * @param {object} definition
 * @param {string} definition.channel                 'line' | 'teams'
 * @param {string} definition.label                   'LINE' | 'Microsoft Teams'
 * @param {string} definition.webhookPath             '/dsh-hooks/<channel>'
 * @param {object} definition.identity                defineWebhookIdentity(...)
 * @param {Record<string,string>} definition.secretFields  payload field → config ref field
 * @param {string[]} [definition.configFields]        non-secret payload fields kept in config
 * @param {(values, options) => Promise<object>} definition.inspectCredentials
 *   → { platformId, name, username?, ...extra }
 * @param {(config) => object} definition.publicBot   status `bot` block (no secrets)
 */
export function createWebhookBotControllerClass(definition) {
  const {
    channel, label, webhookPath, identity, secretFields, configFields = [], publicBot,
  } = definition;
  const secretEntries = Object.entries(secretFields);

  return class WebhookBotController {
    #credentials;
    #configStore;
    #inspectCredentials;
    #createRuntime;
    #deleteState;
    #logger;
    #diagnostics;
    #runtimes = new Map();
    #errors = new Map();
    #transitions = new Map();
    #revision = 0;
    #closed = false;

    constructor({
      credentials, configStore, inspectCredentials = definition.inspectCredentials, createRuntime,
      deleteState = async () => {}, logger = console,
    }) {
      if (!credentials || typeof credentials.resolve !== 'function'
        || typeof credentials.set !== 'function' || typeof credentials.unset !== 'function') {
        throw new TypeError(`${label} requires the DSH credential provider`);
      }
      if (!configStore || typeof configStore.list !== 'function'
        || typeof configStore.save !== 'function' || typeof configStore.remove !== 'function') {
        throw new TypeError(`${label} requires a config store`);
      }
      if (typeof inspectCredentials !== 'function' || typeof createRuntime !== 'function') {
        throw new TypeError(`${label} controller dependencies are incomplete`);
      }
      this.#credentials = credentials;
      this.#configStore = configStore;
      this.#inspectCredentials = inspectCredentials;
      this.#createRuntime = createRuntime;
      this.#deleteState = deleteState;
      this.#logger = logger;
      this.#diagnostics = createConnectionDiagnostics({ channel, logger });
    }

    get diagnostics() { return this.#diagnostics; }

    #failure(error, code, message) {
      return this.#diagnostics.report(error, { reuse: true, stage: 'connection.start', publicError: { code, message } }).publicError;
    }

    async initialize() {
      if (this.#closed) return this.status();
      for (const config of this.#configStore.list()) {
        await this.#withBotTransition(config.botId, async () => {
          if (this.#closed || this.#runtimes.get(config.botId)?.status?.ready) return;
          try {
            const secrets = await this.#resolveSecrets(config);
            if (!secrets) {
              this.#errors.set(config.botId, safeError('missing-token', t('{label}机器人凭据缺失，请移除后重新接入。', { label })));
              return;
            }
            await this.#startRuntime(config, secrets);
            this.#errors.delete(config.botId);
          } catch (error) {
            this.#errors.set(config.botId, this.#failure(error, 'connection-failed', t('{label}连接未就绪，插件会自动重试。', { label })));
          } finally {
            this.#touch();
          }
        });
      }
      return this.status();
    }

    async bindCredentials(payload = {}) {
      if (this.#closed) throw new Error(`${label} controller is closed`);
      const values = {};
      for (const [field] of secretEntries) {
        const value = cleanString(payload[field]);
        if (!value) throw new TypeError(`${label} ${field} is required`);
        values[field] = value;
      }
      for (const field of configFields) {
        const value = cleanString(payload[field]);
        if (value) values[field] = value;
      }
      const inspected = await this.#inspectCredentials(values);
      const platformId = cleanString(inspected?.platformId);
      const name = cleanString(inspected?.name);
      if (!platformId || !name) throw new Error(`${label} returned an invalid bot identity`);
      const derived = identity.derive(platformId);

      await this.#withBotTransition(derived.botId, async () => {
        if (this.#closed) throw new Error(`${label} controller is closed`);
        const previousConfig = this.#configStore.getByPlatformId(platformId);
        assertCreatable(payload.createOnly, previousConfig, this.#configStore.get?.(derived.botId));
        const previous = {};
        for (const [, refField] of secretEntries) {
          previous[refField] = await atConnectionStage('credential.read', () => this.#credentials.resolve(derived[refField]), 'credential-store');
        }
        const extra = {};
        for (const [key, value] of Object.entries(inspected)) {
          if (!['platformId', 'name'].includes(key) && !secretFields[key]) extra[key] = cleanString(value);
        }
        for (const field of configFields) extra[field] = values[field] ?? null;
        const config = {
          ...extra,
          ...derived,
          platformId,
          name,
          createdAt: previousConfig?.createdAt ?? new Date().toISOString(),
          connectedAt: new Date().toISOString(),
        };
        try {
          for (const [field, refField] of secretEntries) {
            await atConnectionStage('credential.save', () => this.#credentials.set(derived[refField], values[field]), 'credential-store');
          }
          await atConnectionStage('account.save', () => this.#configStore.save(config), 'account-config');
        } catch (error) {
          await Promise.all(secretEntries.map(([, refField]) => this.#restoreCredential(derived[refField], previous[refField])));
          throw error;
        }
        const saved = this.#configStore.get(derived.botId) ?? config;
        try {
          await this.#startRuntime(saved, Object.fromEntries(secretEntries.map(([field]) => [field, values[field]])));
          this.#errors.delete(derived.botId);
        } catch (error) {
          this.#errors.set(derived.botId, this.#failure(error, 'connection-failed', t('{label}机器人已接入，连接暂未就绪。', { label })));
        }
        this.#touch();
      });
      return this.status();
    }

    async reconnectBot(botId) {
      const config = this.#configStore.get(botId);
      if (!config) throw new Error(`Unknown ${label} bot`);
      await this.#withBotTransition(botId, async () => {
        const secrets = await this.#resolveSecrets(config);
        if (!secrets) throw new Error(`${label} bot credentials are missing`);
        try {
          await this.#startRuntime(config, secrets);
          this.#errors.delete(botId);
        } catch (error) {
          this.#errors.set(botId, this.#failure(error, 'connection-failed', t('{label}连接仍未就绪，请检查凭据。', { label })));
          throw error;
        } finally {
          this.#touch();
        }
      });
      return this.status();
    }

    #readyRuntime(botId, method, code) {
      const runtime = this.#runtimes.get(botId);
      if (!runtime?.status?.ready || typeof runtime[method] !== 'function') {
        const error = new Error(t('{label}机器人尚未连接', { label }));
        error.code = code;
        throw error;
      }
      return runtime;
    }

    async sendConnectionTest(botId) {
      const config = this.#configStore.get(botId);
      if (!config) throw new Error(`Unknown ${label} bot`);
      return this.#withBotTransition(botId, async () => {
        const runtime = this.#readyRuntime(botId, 'sendConnectionTest', 'test-target-unavailable');
        await runtime.sendConnectionTest(connectionTestMessage(config.name, t('{label}机器人', { label })));
        return { sent: true };
      });
    }

    async sendProactiveText(botId, target, text, options = {}) {
      if (!this.#configStore.get(botId)) throw new Error(`Unknown ${label} bot`);
      return this.#withBotTransition(botId, async () => (
        this.#readyRuntime(botId, 'sendProactiveText', 'bot-not-connected').sendProactiveText(target, text, options)
      ));
    }

    async presentSessionSyncApproval(botId, target, interaction, options = {}) {
      if (!this.#configStore.get(botId)) throw new Error(`Unknown ${label} bot`);
      return this.#withBotTransition(botId, async () => {
        const runtime = this.#runtimes.get(botId);
        if (!runtime?.status?.ready || typeof runtime.presentSessionSyncApproval !== 'function') return false;
        return runtime.presentSessionSyncApproval(target, interaction, options);
      });
    }

    async deleteBot(botId) {
      const warnings = [];
      const config = this.#configStore.get(botId);
      if (!config) throw new Error(`Unknown ${label} bot`);
      await this.#withBotTransition(botId, async () => {
        const previous = {};
        for (const [, refField] of secretEntries) {
          previous[refField] = await atConnectionStage('credential.read', () => this.#credentials.resolve(config[refField]), 'credential-store');
        }
        await this.#stopRuntime(botId);
        try {
          for (const [, refField] of secretEntries) {
            await atConnectionStage('credential.remove', () => this.#credentials.unset(config[refField]), 'credential-store');
          }
          await atConnectionStage('account.remove', () => this.#configStore.remove(botId), 'account-config');
        } catch (error) {
          await Promise.all(secretEntries.map(([, refField]) => this.#restoreCredential(config[refField], previous[refField])));
          throw new Error(`Unable to remove the ${label} bot safely.`, { cause: error });
        }
        await this.#deleteState({ botId, config }).catch((error) => {
          warnings.push(this.#diagnostics.report(error, {
            reuse: true, operation: 'bot.delete', stage: 'state.cleanup', resource: 'account-state', warning: true,
            publicError: { code: 'cleanup-failed', message: '账号已移除，但本地状态清理失败。' },
          }).publicError);
        });
        this.#errors.delete(botId);
        this.#touch();
      });
      return { ...this.status(), ...(warnings.length ? { warnings } : {}) };
    }

    status() {
      const bots = this.#configStore.list().map((config) => {
        const runtimeStatus = this.#runtimes.get(config.botId)?.status ?? null;
        const connected = runtimeStatus?.ready === true
          && runtimeStatus.connectionState === 'connected'
          && runtimeStatus.harnessReachable === true;
        const state = connected ? 'connected'
          : runtimeStatus?.connectionState === 'connecting' ? 'connecting'
            : this.#errors.has(config.botId) || runtimeStatus?.connectionState === 'failed' ? 'error' : 'offline';
        return {
          botId: config.botId,
          state,
          connected,
          configured: true,
          webhookPath,
          bot: publicBot(config),
          health: {
            status: connected ? 'healthy' : state === 'error' ? 'error' : 'offline',
            summary: connected ? t('{label} Webhook 运行正常', { label })
              : state === 'error' ? t('{label}连接未就绪，插件会自动重试', { label })
                : t('{label}连接当前离线', { label }),
            lastCheckedAt: runtimeStatus?.lastCheckedAt ?? null,
            lastConnectedAt: runtimeStatus?.lastConnectedAt ?? null,
            lastWebhookAt: runtimeStatus?.lastWebhookAt ?? null,
          },
          stats: {
            messagesReceived: runtimeStatus?.messagesReceived ?? 0,
            messagesReplied: runtimeStatus?.messagesReplied ?? 0,
            webhooksRejected: runtimeStatus?.webhooksRejected ?? 0,
          },
          lastMessageError: publicMessageFailure(runtimeStatus?.lastMessageError),
          error: structuredClone(runtimeStatus?.error ?? this.#errors.get(config.botId) ?? null),
        };
      });
      const connected = bots.filter((bot) => bot.connected).length;
      return {
        schemaVersion: 1,
        revision: this.#revision,
        webhookPath,
        state: bots.length === 0 ? 'disconnected'
          : connected === bots.length ? 'connected'
            : connected > 0 ? 'degraded' : 'offline',
        bots,
        totals: { configured: bots.length, connected },
      };
    }

    async close() {
      if (this.#closed) return;
      this.#closed = true;
      await Promise.allSettled([...this.#transitions.values()]);
      await Promise.allSettled([...this.#runtimes.keys()].map((botId) => this.#stopRuntime(botId)));
    }

    async #startRuntime(config, secrets) {
      if (this.#closed) throw new Error(`${label} controller is closed`);
      await this.#stopRuntime(config.botId);
      const runtime = await atConnectionStage('runtime.prepare', () => this.#createRuntime({ botId: config.botId, config, secrets }));
      if (!runtime || typeof runtime.start !== 'function' || typeof runtime.stop !== 'function') {
        throw new TypeError(`createRuntime returned an invalid ${label} runtime`);
      }
      this.#runtimes.set(config.botId, runtime);
      try {
        await runtime.start();
      } catch (error) {
        await runtime.stop().catch(() => undefined);
        this.#runtimes.delete(config.botId);
        throw error;
      }
    }

    async #stopRuntime(botId) {
      const runtime = this.#runtimes.get(botId);
      this.#runtimes.delete(botId);
      await runtime?.stop().catch((error) => {
        this.#logger.warn?.(`[dsh-im:${channel}] bot ${botId} failed to stop cleanly:`, extractConnectionEvidence(error).details);
      });
    }

    async #resolveSecrets(config) {
      const secrets = {};
      for (const [field, refField] of secretEntries) {
        const resolved = await atConnectionStage('credential.read', () => this.#credentials.resolve(config[refField]), 'credential-store');
        const value = cleanString(resolved?.value);
        if (!value) return null;
        secrets[field] = value;
      }
      return secrets;
    }

    async #restoreCredential(ref, previous) {
      if (previous?.value) await atConnectionStage('credential.save', () => this.#credentials.set(ref, previous.value), 'credential-store').catch(() => undefined);
      else await atConnectionStage('credential.remove', () => this.#credentials.unset(ref), 'credential-store').catch(() => undefined);
    }

    #withBotTransition(botId, operation) {
      const previous = this.#transitions.get(botId) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(operation);
      const settled = current.finally(() => {
        if (this.#transitions.get(botId) === settled) this.#transitions.delete(botId);
      });
      this.#transitions.set(botId, settled);
      return settled;
    }

    #touch() { this.#revision += 1; }
  };
}
