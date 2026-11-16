import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renameReplacing } from '../../src/channels/shared/rename-retry.mjs';

const failing = (code, times, calls) => async () => {
  calls.push(code);
  if (calls.length <= times) throw Object.assign(new Error(code), { code });
};

test('renameReplacing retries a transient Windows rename error and then succeeds', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const calls = [];
    await renameReplacing('a', 'b', { platform: 'win32', delayMs: 1, renameImpl: failing(code, 3, calls) });
    assert.equal(calls.length, 4, code);
  }
});

test('renameReplacing gives up after the attempt budget and rethrows the original error', async () => {
  const calls = [];
  await assert.rejects(
    renameReplacing('a', 'b', { platform: 'win32', attempts: 3, delayMs: 1, renameImpl: failing('EPERM', 99, calls) }),
    { code: 'EPERM' },
  );
  assert.equal(calls.length, 3);
});

test('renameReplacing never retries other platforms or other error codes', async () => {
  const posix = [];
  await assert.rejects(renameReplacing('a', 'b', { platform: 'linux', renameImpl: failing('EPERM', 99, posix) }), { code: 'EPERM' });
  assert.equal(posix.length, 1);
  const missing = [];
  await assert.rejects(renameReplacing('a', 'b', { platform: 'win32', renameImpl: failing('ENOENT', 99, missing) }), { code: 'ENOENT' });
  assert.equal(missing.length, 1);
});

test('renameReplacing replaces an existing file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rename-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'state.json'), 'old');
  await writeFile(join(dir, 'state.json.tmp'), 'new');
  await renameReplacing(join(dir, 'state.json.tmp'), join(dir, 'state.json'));
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), 'new');
});
