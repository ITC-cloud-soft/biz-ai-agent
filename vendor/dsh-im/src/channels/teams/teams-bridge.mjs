import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';

export const TEAMS_DESCRIPTOR = Object.freeze({
  key: 'teams',
  label: 'Teams',
  connectionLabel: ' Webhook',
  reactions: Object.freeze({}),
});

export class TeamsHarnessBridge extends TextHarnessBridge {
  constructor(options) {
    super({ descriptor: TEAMS_DESCRIPTOR, ...options });
  }
}

export { createTextBridgeStatus as createTeamsBridgeStatus };
