// care fork (Phase 4 WS-U): CARE_DSH_IM_LINE_API_BASE — loopback-only LINE API base override for e2e.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LINE_API_BASE_ENV, lineApiBaseFromEnv } from '../../plugin-src/host/channels/line/index.mjs';

const quiet = () => {
  const warnings = [];
  return { warnings, logger: { warn: (m) => warnings.push(String(m)) } };
};

test('unset or blank: no override (real api.line.me stays)', () => {
  const { logger, warnings } = quiet();
  assert.equal(LINE_API_BASE_ENV, 'CARE_DSH_IM_LINE_API_BASE');
  assert.equal(lineApiBaseFromEnv({}, logger), undefined);
  assert.equal(lineApiBaseFromEnv({ CARE_DSH_IM_LINE_API_BASE: '   ' }, logger), undefined);
  assert.deepEqual(warnings, []);
});

test('loopback http(s) origins are accepted (trailing slash trimmed, path kept)', () => {
  const { logger, warnings } = quiet();
  assert.equal(lineApiBaseFromEnv({ CARE_DSH_IM_LINE_API_BASE: 'http://127.0.0.1:3197' }, logger), 'http://127.0.0.1:3197');
  assert.equal(lineApiBaseFromEnv({ CARE_DSH_IM_LINE_API_BASE: 'http://localhost:3197/' }, logger), 'http://localhost:3197');
  assert.equal(lineApiBaseFromEnv({ CARE_DSH_IM_LINE_API_BASE: 'https://[::1]:8443/mock/' }, logger), 'https://[::1]:8443/mock');
  assert.equal(warnings.length, 3, 'each accepted override is announced');
  assert.match(warnings[0], /test override/);
});

test('non-loopback, credentials, query or other schemes are ignored with a warning', () => {
  for (const value of [
    'https://api.line.me',
    'http://10.0.0.5:3197',
    'http://127.0.0.1.evil.example:3197',
    'http://localhost.example',
    'http://user:pw@127.0.0.1:3197',
    'http://127.0.0.1:3197/?x=1',
    'file:///etc/passwd',
    'ftp://127.0.0.1/',
    'not a url',
  ]) {
    const { logger, warnings } = quiet();
    assert.equal(lineApiBaseFromEnv({ CARE_DSH_IM_LINE_API_BASE: value }, logger), undefined, value);
    assert.equal(warnings.length, 1, value);
    assert.match(warnings[0], /ignoring CARE_DSH_IM_LINE_API_BASE/);
  }
});
