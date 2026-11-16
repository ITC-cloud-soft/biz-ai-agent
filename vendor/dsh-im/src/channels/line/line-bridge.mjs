import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';

export const LINE_DESCRIPTOR = Object.freeze({
  key: 'line',
  label: 'LINE',
  connectionLabel: ' Webhook',
  // LINE has no message reactions for bots.
  reactions: Object.freeze({}),
});

export class LineHarnessBridge extends TextHarnessBridge {
  constructor(options) {
    super({ descriptor: LINE_DESCRIPTOR, ...options });
  }
}

export { createTextBridgeStatus as createLineBridgeStatus };
