import {
  AssistantTextAccumulator,
  consumeDshImInputOrigin,
  textFromHarnessContent,
} from '../../src/channels/shared/harness-client.mjs';
import { deliverSessionSyncMirror } from '../../src/channels/shared/session-sync-registry.mjs';

const DSH_USER_PREFIX = '[来自 DSH]\n';
const DSH_ASSISTANT_PREFIX = '[DSH 助手]\n\n';

function completedTurn(reason) {
  return (typeof reason === 'string' ? reason : reason?.kind) === 'completed';
}

function recipientKey(target) {
  return JSON.stringify([target.channel, target.botId, target.targetId]);
}

function sessionIdOf(session) {
  const value = session?.id ?? session?.sessionId;
  return typeof value === 'string' && value ? value : null;
}

/**
 * care fork: whether a plugin-produced user message (e.g. a dsh-proactive wake,
 * `{ kind: 'plugin:dsh-proactive' }`, or the legacy v3 `{ kind: 'plugin',
 * plugin: 'dsh-proactive' }`) is configured to be mirrored like a schedule.
 */
export function forwardedPluginSource(source, allowed) {
  if (!allowed || allowed.size === 0 || typeof source?.kind !== 'string') return false;
  if (source.kind.startsWith('plugin:')) return allowed.has(source.kind.slice('plugin:'.length));
  return source.kind === 'plugin' && typeof source.plugin === 'string' && allowed.has(source.plugin);
}

export function normalizeForwardPluginSources(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return new Set(list.filter((name) => typeof name === 'string' && /^[@a-z0-9][@a-z0-9._/-]{0,127}$/i.test(name.trim()))
    .map((name) => name.trim()));
}

function userInputOrigin(scope, event, forwardPluginSources) {
  const source = event?.data?.source;
  if (source?.kind === 'schedule' || source?.kind === 'user-question-reply') return 'dsh';
  if (forwardedPluginSource(source, forwardPluginSources)) return 'dsh';
  if (source?.kind !== 'user' || typeof source.rpcId !== 'string' || !source.rpcId) {
    return 'other';
  }
  return consumeDshImInputOrigin(scope, source.rpcId) ? 'im' : 'dsh';
}

function validRecipient(target) {
  return target && typeof target === 'object'
    && typeof target.channel === 'string' && target.channel
    && typeof target.botId === 'string' && target.botId
    && typeof target.targetId === 'string' && target.targetId;
}

export function createSessionSyncCoordinator({ deliveryService, logger = console, forwardPluginSources = [] }) {
  const forwardedPlugins = normalizeForwardPluginSources(forwardPluginSources);
  if (typeof deliveryService?.listSessionSyncTargets !== 'function'
    || typeof deliveryService?.sendSessionSyncText !== 'function') {
    throw new TypeError('Session sync requires a complete delivery service');
  }

  const turns = new Map();
  const tails = new Map();
  let closed = false;

  const logFailure = (phase, target, error) => {
    logger.warn?.(
      `[dsh-im] ignored Session sync ${phase} failure`
        + (target ? ` (${target.channel}/${target.botId}/${target.targetId})` : '')
        + ` [${error?.code ?? error?.name ?? 'unknown-error'}]`,
    );
  };

  const deliver = async (sessionId, targets, text, phase, format = 'plain') => {
    const unique = new Map();
    for (const target of targets) {
      if (validRecipient(target)) unique.set(recipientKey(target), target);
    }
    const entries = [...unique.entries()];
    const results = await Promise.allSettled(entries.map(([, target]) => (
      deliveryService.sendSessionSyncText(
        target.botId,
        target.targetId,
        sessionId,
        text,
        // Feishu has already tried its dedicated mirror card. Preserve its
        // existing plain fallback instead of attempting another rich card.
        { format: target.channel === 'feishu' ? 'plain' : format },
      )
    )));
    const successful = new Map();
    results.forEach((result, index) => {
      const [key, target] = entries[index];
      if (result.status === 'fulfilled') successful.set(key, target);
      else logFailure(phase, target, result.reason);
    });
    return successful;
  };

  const processEvent = async (sessionId, event, origin) => {
    if (closed || !event || typeof event !== 'object') return;

    if (event.type === 'turn/start') {
      const turn = event.data?.turn;
      if (!Number.isSafeInteger(turn)) return;
      turns.set(sessionId, {
        turn,
        step: null,
        origin: 'unknown',
        recipients: null,
        assistant: new AssistantTextAccumulator(),
      });
      return;
    }

    const state = turns.get(sessionId);
    if (!state) return;

    if (event.type === 'step/start') {
      if (event.data?.turn !== undefined && event.data.turn !== state.turn) return;
      state.step = Number.isSafeInteger(event.data?.step) ? event.data.step : null;
      return;
    }

    if (event.type === 'step/end') {
      if (event.data?.turn !== undefined && event.data.turn !== state.turn) return;
      if (event.data?.step === undefined || event.data.step === state.step) state.step = null;
      return;
    }

    if (event.type === 'user/message') {
      if (event.surfaceOp !== 'append') return;
      if (state.origin === 'unknown') state.origin = origin;
      if (state.origin !== 'dsh' || origin !== 'dsh') return;
      // care fork: configured plugin wakes (dsh-proactive) are internal input too:
      // their framing is not echoed, but the final answer is mirrored.
      const internalInput = ['schedule', 'user-question-reply'].includes(event.data?.source?.kind)
        || forwardedPluginSource(event.data?.source, forwardedPlugins);
      const text = textFromHarnessContent(event.data?.content);
      if (!text && !internalInput) return;

      let targets;
      try {
        targets = await deliveryService.listSessionSyncTargets(sessionId);
      } catch (error) {
        logFailure('lookup', null, error);
        targets = [];
      }
      // Reminder/question-answer framing is internal: select recipients without echoing it.
      // Direct DSH input still requires a successful echo before the final answer.
      const recipients = internalInput
        ? new Map(targets.filter(validRecipient).map((target) => [recipientKey(target), target]))
        : await deliver(sessionId, targets, `${DSH_USER_PREFIX}${text}`, 'user delivery');
      if (state.recipients === null) {
        state.recipients = recipients;
      } else {
        for (const key of [...state.recipients.keys()]) {
          if (!recipients.has(key)) state.recipients.delete(key);
        }
      }
      return;
    }

    if (event.type === 'assistant/message') {
      if (state.origin !== 'dsh' || event.surfaceOp !== 'append'
        || event.data?.interrupted === true
        || (event.data?.turn !== undefined && event.data.turn !== state.turn)) return;
      const text = textFromHarnessContent(event.data?.message?.content);
      const step = Number.isSafeInteger(event.data?.step) ? event.data.step : state.step;
      state.assistant.setCanonical(step, text);
      return;
    }

    if (event.type !== 'turn/end' || event.data?.turn !== state.turn) return;
    turns.delete(sessionId);
    if (state.origin !== 'dsh' || !completedTurn(event.data?.reason)
      || !state.recipients?.size || !state.assistant.text) return;
    // A pending card is not proof of delivery. Only suppress this target's
    // text after its renderer confirms the complete final answer is visible.
    // Targets without a renderer retain the original text delivery path.
    const recipients = [...state.recipients.values()];
    const rendered = await Promise.all(recipients.map(async (target) => {
      try {
        return await deliverSessionSyncMirror(target, sessionId, state.turn, state.assistant.text);
      } catch (error) {
        logFailure('card delivery', target, error);
        return false;
      }
    }));
    const fallback = recipients.filter((_target, index) => !rendered[index]);
    if (fallback.length === 0) return;
    await deliver(
      sessionId,
      fallback,
      `${DSH_ASSISTANT_PREFIX}${state.assistant.text}`,
      'assistant delivery',
      'markdown',
    );
  };

  const enqueue = (sessionId, event, origin = 'other') => {
    if (closed || typeof sessionId !== 'string' || !sessionId) return Promise.resolve();
    const previous = tails.get(sessionId) ?? Promise.resolve();
    const task = previous.then(
      () => processEvent(sessionId, event, origin),
      () => processEvent(sessionId, event, origin),
    );
    const tail = task.catch((error) => logFailure('event handling', null, error)).finally(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    });
    tails.set(sessionId, tail);
    return tail;
  };

  return Object.freeze({
    enqueue,
    async whenIdle() {
      while (tails.size > 0) await Promise.allSettled([...tails.values()]);
    },
    close() {
      closed = true;
      turns.clear();
    },
  });
}

export function installSessionSyncCoordinator(ctx, deliveryService, {
  logger = console,
  inputScope = ctx?.root ?? ctx,
  forwardPluginSources = [],
  onTurnEvent,
} = {}) {
  if (typeof ctx?.on !== 'function') {
    throw new TypeError('Session sync requires Host session events');
  }
  const forwardedPlugins = normalizeForwardPluginSources(forwardPluginSources);
  const coordinator = createSessionSyncCoordinator({ deliveryService, logger, forwardPluginSources: [...forwardedPlugins] });
  const disposeEvent = ctx.on('session/event', (session, event) => {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return;
    // care fork: turn boundaries for ctx.dshIm.sourceForTurn().
    if (typeof onTurnEvent === 'function' && (event?.type === 'turn/start' || event?.type === 'turn/end')) {
      try { onTurnEvent(sessionId, event); } catch { /* source tracking never blocks sync */ }
    }
    // Origin lookup must be synchronous: the originating ask may clean its id
    // immediately after this event callback returns.
    const origin = event?.type === 'user/message'
      ? userInputOrigin(inputScope, event, forwardedPlugins)
      : 'other';
    void coordinator.enqueue(sessionId, event, origin);
  }, { global: true });
  let disposed = false;
  const close = () => {
    if (disposed) return;
    disposed = true;
    disposeEvent?.();
    coordinator.close();
  };
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => close, 'dsh-im: Session sync coordinator');
  }
  return Object.freeze({ ...coordinator, close });
}
