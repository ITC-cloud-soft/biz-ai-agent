// care fork: one channel-neutral card, rendered per platform.
//
// Card = { title, fields?, body?, actions?, link?, footer?, textFallback? }
// - Slack: Block Kit (header / fields / body / buttons / link / context).
// - Telegram: plain text + inline keyboard (callback_data points at a stored card id).
// - Every other channel: `textFallback`, or a plain-text rendering of the card.

const ACTION_STYLES = new Set(['primary', 'danger', 'default']);

function invalidCard(message) {
  return Object.assign(new TypeError(message), { code: 'bad-request' });
}

function text(value, label, { max = 3000, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw invalidCard(`${label} is required`);
  }
  if (typeof value !== 'string') throw invalidCard(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (optional) return undefined;
    throw invalidCard(`${label} must not be empty`);
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Validate and copy a card; unknown fields are dropped. */
export function normalizeCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw invalidCard('card must be an object');
  const fields = card.fields === undefined ? [] : card.fields;
  if (!Array.isArray(fields) || fields.length > 20) throw invalidCard('card.fields must be an array of at most 20 entries');
  const actions = card.actions === undefined ? [] : card.actions;
  if (!Array.isArray(actions) || actions.length > 10) throw invalidCard('card.actions must be an array of at most 10 entries');
  const seen = new Set();
  const normalized = {
    title: text(card.title, 'card.title', { max: 150 }),
    fields: fields.map((field, index) => ({
      label: text(field?.label, `card.fields[${index}].label`, { max: 100 }),
      value: text(String(field?.value ?? ''), `card.fields[${index}].value`, { max: 1000 }),
    })),
    actions: actions.map((action, index) => {
      const id = text(action?.id, `card.actions[${index}].id`, { max: 200 });
      if (seen.has(id)) throw invalidCard('card action ids must be unique');
      seen.add(id);
      const style = action?.style ?? 'default';
      if (!ACTION_STYLES.has(style)) throw invalidCard(`card.actions[${index}].style is invalid`);
      if (typeof action?.value !== 'string' || action.value.length > 1900) {
        throw invalidCard(`card.actions[${index}].value must be a string of at most 1900 characters`);
      }
      const out = { id, label: text(action?.label, `card.actions[${index}].label`, { max: 70 }), style, value: action.value };
      // care fork: an optional free-text input that goes with this button (e.g. the reason of a rejection). Channels whose
      // cards can hold an input (Teams, Feishu/Lark) show it next to the button and hand the typed text to onAction as
      // `inputText`; the others ignore it (the handler falls back to a dialog or a text reply).
      if (action?.input !== undefined && action.input !== null) {
        if (typeof action.input !== 'object' || Array.isArray(action.input)) throw invalidCard(`card.actions[${index}].input must be an object`);
        out.input = {
          label: text(action.input.label, `card.actions[${index}].input.label`, { max: 100 }),
          placeholder: text(action.input.placeholder, `card.actions[${index}].input.placeholder`, { max: 100, optional: true }) ?? '',
        };
      }
      return out;
    }),
  };
  const body = text(card.body, 'card.body', { max: 2900, optional: true });
  if (body) normalized.body = body;
  if (card.link !== undefined) {
    const url = text(card.link?.url, 'card.link.url', { max: 2000 });
    let parsed;
    try { parsed = new URL(url); } catch { throw invalidCard('card.link.url must be a URL'); }
    if (!['https:', 'http:'].includes(parsed.protocol)) throw invalidCard('card.link.url must be http(s)');
    normalized.link = { label: text(card.link?.label, 'card.link.label', { max: 70 }), url: parsed.href };
  }
  const footer = text(card.footer, 'card.footer', { max: 300, optional: true });
  if (footer) normalized.footer = footer;
  const textFallback = text(card.textFallback, 'card.textFallback', { max: 3500, optional: true });
  if (textFallback) normalized.textFallback = textFallback;
  return normalized;
}

/** Plain-text rendering used by Telegram's message body and by text-only channels. */
export function cardPlainText(card, { includeFallback = true } = {}) {
  const lines = [card.title];
  if (card.fields.length) {
    lines.push('');
    for (const field of card.fields) lines.push(`${field.label}: ${field.value}`);
  }
  if (card.body) lines.push('', card.body);
  if (card.link) lines.push('', `${card.link.label}: ${card.link.url}`);
  if (includeFallback && card.textFallback) lines.push('', card.textFallback);
  if (card.footer) lines.push('', card.footer);
  return lines.join('\n');
}

/** What a channel without buttons sends. */
export function cardFallbackText(card) {
  if (!card.textFallback) return cardPlainText(card, { includeFallback: false });
  // The fallback carries the reply instruction; keep the card summary above it
  // so the recipient still sees what the request is about.
  return cardPlainText(card, { includeFallback: true });
}

function slackEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Slack Block Kit blocks for a card. */
export function slackCardBlocks(card) {
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: card.title.slice(0, 150), emoji: true } }];
  for (let index = 0; index < card.fields.length; index += 10) {
    blocks.push({
      type: 'section',
      fields: card.fields.slice(index, index + 10).map((field) => ({
        type: 'mrkdwn',
        text: `*${slackEscape(field.label)}*\n${slackEscape(field.value)}`.slice(0, 2000),
      })),
    });
  }
  if (card.body) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackEscape(card.body).slice(0, 3000) } });
  const elements = card.actions.map((action) => ({
    type: 'button',
    action_id: action.id,
    text: { type: 'plain_text', text: action.label, emoji: true },
    value: action.value,
    ...(action.style === 'default' ? {} : { style: action.style }),
  }));
  if (card.link) {
    elements.push({
      type: 'button',
      action_id: `dsh_im_link:${elements.length}`,
      text: { type: 'plain_text', text: card.link.label, emoji: true },
      url: card.link.url,
    });
  }
  if (elements.length) blocks.push({ type: 'actions', elements: elements.slice(0, 25) });
  if (card.footer) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: slackEscape(card.footer).slice(0, 2000) }] });
  return blocks;
}

/** Slack notification text (shown in push notifications and screen readers). */
export function slackCardText(card) {
  // Buttons carry the decision; the textual reply code stays out of Slack.
  return card.title.slice(0, 3000);
}

export const TELEGRAM_CARD_CALLBACK_PREFIX = 'dc:';

/** Telegram inline keyboard; callback data stays within the 64-byte limit. */
export function telegramCardMarkup(card, cardId) {
  const rows = [];
  if (card.actions.length) {
    rows.push(card.actions.map((action, index) => ({
      text: action.label,
      callback_data: `${TELEGRAM_CARD_CALLBACK_PREFIX}${cardId}:${index}`,
    })));
  }
  if (card.link) rows.push([{ text: card.link.label, url: card.link.url }]);
  return { inline_keyboard: rows };
}

export function parseCardCallback(data) {
  if (typeof data !== 'string' || !data.startsWith(TELEGRAM_CARD_CALLBACK_PREFIX)) return null;
  const match = /^dc:([A-Za-z0-9_-]{6,32}):(\d{1,2})$/.exec(data);
  return match ? { cardId: match[1], index: Number(match[2]) } : null;
}

/**
 * Message references are opaque to callers but self-describing here, so an
 * update can still find the message after the idempotency store expired.
 */
export function encodeMessageRef({ platform, botId, conversationId, messageId, threadId, toUser }) {
  const payload = { p: platform, b: botId, c: conversationId ?? null, m: messageId ?? null };
  if (threadId) payload.t = threadId;
  // care fork: a text-fallback card sent to `to.userId`; an update goes to the user again.
  if (toUser === true) payload.u = 1;
  return `dshim:v1:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

export function decodeMessageRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('dshim:v1:')) return null;
  try {
    const value = JSON.parse(Buffer.from(ref.slice('dshim:v1:'.length), 'base64url').toString('utf8'));
    if (!value || typeof value.p !== 'string' || typeof value.b !== 'string') return null;
    return {
      platform: value.p,
      botId: value.b,
      conversationId: typeof value.c === 'string' ? value.c : null,
      messageId: typeof value.m === 'string' ? value.m : null,
      ...(typeof value.t === 'string' ? { threadId: value.t } : {}),
      ...(value.u === 1 ? { toUser: true } : {}),
    };
  } catch {
    return null;
  }
}

// ── care fork: LINE Flex Message ──────────────────────────────────────────────

/** LINE limits: postback data ≤ 300 chars, action label ≤ 40, altText ≤ 400. */
export const LINE_POSTBACK_DATA_LIMIT = 300;
const LINE_CARD_REF_PREFIX = 'dc:';

/**
 * Postback data for one card action. Only the action id and value travel in
 * the payload (`{"a":id,"v":value}`); when that does not fit LINE's 300-char
 * limit, a stored card reference (`dc:<cardId>:<index>`) is used instead.
 */
export function linePostbackData(action, index, cardId) {
  const inline = JSON.stringify({ a: action.id, v: action.value });
  if (inline.length <= LINE_POSTBACK_DATA_LIMIT) return inline;
  if (!cardId) throw Object.assign(new TypeError('card action does not fit a LINE postback'), { code: 'bad-request' });
  return `${LINE_CARD_REF_PREFIX}${cardId}:${index}`;
}

/** @returns {{ actionId, value } | { cardId, index } | null} */
export function parseLinePostbackData(data) {
  if (typeof data !== 'string' || !data) return null;
  if (data.startsWith(LINE_CARD_REF_PREFIX)) return parseCardCallback(data);
  if (!data.startsWith('{')) return null;
  try {
    const value = JSON.parse(data);
    if (!value || typeof value.a !== 'string' || !value.a || typeof (value.v ?? '') !== 'string') return null;
    return { actionId: value.a, value: value.v ?? '' };
  } catch {
    return null;
  }
}

function clip(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A LINE Flex Message (bubble) for a card; buttons are postback actions. */
export function lineFlexMessage(card, { cardId } = {}) {
  const body = [{ type: 'text', text: clip(card.title, 150), weight: 'bold', size: 'lg', wrap: true }];
  if (card.fields.length) {
    body.push({
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      margin: 'lg',
      contents: card.fields.map((field) => ({
        type: 'box',
        layout: 'baseline',
        spacing: 'sm',
        contents: [
          { type: 'text', text: clip(field.label, 100), color: '#8c8c8c', size: 'sm', flex: 2, wrap: true },
          { type: 'text', text: clip(field.value, 1000), color: '#333333', size: 'sm', flex: 5, wrap: true },
        ],
      })),
    });
  }
  if (card.body) body.push({ type: 'text', text: clip(card.body, 2000), size: 'sm', wrap: true, margin: 'lg' });
  const footer = card.actions.map((action, index) => ({
    type: 'button',
    height: 'sm',
    style: action.style === 'default' ? 'secondary' : 'primary',
    ...(action.style === 'danger' ? { color: '#d93025' } : {}),
    action: {
      type: 'postback',
      label: clip(action.label, 40),
      data: linePostbackData(action, index, cardId),
      displayText: clip(action.label, 300),
    },
  }));
  if (card.link) {
    footer.push({ type: 'button', height: 'sm', style: 'link', action: { type: 'uri', label: clip(card.link.label, 40), uri: card.link.url } });
  }
  if (card.footer) footer.push({ type: 'text', text: clip(card.footer, 300), size: 'xs', color: '#999999', wrap: true });
  const bubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: body } };
  if (footer.length) bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer };
  return { type: 'flex', altText: clip(card.title, 400), contents: bubble };
}

// ── care fork: Microsoft Teams Adaptive Card ─────────────────────────────────

export const TEAMS_ACTION_DATA_KEY = 'dshImAction';
/** Input.Text id of a button's input; Teams merges its value into the submitted data. */
export const TEAMS_INPUT_ID = 'dshImInput';
export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

const TEAMS_ACTION_STYLES = Object.freeze({ primary: 'positive', danger: 'destructive', default: 'default' });

/**
 * An Adaptive Card (1.4) for a card. Buttons are Action.Execute (verb = action
 * id) with an Action.Submit fallback; both carry `{ dshImAction: { actionId, value } }`.
 */
export function teamsAdaptiveCard(card) {
  const body = [{ type: 'TextBlock', text: card.title, weight: 'Bolder', size: 'Medium', wrap: true }];
  if (card.fields.length) {
    body.push({ type: 'FactSet', facts: card.fields.map((field) => ({ title: field.label, value: field.value })) });
  }
  if (card.body) body.push({ type: 'TextBlock', text: card.body, wrap: true, spacing: 'Medium' });
  if (card.footer) body.push({ type: 'TextBlock', text: card.footer, wrap: true, isSubtle: true, size: 'Small', spacing: 'Medium' });
  const actions = card.actions.map((action) => {
    const data = { [TEAMS_ACTION_DATA_KEY]: { actionId: action.id, value: action.value } };
    const style = TEAMS_ACTION_STYLES[action.style] ?? 'default';
    const execute = {
      type: 'Action.Execute',
      title: action.label,
      verb: action.id,
      data,
      ...(style === 'default' ? {} : { style }),
      fallback: { type: 'Action.Submit', title: action.label, data, ...(style === 'default' ? {} : { style }) },
    };
    if (!action.input) return execute;
    // care fork: a button with an input opens it under the card (Action.ShowCard); the inner button submits the text
    // (Input.Text values are merged into the data of Action.Execute / Action.Submit).
    return {
      type: 'Action.ShowCard',
      title: action.label,
      ...(style === 'default' ? {} : { style }),
      card: {
        type: 'AdaptiveCard',
        body: [{
          type: 'Input.Text',
          id: TEAMS_INPUT_ID,
          label: action.input.label,
          ...(action.input.placeholder ? { placeholder: action.input.placeholder } : {}),
          isMultiline: true,
          maxLength: 2000,
        }],
        actions: [{ ...execute, title: `${action.label}する` }],
      },
    };
  });
  if (card.link) actions.push({ type: 'Action.OpenUrl', title: card.link.label, url: card.link.url });
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
    ...(actions.length ? { actions } : {}),
  };
}

/** The `{ actionId, value }` a Teams submit/execute carried, or null. */
export function parseTeamsActionData(data) {
  const entry = data && typeof data === 'object' ? data[TEAMS_ACTION_DATA_KEY] : null;
  if (!entry || typeof entry.actionId !== 'string' || !entry.actionId) return null;
  const parsed = { actionId: entry.actionId, value: typeof entry.value === 'string' ? entry.value : String(entry.value ?? '') };
  const typed = data[TEAMS_INPUT_ID];
  if (typeof typed === 'string' && typed.trim()) parsed.inputText = typed.trim();
  return parsed;
}
