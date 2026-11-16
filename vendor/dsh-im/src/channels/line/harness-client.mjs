import { HarnessClient } from '../shared/harness-client.mjs';

export class LineHarnessClient extends HarnessClient {
  constructor(options) {
    super({ ...options, rpcIdPrefix: 'line', logPrefix: 'dsh-line' });
  }
}
