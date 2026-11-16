// care fork: the inbound gate on every non-Feishu platform the care integration
// supports (WeCom AI bot, DingTalk, QQ, WhatsApp, Matrix, Discord, iMessage):
// gate order router → claims → resolver → agent, link codes claimed in DMs only,
// and the ImSource shape. Platform events are mocked; nothing touches the network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DingtalkHarnessBridge } from '../../src/channels/dingtalk/dingtalk-bridge.mjs';
import { DiscordHarnessBridge } from '../../src/channels/discord/discord-bridge.mjs';
import { normalizeDiscordMessage } from '../../src/channels/discord/discord-runtime.mjs';
import { normalizeIMessage } from '../../src/channels/imessage/imessage-api.mjs';
import { IMessageHarnessBridge } from '../../src/channels/imessage/imessage-bridge.mjs';
import { MatrixHarnessBridge } from '../../src/channels/matrix/matrix-bridge.mjs';
import { QqHarnessBridge } from '../../src/channels/qq/qq-bridge.mjs';
import { WecomHarnessBridge } from '../../src/channels/wecom/wecom-bridge.mjs';
import { WhatsappHarnessBridge } from '../../src/channels/whatsapp/whatsapp-bridge.mjs';
import {
  eventually, policyProvider, quiet, scope, settle, stateFixture, useHub,
} from './support.mjs';
import { imExtensions } from '../../src/channels/shared/im-extensions.mjs';

const LINK_CODE = /^連携\s*\d{6}$/u;

/** A Harness double that logs the agent step into the shared order log. */
function orderedHarness(log) {
  const asked = [];
  return {
    asked,
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      createSession: async () => 'session-1',
      ask: async (sessionId, prompt) => {
        log.push('agent');
        asked.push({ sessionId, prompt, source: imExtensions.sourceForTurn(sessionId) });
        return '了解しました';
      },
    },
  };
}

function textBridge(Bridge, botId, extra = {}) {
  return (log) => {
    const outbound = [];
    const { harness, asked } = orderedHarness(log);
    const { state } = stateFixture();
    const bridge = new Bridge({
      bot: { sendText: async (target, text) => { outbound.push({ target, text }); return { providerMessageIds: [`out-${outbound.length}`] }; } },
      harness, state, logger: quiet, botId,
      accessPolicy: policyProvider(botId, { direct: scope('allowlist', []), group: scope('allowlist', []) }),
      ...extra,
    });
    return { bridge, outbound, asked };
  };
}

const DISCORD_BOT = '111111111111111111';
const discordRaw = (text, { id, author = '222222222222222222', guild = null } = {}) => ({
  id, channel_id: guild ? '333333333333333333' : '444444444444444444', author: { id: author, username: 'staff' },
  content: guild ? `<@${DISCORD_BOT}> ${text}` : text,
  ...(guild ? { guild_id: guild, mentions: [{ id: DISCORD_BOT }] } : {}),
});

const PLATFORMS = [
  {
    name: 'WeCom AI bot',
    botId: 'wecom_bot',
    make: (log) => {
      const outbound = [];
      const { harness, asked } = orderedHarness(log);
      const { state } = stateFixture();
      const capture = (kind) => async (...args) => { outbound.push({ kind, args }); return { body: { msgid: `out-${outbound.length}` } }; };
      const bridge = new WecomHarnessBridge({
        client: {
          replyStream: capture('stream'), replyStreamNonBlocking: capture('stream'), sendMessage: capture('send'),
          replyTemplateCard: capture('card'), updateTemplateCard: capture('update'),
        },
        harness, state, logger: quiet, botId: 'wecom_bot', generateStreamId: () => 'stream-1',
        accessPolicy: policyProvider('wecom_bot', { direct: scope('allowlist', []), group: scope('allowlist', []) }),
      });
      return { bridge, outbound, asked };
    },
    dm: (text, id, from = 'zhangsan') => ({
      headers: { req_id: `req-${id}` },
      body: { msgid: id, chattype: 'single', from: { userid: from }, msgtype: 'text', text: { content: text } },
    }),
    group: (text, id, from = 'zhangsan') => ({
      headers: { req_id: `req-${id}` },
      body: { msgid: id, chattype: 'group', chatid: 'wr-group-1', from: { userid: from }, msgtype: 'text', text: { content: text } },
    }),
    linked: 'zhangsan',
    other: 'lisi',
    source: { platform: 'wecom', botId: 'wecom_bot', userId: 'zhangsan', conversationId: 'zhangsan', conversationKind: 'direct' },
    groupSource: { conversationId: 'wr-group-1', conversationKind: 'group' },
  },
  {
    name: 'DingTalk',
    botId: 'ding_bot',
    make: (log) => {
      const outbound = [];
      const { harness, asked } = orderedHarness(log);
      const { state } = stateFixture();
      const bridge = new DingtalkHarnessBridge({
        api: { sendText: async (...args) => { outbound.push(args); return { messageId: `out-${outbound.length}` }; } },
        clientId: 'ding-client', clientSecret: 'host-secret', harness, state, logger: quiet, botId: 'ding_bot',
        accessPolicy: policyProvider('ding_bot', { direct: scope('allowlist', []), group: scope('allowlist', []) }),
      });
      return { bridge, outbound, asked };
    },
    dm: (text, id, from = 'staff-1') => ({
      msgId: id, msgtype: 'text', text: { content: text }, conversationType: '1', conversationId: `cid-dm-${from}`,
      senderStaffId: from, senderCorpId: 'ding-corp-1', senderNick: '職員',
      sessionWebhook: `https://oapi.dingtalk.com/robot/reply?ticket=${id}`,
    }),
    group: (text, id, from = 'staff-1') => ({
      msgId: id, msgtype: 'text', text: { content: text }, conversationType: '2', conversationId: 'cid-group-1',
      isInAtList: true, senderStaffId: from, senderCorpId: 'ding-corp-1', senderNick: '職員',
      sessionWebhook: `https://oapi.dingtalk.com/robot/reply?ticket=${id}`,
    }),
    linked: 'staff-1',
    other: 'staff-2',
    source: { platform: 'dingtalk', botId: 'ding_bot', teamId: 'ding-corp-1', userId: 'staff-1', conversationId: 'staff-1', conversationKind: 'direct' },
    groupSource: { conversationId: 'cid-group-1', conversationKind: 'group' },
  },
  {
    name: 'QQ',
    botId: 'qq_bot',
    make: (log) => {
      const outbound = [];
      const { harness, asked } = orderedHarness(log);
      const { state } = stateFixture();
      const bridge = new QqHarnessBridge({
        bot: { appId: '102000001', sendText: async (target, text) => { outbound.push({ target, text }); return { id: `out-${outbound.length}` }; } },
        ownerUserOpenid: 'owner-openid', harness, state, logger: quiet, botId: 'qq_bot',
        accessPolicy: policyProvider('qq_bot', { direct: scope('allowlist', []), group: scope('allowlist', []) }),
      });
      return { bridge, outbound, asked };
    },
    dm: (text, id, from = 'user-openid-1') => ({
      kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: from, senderIsBot: false, content: text, messageId: id,
      replyTarget: { scope: 'c2c', targetId: from, msgId: id },
    }),
    group: (text, id, from = 'member-openid-1') => ({
      kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid: 'group-openid-1', senderId: from,
      senderIsBot: false, content: text, messageId: id, replyTarget: { scope: 'group', targetId: 'group-openid-1', msgId: id },
    }),
    linked: 'user-openid-1',
    groupLinked: 'member-openid-1',
    other: 'user-openid-2',
    source: { platform: 'qq', botId: 'qq_bot', teamId: '102000001', userId: 'user-openid-1', conversationId: 'user-openid-1', conversationKind: 'direct' },
    groupSource: { conversationId: 'group-openid-1', conversationKind: 'group' },
  },
  {
    name: 'WhatsApp',
    botId: 'wa_bot',
    make: textBridge(WhatsappHarnessBridge, 'wa_bot'),
    dm: (text, id, from = '819011112222@s.whatsapp.net') => ({
      messageId: `${from}:${id}`, providerMessageId: id, senderId: from, senderAlternateId: '', senderIsBot: false,
      kind: 'direct', conversationId: from, content: text, plainText: true, images: [], files: [], addressed: true,
      replyTarget: { jid: from },
    }),
    group: (text, id, from = '819011112222@s.whatsapp.net') => ({
      messageId: `120363000000000001@g.us:${id}`, providerMessageId: id, senderId: from, senderAlternateId: '',
      senderIsBot: false, kind: 'group', conversationId: '120363000000000001@g.us', content: text, plainText: true,
      images: [], files: [], addressed: true, replyTarget: { jid: '120363000000000001@g.us' },
    }),
    linked: '819011112222@s.whatsapp.net',
    other: '819033334444@s.whatsapp.net',
    source: {
      platform: 'whatsapp', botId: 'wa_bot', userId: '819011112222@s.whatsapp.net',
      conversationId: '819011112222@s.whatsapp.net', conversationKind: 'direct',
    },
    groupSource: { conversationId: '120363000000000001@g.us', conversationKind: 'group' },
  },
  {
    name: 'Matrix',
    botId: 'mx_bot',
    make: textBridge(MatrixHarnessBridge, 'mx_bot'),
    dm: (text, id, from = '@staff:care.example') => ({
      messageId: id, senderId: from, senderIsBot: false, kind: 'direct', conversationId: '!dm-room:care.example',
      content: text, plainText: true, images: [], files: [], addressed: true, replyTarget: { roomId: '!dm-room:care.example' },
    }),
    group: (text, id, from = '@staff:care.example') => ({
      messageId: id, senderId: from, senderIsBot: false, kind: 'group', conversationId: '!team:care.example',
      content: text, plainText: true, images: [], files: [], addressed: true, replyTarget: { roomId: '!team:care.example' },
    }),
    linked: '@staff:care.example',
    other: '@guest:care.example',
    source: { platform: 'matrix', botId: 'mx_bot', userId: '@staff:care.example', conversationId: '!dm-room:care.example', conversationKind: 'direct' },
    groupSource: { conversationId: '!team:care.example', conversationKind: 'group' },
  },
  {
    name: 'Discord',
    botId: 'discord_bot',
    make: textBridge(DiscordHarnessBridge, 'discord_bot'),
    dm: (text, id, from = '222222222222222222') => normalizeDiscordMessage(discordRaw(text, { id, author: from }), DISCORD_BOT),
    group: (text, id, from = '222222222222222222') => normalizeDiscordMessage(discordRaw(text, { id, author: from, guild: '555555555555555555' }), DISCORD_BOT),
    linked: '222222222222222222',
    other: '666666666666666666',
    // No teamId: Discord user ids are global and a DM has no guild, so the
    // identity linked in a DM must stay the same in guild channels.
    source: { platform: 'discord', botId: 'discord_bot', userId: '222222222222222222', conversationId: '444444444444444444', conversationKind: 'direct' },
    groupSource: { conversationId: '333333333333333333', conversationKind: 'group' },
  },
  {
    name: 'iMessage',
    botId: 'imessage_bot',
    make: textBridge(IMessageHarnessBridge, 'imessage_bot'),
    dm: (text, id, from = '+819012345678') => normalizeIMessage({
      rowid: 1, guid: id, chatGuid: `any;-;${from}`, serviceName: 'iMessage', text, sender: from,
    }),
    group: (text, id, from = '+819012345678') => normalizeIMessage({
      rowid: 2, guid: id, chatGuid: 'iMessage;+;chat123456789', serviceName: 'iMessage', text, sender: from,
    }),
    linked: '+819012345678',
    other: '+819087654321',
    source: { platform: 'imessage', botId: 'imessage_bot', userId: '+819012345678', conversationId: 'any;-;+819012345678', conversationKind: 'direct' },
    groupSource: { conversationId: 'iMessage;+;chat123456789', conversationKind: 'group' },
  },
];

for (const platform of PLATFORMS) {
  test(`${platform.name}: router → claims → resolver → agent, link code in DMs only, ImSource shape`, async (t) => {
    const { hub } = await useHub(t);
    const log = [];
    const claimed = [];
    const resolved = [];
    hub.setConversationRouter({ route: ({ source }) => { log.push('router'); assert.ok(source.userId); return null; } });
    hub.claimReplies((text, source) => {
      log.push('claim');
      return source.conversationKind === 'direct' && LINK_CODE.test(text);
    }, async ({ source, reply }) => {
      claimed.push(source);
      await reply('連携しました');
    });
    const linkedUsers = new Set([platform.linked, platform.groupLinked].filter(Boolean));
    hub.setAccessResolver(async (source) => {
      log.push('resolver');
      resolved.push(source);
      return linkedUsers.has(source.userId) ? 'allow' : { deny: true, reply: '未連携です' };
    });
    const { bridge, outbound, asked } = platform.make(log);

    // 1) An unlinked user's link code in a DM: claimed, never reaches the resolver or the agent.
    await bridge.accept(platform.dm('連携 123456', 'm1', platform.other));
    await eventually(() => claimed.length === 1);
    assert.deepEqual(log, ['router', 'claim']);
    assert.equal(claimed[0].userId, platform.other);
    assert.equal(claimed[0].conversationKind, 'direct');
    await eventually(() => outbound.length >= 1);

    // 2) The same code in a group is not a link request: the resolver denies it.
    log.length = 0;
    await bridge.accept(platform.group('連携 654321', 'm2', platform.other));
    await eventually(() => resolved.length === 1);
    await settle();
    assert.deepEqual(log, ['router', 'claim', 'resolver']);
    assert.equal(claimed.length, 1);
    assert.equal(resolved[0].conversationKind, 'group');
    for (const [key, value] of Object.entries(platform.groupSource)) assert.equal(resolved[0][key], value, key);
    assert.equal(asked.length, 0);

    // 3) A linked user in a DM reaches the agent with the trusted source of that turn.
    log.length = 0;
    await bridge.accept(platform.dm('今日の予定は？', 'm3', platform.linked));
    await eventually(() => asked.length === 1);
    assert.deepEqual(log, ['router', 'claim', 'resolver', 'agent']);
    const { at, messageId, ...source } = asked[0].source;
    assert.deepEqual(source, platform.source);
    assert.ok(messageId);
    assert.ok(!Number.isNaN(Date.parse(at)));
    await bridge.waitForIdle?.();
  });
}
