// compat/care-billing-paths.js — 互換 profile：ケアビリング（framework の最初の利用者）の旧来の構成。
//
// framework の本体（registry / api-client / apps / secretary / tools-sdk）は業務システムの名前・環境変数・経路を持たない。
// ケアビリングが Bridge v1 へ移る前の構成（care-api の /api/ai/* 経路・CARE_API_URL / CARE_SERVICE_TOKEN・アプリケーション
// ID care-billing・名前空間 care・旧サービス名 careIdentity / careAssistant）は、ここを明示的に使ったときだけ有効になる。
//
//   import { enableCareBillingPaths, careBillingRegistry } from '@dsh-bridge/dsh-core/compat/care-billing-paths'
//   enableCareBillingPaths()                      // レジストリで paths: legacy / care-billing-legacy と書けるようにする
//   const registry = careBillingRegistry({ apiUrl: () => config.apiUrl })   // 旧 legacyRegistry
//
// bridge-apps プラグインでは設定 `compat: [care-billing-paths]` で同じことをする。新しい業務システムはこれを使わず、
// Bridge v1（paths: v1、既定）とレジストリの apiUrlEnv / serviceTokenEnv を使う。
import { createBusinessApi, BridgeApiError } from '../api-client.js'
import { fallbackRegistry, registerPathProfile } from '../registry.js'
import { singleApplicationRegistry } from '../apps.js'

export const CARE_BILLING_APPLICATION_ID = 'care-billing'
export const CARE_BILLING_ENV = Object.freeze({ apiUrl: 'CARE_API_URL', serviceToken: 'CARE_SERVICE_TOKEN' })
export const CARE_BILLING_DEFAULT_BASE_URL = 'http://127.0.0.1:8788'
export const CARE_BILLING_DEFAULTS = Object.freeze({
  id: CARE_BILLING_APPLICATION_ID,
  name: 'ケアビリング',
  label: 'care-api',
  namespace: 'care',
})
/** 旧来の DSH サービス名（ctx.careIdentity / ctx.careAssistant）。新しい名前は bridgeIdentity / bridgeAssistant。 */
export const LEGACY_SERVICE_NAMES = Object.freeze({ identity: 'careIdentity', assistant: 'careAssistant' })
/** 旧 care-tools の拒否の案内（ケアビリングの画面名を含む）。createDelegationGate の denyHints に渡す。 */
export const CARE_BILLING_DENY_HINTS = Object.freeze({
  linked: 'the employee can link their account in the business web app (個人設定 › SNS 連携（自分の分）, /settings/sns) and ask again from that IM account.',
  noSender: 'linking an account does not enable this conversation; ask from a linked IM account (Slack / LINE / Teams / WeChat) '
    + 'or use the business web app directly.',
})

/** care-api（`/api/ai/*`）の経路（旧 LEGACY_PATHS）。 */
export const CARE_BILLING_PATHS = Object.freeze({
  identity: '/api/ai/identity',
  identityStats: '/api/ai/identity/stats',
  link: '/api/ai/sns-identities/link',
  delegations: '/api/ai/delegations',
  manifest: '/bridge/v1/manifest',
  health: '/health',
  events: '/api/ai/events',
  notificationRecipients: '/api/ai/notifications/for-event/{eventId}',
  notificationDeliveries: '/api/ai/notifications/deliveries',
  approvalDeliveries: '/api/ai/approvals/{approvalId}/deliveries',
  approvalDeliverySent: '/api/ai/approvals/{approvalId}/deliveries/{deliveryId}/sent',
  approvalDecision: '/api/ai/approvals/{approvalId}/im-decision',
  approvalDecisions: '/api/ai/im-decisions',
  assistantDelegations: '/api/ai/assistant/delegations',
  piiScan: '/api/ai/pii-scan',
  aiProfile: '/api/ai/ai-profile',
  // 外部連携（care-ai-native docs/design/EXTERNAL_CONNECTORS_CARE.md）：書く操作の提案は介護の承認（承認カード）になる
  connectorCatalog: '/api/ai/connectors/catalog',
  connectorRun: '/api/ai/connectors/{connectorId}/operations/{operationId}/run',
  documentReads: '/api/ai/document-reads',
  documentReadResult: '/api/ai/document-reads/{readId}/result',
  connectorPropose: '/api/ai/connectors/{connectorId}/operations/{operationId}/propose',
  reportSettings: '/api/ai/business-report/settings',
  // マニュアルの検索と公開の節（ログイン・SNS 連携。care-ai-native docs/design/SNS_HELP_QA.md D1）
  helpSearch: '/api/help/search',
  publicHelp: '/api/ai/help/public',
})
/** 旧名。 */
export const LEGACY_PATHS = CARE_BILLING_PATHS
/** この互換 profile が登録する path profile の名前（'legacy' は旧来の設定 `paths: legacy` のため）。 */
export const PATH_PROFILE_NAMES = Object.freeze(['care-billing-legacy', 'legacy'])

/** レジストリで `paths: legacy` / `paths: care-billing-legacy` を使えるようにする（何度呼んでもよい）。 */
export function enableCareBillingPaths() {
  for (const name of PATH_PROFILE_NAMES) registerPathProfile(name, CARE_BILLING_PATHS)
  return PATH_PROFILE_NAMES
}

/**
 * ケアビリング 1 件だけのレジストリ（旧 legacyRegistry）。プラグイン設定の apiUrl / serviceToken、未設定なら CARE_API_URL /
 * CARE_SERVICE_TOKEN、さらに無ければ http://127.0.0.1:8788。経路は /api/ai/*、bridge-protocol ヘッダは検査しない。
 */
export function careBillingRegistry({ apiUrl = () => '', serviceToken = () => '', id = CARE_BILLING_APPLICATION_ID, fetch, logger, now, delegations } = {}) {
  return fallbackRegistry({
    ...CARE_BILLING_DEFAULTS,
    id,
    paths: CARE_BILLING_PATHS,
    apiUrl,
    serviceToken,
    protocol: null,
    envFallback: CARE_BILLING_ENV,
    defaultBaseUrl: CARE_BILLING_DEFAULT_BASE_URL,
    fetch,
    logger,
    now,
    delegations,
  })
}
/** 旧名。 */
export const legacyRegistry = careBillingRegistry

/** API クライアント 1 つをケアビリング 1 件のレジストリに見せる（旧 singleApplicationRegistry の既定値）。 */
export function careBillingSingleApplicationRegistry(api, options = {}) {
  return singleApplicationRegistry(api, { ...CARE_BILLING_DEFAULTS, paths: CARE_BILLING_PATHS, ...options })
}

/** 旧 shared/care-api.js の createCareApi：label care-api、CARE_API_URL / CARE_SERVICE_TOKEN を既定に、版の検査なし。 */
export function createCareApi(options = {}) {
  return createBusinessApi({
    label: 'care-api',
    protocol: null,
    defaultBaseUrl: () => process.env[CARE_BILLING_ENV.apiUrl] || CARE_BILLING_DEFAULT_BASE_URL,
    defaultServiceToken: () => process.env[CARE_BILLING_ENV.serviceToken] || '',
    ...options,
  })
}
/** 旧名。 */
export const CareApiError = BridgeApiError
