import { evaluateAccessPolicy, normalizeAccessPolicy } from './access-policy.mjs';
import { isSharedLocalCommand } from './command-permission.mjs';
import { imExtensions } from './im-extensions.mjs';

export const COMMAND_PERMISSION_DENIED_MESSAGE = '你可以发送普通消息，但没有执行命令的权限。请联系管理员在 DSH 设置 → IM机器人 → 对应机器人 → 访问设置中，为你开启当前私聊或群聊场景的命令权限后重试。';

const POLICY_NOT_CONFIGURED = Object.freeze({ allowed: true, reason: 'policy-not-configured' });
const PRIVILEGED_SENDER = Object.freeze({ allowed: true, reason: 'privileged-sender' });
// care fork: outcomes of the access resolver / default-closed mode.
const RESOLVER_ALLOWED = Object.freeze({ allowed: true, reason: 'resolver-allowed' });
const RESOLVER_COMMAND_NOT_ALLOWED = Object.freeze({ allowed: false, reason: 'command-not-allowed' });
const CLOSED_BY_DEFAULT = Object.freeze({ allowed: false, reason: 'sender-not-allowed' });

/**
 * care fork: in default-closed mode an `open` scope no longer admits everyone.
 * Only the owner-bound (privileged) sender and users an owner explicitly put
 * on the scope's allowlist (kept even while the scope is `open`, e.g. the
 * Telegram `allowedUsers` seed) pass; everyone else needs the access resolver.
 */
function closedPolicy(policy) {
  const normalized = normalizeAccessPolicy(policy);
  if (!normalized) return policy;
  const closeScope = (scope) => (scope.mode === 'open' ? { ...scope, mode: 'allowlist' } : scope);
  return { direct: closeScope(normalized.direct), group: closeScope(normalized.group) };
}

/**
 * Read one committed policy snapshot and decide a single inbound event.
 * A missing provider is kept backward-compatible for direct bridge fixtures;
 * production always injects a provider, whose missing/damaged value fails closed.
 *
 * care fork: `resolverVerdict: 'allow'` is passed by bridges whose inbound gate
 * already asked the access resolver. The resolver then replaces the policy's
 * membership decision while the policy still decides command permission.
 */
export function evaluateInboundAccess(accessPolicy, {
  conversationType,
  senderIds,
  text = '',
  hasImages = false,
  hasFiles = false,
  isCommand = isSharedLocalCommand(text, { hasImages, hasFiles }),
  resolverVerdict,
} = {}) {
  if (!accessPolicy) return POLICY_NOT_CONFIGURED;
  try {
    if (typeof accessPolicy.isPrivileged === 'function'
      && accessPolicy.isPrivileged(senderIds, conversationType) === true) {
      return PRIVILEGED_SENDER;
    }
  } catch {
    // A broken privilege lookup must not bypass the persisted policy.
  }
  let policy = null;
  try {
    policy = accessPolicy.getSettings();
  } catch {
    // Provider failures are equivalent to an unavailable persisted policy.
  }
  const options = {
    conversationType,
    senderIds,
    isCommand,
    ...(typeof accessPolicy.equals === 'function' ? { equals: accessPolicy.equals } : {}),
  };
  if (resolverVerdict === 'allow') {
    const decision = evaluateAccessPolicy(policy, options);
    if (decision.allowed) return decision;
    if (decision.reason === 'sender-not-allowed') return isCommand ? RESOLVER_COMMAND_NOT_ALLOWED : RESOLVER_ALLOWED;
    return decision;
  }
  if (imExtensions.accessDefault === 'closed') {
    const decision = evaluateAccessPolicy(closedPolicy(policy), options);
    return decision.allowed || decision.reason !== 'sender-not-allowed' ? decision : CLOSED_BY_DEFAULT;
  }
  return evaluateAccessPolicy(policy, options);
}
