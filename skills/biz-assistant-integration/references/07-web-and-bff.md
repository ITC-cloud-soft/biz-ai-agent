# 07 Business web app screens (web-kit) and the BFF

Sources of truth: `docs/GUIDELINE.en.md` b.6, d.9, `packages/web-kit/README.md`, `packages/gateway` (README), `docs/ARCHITECTURE.md` §9.

## 1. Screens

| Screen | Component | Who |
|---|---|---|
| IM bot connection (organization bots) | `ImBotsShell mode="admin"` (`channels` is required: `channelDefs(DEFAULT_CHANNELS, loaders)`. Use `excludeBotIds` to leave out employees' personal bots) | Administrators |
| Chat link | `SnsLinkPage`: ① own bots (`personalChannels` + `personalRpc`) ② link codes for organization bots ③ own links and unlinking ④ notification settings | All employees (only their own) |
| Notification settings | `NotifyPrefsCard` (build `labels` **at build time** from `events.<type>.label` in the manifest. The manifest can only be fetched with the service token) | All employees |
| AI employee settings | `AiProfilePage` (by default, do not pass `agents`: one nickname) | Administrators |
| Attachment settings | `AttachmentSettingsCard` | Administrators |
| External connectors | `ExternalConnectorsPage` | Administrators |
| Help (manual) | web-kit core's `manualChapters` / `parseMarkdown` | All employees |
| Approval, AI proposal and AI assistant panels | Not in the framework; build them per business. Proposals: `GET /bridge/v1/proposals`, `POST …/{proposalId}/accept`, `POST …/{proposalId}/reject`. Approvals: the business system's own `/api/*` (`mayDecide`, `decide`, `t.revokeApprovalDeliveries`) | — |

```tsx
<WebKitProvider runtime={runtime}
  meIm={createMeImClient({ base: '/bridge/v1', weixinBase: '/api/me/im/weixin' })}   // same origin, the person's own session (weixinBase: null if unused)
  adminRpc={createAdminRpc('/dsh/api/dsh-im')}                                         // the BFF's DSH gateway
  strings={{ 'sns.title': 'External account links' }}>
  <SnsLinkPage isAdmin={user.role === 'admin'} notify={{ role: user.role, labels: manifestEventLabels }} />
</WebKitProvider>
```

web-kit ships as `.ts`: load it with the business web app's bundler, and include `tsc --noEmit` in the completion criteria.

## 2. BFF rules (enforced by the BFF and the business system; web-kit only adjusts what is shown)

- Put `@dsh-bridge/gateway` **before** the `/api/*` proxy (`gateway.handleRequest(req, res)`; for WebSocket, `handleUpgrade`).
  `getSessionUser` calls the business API's login check with the req's cookie. `isAllowed` is normally admins only (the DSH settings screens `/dsh/*`).
- Forward browser requests to the business system only for the routes web-kit calls on the same origin and for the business `/api/*`: `/bridge/v1/me/*`, `/bridge/v1/admin/ai-profile*`,
  the attachment settings, `/bridge/v1/admin/connector*`, `/bridge/v1/proposals` (and accept / reject). **Keep the person's cookie as is, and do not add `x-bff-secret`**.
- **MUST** add `x-bff-secret` only to calls the BFF itself builds on the server side:
  - The web assistant ticket `POST /bridge/v1/assistant/tickets`
  - Attachment conversion `POST /bridge/v1/assistant/attachments/prepare` (`prepareAssistantAttachments`)
  - Registering a personal bot right after a successful `createOnly` creation through the self-service RPC: `POST /bridge/v1/me/personal-bots`
  Do not forward these requests when they come from the browser (if relayed with the secret, someone could register an organization bot as their own personal bot, and every other employee would become "unlinked").
- Server-side RPC lets through only what is listed in `rpcAllowlist` (empty means everything is rejected). The AI assistant uses
  `gateway.rpc('/assistant', 'message.send', { ticket, agent, text, attachments }, { plugin: 'bridge-assistant' })`. Never expose the ticket, the DSH cookie or the launch token to the browser.

## 3. Personal bots (if used, d.9)

- Build a self-service RPC in the BFF (`POST /api/me/im/rpc/<channel>`). It is neither a framework component nor in the sample, so meet all of the following MUSTs:
  - A per-channel allowlist (no means of changing the working folder, model, preset, context enrichment or access policy is allowed)
  - `botId` only for the person's own bots (check with `GET /bridge/v1/me/personal-bots` every time), and narrow the response's `bots[]` to the person's own
  - Create with `createOnly: true` (`bot-exists` if it hits an existing bot), serialize, register the new botId to the person, and on failure delete the bot to roll back
- Each employee configures only their own connections. Do not build screens or APIs that view, create or remove other people's connections (administrators included).
- The owner rule for lookups (for a personal bot, linked only when the link belongs to its owner) is in server-kit. Mandatory for your own implementation.
