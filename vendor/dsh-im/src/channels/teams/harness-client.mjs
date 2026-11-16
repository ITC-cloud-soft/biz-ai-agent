import { HarnessClient } from '../shared/harness-client.mjs';

export class TeamsHarnessClient extends HarnessClient {
  constructor(options) {
    super({ ...options, rpcIdPrefix: 'teams', logPrefix: 'dsh-teams' });
  }
}
