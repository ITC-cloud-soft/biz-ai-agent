import { rename } from 'node:fs/promises';

// care fork: Windows refuses to rename over a file that another handle has open
// (a concurrent reader, an antivirus or search-indexer scan) and reports EPERM /
// EBUSY / EACCES instead of waiting. The handle is released within milliseconds,
// so retry briefly. Other platforms and other error codes are never retried.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function renameReplacing(from, to, {
  attempts = 30,
  delayMs = 10,
  platform = process.platform,
  renameImpl = rename,
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await renameImpl(from, to);
    } catch (error) {
      if (platform !== 'win32' || !TRANSIENT.has(error?.code) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
