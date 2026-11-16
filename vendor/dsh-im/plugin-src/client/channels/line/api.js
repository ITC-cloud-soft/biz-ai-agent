// care fork: LINE management RPC client (same envelope as the token channels).
export { LINE_ENDPOINTS, LINE_RPC_CHANNEL, LINE_WEBHOOK_PATH, lineClientApi } from './index.js';
import { lineClientApi } from './index.js';

export const unwrapRpcResult = lineClientApi.unwrapRpcResult;
export const normalizeSnapshot = lineClientApi.normalizeSnapshot;
export const presentError = lineClientApi.presentError;
