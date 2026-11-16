// care fork: Bot Framework authentication for Microsoft Teams.
//
// Inbound: the channel signs every activity with a JWT (RS256). We fetch the
// Bot Framework OpenID metadata → JWKS, then check signature, alg, iss, aud
// (= our App ID), exp/nbf, the key's endorsement of the channel, and that the
// token's serviceUrl claim equals the activity's serviceUrl.
// Outbound: an app token from login.microsoftonline.com (client credentials),
// for a single tenant (tenant id) or multi-tenant (`botframework.com`).

import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { fetchJson, restError } from '../shared/rest-client.mjs';

export const BOT_FRAMEWORK_OPENID_METADATA = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
export const MICROSOFT_LOGIN_BASE = 'https://login.microsoftonline.com';
export const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default';
export const MULTI_TENANT_AUTHORITY = 'botframework.com';

const KEY_CACHE_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_KID_REFRESH_MS = 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function jwtError(code, message = code) {
  return Object.assign(new Error(message), { code, status: 401 });
}

function base64UrlJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** Split and parse a compact JWS without verifying it. */
export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) return null;
  try {
    return {
      header: base64UrlJson(parts[0]),
      payload: base64UrlJson(parts[1]),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], 'base64url'),
    };
  } catch {
    return null;
  }
}

/** The bearer token of an Authorization header, or null. */
export function bearerToken(value) {
  const header = Array.isArray(value) ? value[0] : value;
  const match = typeof header === 'string' ? /^Bearer\s+([A-Za-z0-9._-]+)$/i.exec(header.trim()) : null;
  return match ? match[1] : null;
}

function normalizeServiceUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '').toLowerCase() : '';
}

export class BotFrameworkJwtVerifier {
  #metadataUrl;
  #issuer;
  #fetch;
  #now;
  #keys = null;
  #fetchedAt = 0;
  #loading = null;

  constructor({
    metadataUrl = BOT_FRAMEWORK_OPENID_METADATA, issuer = BOT_FRAMEWORK_ISSUER,
    fetchImpl = globalThis.fetch, now = () => Date.now(),
  } = {}) {
    this.#metadataUrl = metadataUrl;
    this.#issuer = issuer;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async #loadKeys() {
    this.#loading ??= (async () => {
      const metadata = (await fetchJson(this.#metadataUrl, { fetchImpl: this.#fetch, prefix: 'teams-openid' })).body;
      const jwksUri = metadata?.jwks_uri;
      if (typeof jwksUri !== 'string' || !/^https?:\/\//i.test(jwksUri)) throw jwtError('jwt-metadata-invalid', 'OpenID metadata has no jwks_uri');
      const jwks = (await fetchJson(jwksUri, { fetchImpl: this.#fetch, prefix: 'teams-jwks' })).body;
      if (!Array.isArray(jwks?.keys)) throw jwtError('jwt-metadata-invalid', 'JWKS has no keys');
      this.#keys = jwks.keys;
      this.#fetchedAt = this.#now();
    })().finally(() => { this.#loading = null; });
    await this.#loading;
  }

  async #keyFor(kid) {
    if (!this.#keys || this.#now() - this.#fetchedAt > KEY_CACHE_MS) await this.#loadKeys();
    let key = this.#keys.find((candidate) => candidate?.kid === kid);
    if (!key && this.#now() - this.#fetchedAt > UNKNOWN_KID_REFRESH_MS) {
      await this.#loadKeys();
      key = this.#keys.find((candidate) => candidate?.kid === kid);
    }
    return key ?? null;
  }

  /**
   * @param {string} token  compact JWS from `Authorization: Bearer`
   * @param {{ appId: string, serviceUrl: string, channelId?: string }} expected
   * @returns the verified claims
   */
  async verify(token, { appId, serviceUrl, channelId } = {}) {
    const decoded = decodeJwt(token);
    if (!decoded) throw jwtError('jwt-malformed');
    const { header, payload } = decoded;
    if (header?.alg !== 'RS256') throw jwtError('jwt-alg', 'Only RS256 tokens are accepted');
    if (typeof header.kid !== 'string' || !header.kid) throw jwtError('jwt-kid');
    const jwk = await this.#keyFor(header.kid);
    if (!jwk) throw jwtError('jwt-unknown-key');
    if (Array.isArray(jwk.endorsements) && channelId && !jwk.endorsements.includes(channelId)) {
      throw jwtError('jwt-endorsement', 'The signing key does not endorse this channel');
    }
    let publicKey;
    try {
      publicKey = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
    } catch {
      throw jwtError('jwt-key-invalid');
    }
    if (!verifySignature('RSA-SHA256', Buffer.from(decoded.signingInput), publicKey, decoded.signature)) {
      throw jwtError('jwt-signature');
    }
    if (payload?.iss !== this.#issuer) throw jwtError('jwt-issuer');
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!appId || !audiences.includes(appId)) throw jwtError('jwt-audience');
    const now = this.#now();
    if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now - CLOCK_SKEW_MS) throw jwtError('jwt-expired');
    if (Number.isFinite(payload.nbf) && payload.nbf * 1000 > now + CLOCK_SKEW_MS) throw jwtError('jwt-not-yet-valid');
    const claimed = normalizeServiceUrl(payload.serviceurl ?? payload.serviceUrl);
    if (!claimed || claimed !== normalizeServiceUrl(serviceUrl)) throw jwtError('jwt-service-url', 'serviceUrl does not match the token');
    return payload;
  }
}

/** Client-credentials app token for the Bot Connector, cached until 5 min before expiry. */
export class BotFrameworkTokenProvider {
  #appId;
  #appPassword;
  #tenant;
  #loginBase;
  #scope;
  #fetch;
  #now;
  #cached = null;
  #loading = null;

  constructor({
    appId, appPassword, tenantId = null, loginBase = MICROSOFT_LOGIN_BASE, scope = BOT_FRAMEWORK_SCOPE,
    fetchImpl = globalThis.fetch, now = () => Date.now(),
  } = {}) {
    if (!appId || !appPassword) throw new TypeError('Teams App ID and password are required');
    this.#appId = appId;
    this.#appPassword = appPassword;
    this.#tenant = tenantId || MULTI_TENANT_AUTHORITY;
    this.#loginBase = String(loginBase).replace(/\/+$/, '');
    this.#scope = scope;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  get tenant() { return this.#tenant; }

  invalidate() { this.#cached = null; }

  async token({ signal } = {}) {
    if (this.#cached && this.#cached.expiresAt - 5 * 60 * 1000 > this.#now()) return this.#cached.value;
    this.#loading ??= (async () => {
      let result;
      try {
        result = await fetchJson(`${this.#loginBase}/${encodeURIComponent(this.#tenant)}/oauth2/v2.0/token`, {
          method: 'POST',
          form: {
            grant_type: 'client_credentials',
            client_id: this.#appId,
            client_secret: this.#appPassword,
            scope: this.#scope,
          },
          signal,
          fetchImpl: this.#fetch,
          prefix: 'teams-login',
        });
      } catch (error) {
        if (error?.status === 400 || error?.status === 401) {
          throw restError('Microsoft login rejected the Teams App ID or password', {
            code: 'teams-invalid-credentials', status: error.status, providerCode: error.providerCode,
          });
        }
        throw error;
      }
      const value = result.body?.access_token;
      if (typeof value !== 'string' || !value) throw restError('Microsoft login returned no access token', { code: 'teams-login-invalid' });
      const seconds = Number(result.body.expires_in) || 3600;
      this.#cached = { value, expiresAt: this.#now() + seconds * 1000 };
      return value;
    })().finally(() => { this.#loading = null; });
    return this.#loading;
  }
}
