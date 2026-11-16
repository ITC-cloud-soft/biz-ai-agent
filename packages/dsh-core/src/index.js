// @dsh-bridge/dsh-core — DSH 側の Bridge 共通部品（docs/ARCHITECTURE.md の L3）。
//
//   registry   アプリケーションレジストリ・ボット → アプリケーション（設定だけから）・manifest（取得・検証・etag・同梱ファイル）
//   api        アプリケーションごとの業務 API クライアント（サービストークン・委託ヘッダ・bridge-protocol 確認・型付きエラー・再試行）
//   delegation 委託トークンのキャッシュ（(アプリケーション, 発信元) 単位。自動タスクの事件ごとの委託は (アプリケーション, 事件)）
//   session    会話のキー (アプリケーション, プラットフォーム, ボット, 会話)
//   app-switch 共用ボット（個人 WeChat）の同じ窓口内のアプリケーション切り替え（#一覧・#<アプリ名>・【アプリ名】・通知への返信）
//   tools-sdk  defineTool・委託 gate・名前空間・manifest からの読み取りツール生成
//   delivery   IM 送信の失敗の分類（届かない理由：WeChat のコンテキスト切れ・宛先不正・ボット未接続・レート制限・送信上限）と既定の配信先の優先順位
//   apps       経路（appPath）・単一アプリケーション互換・送信ボットの選択（第 2 段階で移した events / notify / approvals / assistant）
//   outbound   AI から IM へ出るものの決まり（グループ会話は既定で業務を扱わない・AI の自由文の事後の検査）
//   secretary  IM の文面の枠（【ご報告】【対応のお願い】【至急】・時刻のあいさつ・署名「— <アプリ名> AI 秘書」）
//   persona    AI 社員のプロフィール → system prompt の節（固定の規則が先）・署名の呼び名。ai-profile：業務システムから取る保持者（etag）
//   runtime    DSH(Cordis) 上のヘルパー
//   plugin     この package 自体が DSH プラグイン `bridge-apps`（ctx.bridgeApps を提供）
//
// 業務システム固有の互換（ケアビリングの /api/ai/* 経路・CARE_* 環境変数・旧名 legacyRegistry / createCareApi）は
// '@dsh-bridge/dsh-core/compat/care-billing-paths'（ここからは export しない）。
export {
  PROTOCOL_HEADER, PROTOCOL_VERSION, BridgeApiError, BridgeUnreachableError, BridgeHttpError, BridgeProtocolError,
  createBusinessApi, apiSource, sourceKey,
} from './api-client.js'
export { createManifestHolder, checkManifest, resolveManifestFile } from './manifest.js'
export {
  createApplicationRegistry, fallbackRegistry, normalizeApplication, V1_PATHS, DEFAULT_APPLICATION_ID,
  MULTI_APP_PLATFORMS, registerPathProfile, pathProfile, pathProfileNames,
} from './registry.js'
export {
  createAppSwitch, parseSwitchCommand, appPrefix, withAppPrefix, SWITCH_LIST_WORDS, SWITCH_CURRENT_WORDS, SWITCH_HELP_WORDS,
  DEFAULT_REPLY_WINDOW_MS, DEFAULT_QUOTE_RETENTION_MS,
} from './app-switch.js'
export {
  createDelegationCache, delegationKey, eventDelegationKey, eventIdForRequest, DELEGATION_REFRESH_MARGIN_MS, DELEGATION_MAX_TTL_MS,
} from './delegation.js'
export { sessionKey, parseSessionKey, conversationKeyOf } from './session.js'
export { classifyDeliveryError, DEFAULT_PLATFORM_PRIORITY, NOTIFY_ONLY_PLATFORMS, MAX_REQUEST_PLATFORMS } from './delivery.js'
export { GROUP_CHAT_GUIDE, GROUP_CHAT_POLICIES, HEALTH_WORDS, ROLE_WORDS, isGroupConversation, groupChatPolicy, screenOutboundText } from './outbound.js'
export {
  appPath, hasPath, singleApplicationRegistry, registryGetter, applicationOfEvent, scopedKey, createBotResolver,
} from './apps.js'
export {
  TOOL_ACCESS, currentPrincipal, runWithPrincipal, sessionIdOf, toolError, createToolRequester, createDelegationGate, guardTool,
  defineTool, inNamespace, registerTools, manifestTools, registerManifestTools, autoTaskSessionChecker, autoTaskRunResolver, DEFAULT_DENY_HINTS,
  DELEGATION_SPEC_RE, parseDelegationSpec,
} from './tools-sdk.js'
export {
  INTENTS, INTENT_LABELS, APPROVAL_LABEL, CONSULT_LABEL, REPORT_LABEL, SECRETARY_LABEL_RE, DEFAULT_INFO_NOTE, DEFAULT_ASK, DEFAULT_SECRETARY_NAME, LINK_LEAD,
  HELP_LABEL, normalizeIntent, intentOfHead, wallHour,
  greetingAt, signatureOf, bundleLine, monthDayTime, frameMessage, frameAiText, noticeCard,
} from './secretary.js'
export { createLinkGuard, routePattern, DEFAULT_LINK_REPLACEMENT } from './link-guard.js'
export { helpToolSpec, toHelpResult, renderHelp, HELP_RULES_JA, helpRules } from './help-tool.js'
export {
  loadSchemastery, cfg, makeLogger, whenServices, onDispose, objectSchema, openDomain, backoffDelay, normalizeText,
} from './runtime.js'
export { name, Config, apply, applyCompat, SERVICE, SERVICE_NAMES, COMPAT_PROFILES, registryService } from './plugin.js'
export { FIXED_RULES, TONE_TEXT, profileForAgent, nicknameOf, renderPersona, appSignature, appNickname } from './persona.js'
export { createAiProfileHolder, AI_PROFILE_REFRESH_SECONDS } from './ai-profile.js'
export { createConnectorCatalogHolder, normalizeCatalogEntry, connectorPath, isConnectorRunPath, connectorToolName, CONNECTOR_REFRESH_SECONDS } from './connectors.js'
export { createImageCleanup, resolveDshHome, scanZstdFrames, sessionLogText, attachmentIdsIn, IMAGE_CLEANUP_DEFAULTS } from './image-cleanup.js'

import { whenServices as watchServices } from './runtime.js'
import { SERVICE as REGISTRY_SERVICE } from './plugin.js'

/**
 * プラグインからレジストリを得る：ctx.bridgeApps（bridge-apps プラグイン。出現・消滅を追う）にアプリケーションがあればそれ、
 * 無ければ fallback（プラグイン設定の apiUrl / serviceToken から作る 1 件：fallbackRegistry、ケアビリングの互換は careBillingRegistry）。呼び出しごとに評価する関数を返す。
 */
export function watchRegistry(ctx, fallback) {
  let shared = null
  watchServices(ctx, [REGISTRY_SERVICE], (sub) => {
    shared = sub[REGISTRY_SERVICE]
    return () => { shared = null }
  })
  return () => {
    if (shared && typeof shared.size === 'function' && shared.size() > 0) return shared
    return typeof fallback === 'function' ? fallback() : fallback
  }
}
