// care fork: process-wide registry of webhook receivers for the channels that
// receive events over public HTTPS (LINE, Teams). The Host mounts one route per
// channel (`/dsh-hooks/<channel>`, see plugin-src/host/webhook-http.mjs) and
// asks every receiver of that channel in turn; a receiver answers `null` when
// the request is not addressed to it (signature/audience mismatch) and a
// response `{ status, body?, headers? }` when it is.
//
// Authenticity is checked by the receiver (LINE: X-Line-Signature HMAC; Teams:
// Bot Framework JWT). The gateway in front of DSH forwards these paths without
// admin authentication.

export const WEBHOOK_PATHS = Object.freeze({
  line: '/dsh-hooks/line',
  teams: '/dsh-hooks/teams',
});

export function createWebhookHub() {
  const receivers = new Map();
  return {
    register(channel, receiver) {
      if (!WEBHOOK_PATHS[channel]) throw new TypeError(`Unknown webhook channel: ${channel}`);
      if (!receiver || typeof receiver.handleWebhook !== 'function') {
        throw new TypeError('A webhook receiver needs handleWebhook()');
      }
      const set = receivers.get(channel) ?? new Set();
      set.add(receiver);
      receivers.set(channel, set);
      let disposed = false;
      return () => {
        if (disposed) return false;
        disposed = true;
        set.delete(receiver);
        return true;
      };
    },
    count(channel) {
      return receivers.get(channel)?.size ?? 0;
    },
    /**
     * @param {'line'|'teams'} channel
     * @param {{ rawBody: Buffer, headers: Record<string, string|string[]|undefined> }} request
     * @returns {Promise<{ status: number, body?: unknown, headers?: Record<string,string> }>}
     */
    async dispatch(channel, request) {
      for (const receiver of [...(receivers.get(channel) ?? [])]) {
        const result = await receiver.handleWebhook(request);
        if (result) return result;
      }
      return { status: 401, body: { error: 'unauthorized' } };
    },
    reset() {
      receivers.clear();
    },
  };
}

/** The single hub shared by every channel inside one Host bundle. */
export const webhookHub = createWebhookHub();
