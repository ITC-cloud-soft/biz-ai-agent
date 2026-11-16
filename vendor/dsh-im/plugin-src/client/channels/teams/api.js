// care fork: Teams management RPC client (same envelope as the token channels).
export { TEAMS_ENDPOINTS, TEAMS_RPC_CHANNEL, TEAMS_WEBHOOK_PATH, teamsClientApi } from './index.js';
import { teamsClientApi } from './index.js';

export const unwrapRpcResult = teamsClientApi.unwrapRpcResult;
export const normalizeSnapshot = teamsClientApi.normalizeSnapshot;
export const presentError = teamsClientApi.presentError;
