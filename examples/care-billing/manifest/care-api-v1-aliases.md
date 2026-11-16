# care-api ↔ Bridge v1 route table (ケアビリング)

care-api serves `/bridge/v1` natively by mapping each v1 operation onto the route below; `status`: `exact` = same body,
`shape` = adapted to the v1 shape, `missing` = not implemented. The same data as JSON: `care-api-v1-aliases.json`, a copy of
care-ai-native `services/care-api/bridge/care-api-v1-aliases.json` (the source care-api reads at start-up). The table below is
`bridge-validate aliases --table care-api-v1-aliases.json --label care-api` (care-ai-native's
`services/care-api/bridge/test/manifest.test.mjs` checks it).

| v1 | operation | care-api | status |
|---|---|---|---|
| `GET /bridge/v1/health` | getHealth | GET /health | exact |
| `GET /bridge/v1/manifest` | getManifest | GET /bridge/v1/manifest | exact |
| `GET /bridge/v1/identity` | lookupIdentity | GET /api/ai/identity | exact |
| `POST /bridge/v1/identities/link` | linkIdentity | POST /api/ai/sns-identities/link | exact |
| `GET /bridge/v1/identities/stats` | identityStats | GET /api/ai/identity/stats | exact |
| `POST /bridge/v1/me/link-codes` | createLinkCode | POST /api/sns-identities/link-codes | exact |
| `GET /bridge/v1/me/identities` | listMyIdentities | GET /api/sns-identities | shape |
| `DELETE /bridge/v1/me/identities/{identityId}` | deleteMyIdentity | DELETE /api/sns-identities/{identityId} | exact |
| `GET /bridge/v1/me/identities/{identityId}/bot` | getMyIdentityBot | GET /api/sns-identities/{identityId}/bot | exact |
| `GET /bridge/v1/me/personal-bots` | listMyPersonalBots | GET /api/me/im-bots | exact |
| `POST /bridge/v1/me/personal-bots` | registerMyPersonalBot | POST /api/me/im-bots | exact |
| `GET /bridge/v1/me/notification-preferences` | getMyNotificationPreferences | GET /api/me/notification-preferences | exact |
| `PUT /bridge/v1/me/notification-preferences` | updateMyNotificationPreferences | PUT /api/me/notification-preferences | exact |
| `POST /bridge/v1/delegations` | issueDelegation | POST /api/ai/delegations | exact |
| `GET /bridge/v1/events` | listEvents | GET /api/ai/events | exact |
| `GET /bridge/v1/notifications/for-event/{eventId}` | resolveNotificationRecipients | GET /api/ai/notifications/for-event/{eventId} | exact |
| `POST /bridge/v1/notifications/deliveries` | recordNotificationDelivery | POST /api/ai/notifications/deliveries | exact |
| `POST /bridge/v1/approvals/{approvalId}/deliveries` | createApprovalDeliveries | POST /api/ai/approvals/{approvalId}/deliveries | exact |
| `POST /bridge/v1/approvals/{approvalId}/deliveries/{deliveryId}/sent` | markApprovalDeliverySent | POST /api/ai/approvals/{approvalId}/deliveries/{deliveryId}/sent | exact |
| `POST /bridge/v1/approvals/{approvalId}/im-decision` | imDecision | POST /api/ai/approvals/{approvalId}/im-decision | exact |
| `POST /bridge/v1/approvals/im-decisions` | imDecisionByReplyCode | POST /api/ai/im-decisions | exact |
| `POST /bridge/v1/assistant/tickets` | issueAssistantTicket | POST /api/assistant/tickets | exact |
| `POST /bridge/v1/assistant/delegations` | exchangeAssistantTicket | POST /api/ai/assistant/delegations | exact |
| `POST /bridge/v1/assistant/attachments/prepare` | prepareAssistantAttachments | POST /api/assistant/attachments/prepare | exact |
| `GET /bridge/v1/assistant/attachment-settings` | getAssistantAttachmentSettings | GET /api/assistant/attachment-settings | exact |
| `GET /bridge/v1/admin/assistant/attachment-settings` | getAdminAssistantAttachmentSettings | GET /api/admin/assistant/attachment-settings | exact |
| `PUT /bridge/v1/admin/assistant/attachment-settings` | putAdminAssistantAttachmentSettings | PUT /api/admin/assistant/attachment-settings | exact |
| `GET /bridge/v1/reports/latest` | getLatestReport | GET /api/business-reports/latest (user)<br>GET /api/ai/business-report (delegated) | exact/shape |
| `POST /bridge/v1/reports/run` | runReport | POST /api/settings/business-report/test | exact |
| `GET /bridge/v1/proposals` | listProposals | GET /api/ai/proposals | exact |
| `POST /bridge/v1/proposals` | createProposal | POST /api/ai/proposals | exact |
| `POST /bridge/v1/proposals/{proposalId}/accept` | acceptProposal | POST /api/ai/proposals/{proposalId}/accept | exact |
| `POST /bridge/v1/proposals/{proposalId}/reject` | rejectProposal | POST /api/ai/proposals/{proposalId}/reject | exact |
| `POST /bridge/v1/pii-scan` | piiScan | POST /api/ai/pii-scan | exact |
| `GET /bridge/v1/help/search` | searchHelp | GET /api/help/search | exact |
| `GET /bridge/v1/help/public` | searchPublicHelp | GET /api/ai/help/public | exact |
| `GET /bridge/v1/help/sections/{sectionId}` | getHelpSection | GET /api/help/sections/{sectionId} | exact |
| `GET /bridge/v1/ai-profile` | getAiProfile | GET /api/ai/ai-profile | exact |
| `GET /bridge/v1/admin/ai-profile` | getAdminAiProfile | GET /api/ai-profile | exact |
| `PUT /bridge/v1/admin/ai-profile` | putAdminAiProfile | PUT /api/ai-profile | exact |
| `POST /bridge/v1/admin/ai-profile/versions/{version}/restore` | restoreAiProfileVersion | POST /api/ai-profile/versions/{version}/restore | exact |
| `GET /bridge/v1/connectors/catalog` | getConnectorCatalog | GET /api/ai/connectors/catalog | exact |
| `POST /bridge/v1/connectors/{connectorId}/operations/{operationId}/run` | runConnectorOperation | POST /api/ai/connectors/{connectorId}/operations/{operationId}/run | exact |
| `GET /bridge/v1/admin/connectors` | listAdminConnectors | GET /api/admin/connectors | exact |
| `PUT /bridge/v1/admin/connectors/{connectorId}` | putAdminConnector | PUT /api/admin/connectors/{connectorId} | exact |
| `DELETE /bridge/v1/admin/connectors/{connectorId}` | deleteAdminConnector | DELETE /api/admin/connectors/{connectorId} | exact |
| `PUT /bridge/v1/admin/connectors/{connectorId}/secret` | putAdminConnectorSecret | PUT /api/admin/connectors/{connectorId}/secret | exact |
| `DELETE /bridge/v1/admin/connectors/{connectorId}/secret` | deleteAdminConnectorSecret | DELETE /api/admin/connectors/{connectorId}/secret | exact |
| `POST /bridge/v1/admin/connectors/{connectorId}/test` | testAdminConnector | POST /api/admin/connectors/{connectorId}/test | exact |
| `GET /bridge/v1/admin/connector-rules` | listAdminConnectorRules | GET /api/admin/connector-rules | exact |
| `PUT /bridge/v1/admin/connector-rules/{ruleId}` | putAdminConnectorRule | PUT /api/admin/connector-rules/{ruleId} | exact |
| `DELETE /bridge/v1/admin/connector-rules/{ruleId}` | deleteAdminConnectorRule | DELETE /api/admin/connector-rules/{ruleId} | exact |
| `GET /bridge/v1/admin/connector-runs` | listAdminConnectorRuns | GET /api/admin/connector-runs | exact |
| `PUT /bridge/v1/admin/connector-settings` | putAdminConnectorSettings | PUT /api/admin/connector-settings | exact |
| `GET /bridge/v1/document-reads` | claimDocumentReads | GET /api/ai/document-reads | exact |
| `POST /bridge/v1/document-reads/{readId}/result` | answerDocumentRead | POST /api/ai/document-reads/{readId}/result | exact |
