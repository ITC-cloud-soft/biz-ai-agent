# ケアビリング — care-specific extensions of the generic plugins (reference listing)

The framework plugins (`plugins/*`) carry no business wording and no business tools. ケアビリング plugs its own in through the
plugins' extension points; the code stays in care-ai-native (the `../../../../care-ai-native/…` links below assume the two repositories
side by side, as in `C:\work\deepseek-im`). This page lists **what** is plugged in; `test/care-billing.test.mjs` keeps the two
tables equal to the manifest (`../manifest/care-billing.manifest.yaml`).

| extension point (framework) | ケアビリング module (care-ai-native) | what it adds |
|---|---|---|
| `bridge-tools` → `toolModules` (`(kit) => tools`) | [plugins/care-tools/src/index.js](../../../../care-ai-native/plugins/care-tools/src/index.js) (package `@care/dsh-care-tools`, default export) | the 29 `care_*` tools below (27 in the manifest, the manual search `care_help_search` included, + 2 module-only) |
| `bridge-notify` → `templateModules` (`render` / `types`) | [plugins/care-notify/src/index.js](../../../../care-ai-native/plugins/care-notify/src/index.js) (package `@care/dsh-care-notify`: `render` = [templates.js](../../../../care-ai-native/plugins/care-notify/src/templates.js) facts + [secretary.js](../../../../care-ai-native/plugins/care-notify/src/secretary.js) `TEMPLATE_INTENTS`: intent, due, ask / note) | the wording of the 92 notification templates below |
| `bridge-notify` → `applications.care-billing.aiReportPrompt` / `aiReportMessages` | [plugins/care-notify/src/ai-report.js](../../../../care-ai-native/plugins/care-notify/src/ai-report.js) (the value is written in the profile's cordis.patch.yml) | 「【定時業務報告】… care_get_business_report を呼び…」 (the manifest playbook `daily_status_narrative`) |
| `bridge-events` → manifest `playbooks` | [dsh/runtime-profile/auto-tasks/](../../../../care-ai-native/dsh/runtime-profile/auto-tasks/README.md) (`visit-care-plan-draft.json`, `classification-signal-note.json`, `monitoring-draft.json`, `proposals/record-structuring.json`, `proposals/invoice-draft-gaps.json`), [proactive.config.json](../../../../care-ai-native/dsh/runtime-profile/proactive.config.json) | playbooks `care_visit_plan_draft`, `care_signal_note`, `care_monitoring_draft`, `business_patrol`, `daily_status_narrative`; delegation classes (`delegation`, the templates' `source.delegation`): `care` (計画書・兆候・記録の構造化), `billing` (請求の下書きの抜け), `care_manager=each` (モニタリングの参考の AI の要約 — a summary of the records without any evaluation field, E2: each run with the delegation care-api issues for the ケアマネ of its `monitoring.draft_requested`) — the profile installer's `--auto-task-delegate care=…,billing=…,care_manager=each` |
| agent presets (profile) | [dsh/runtime-profile/cordis.patch.yml](../../../../care-ai-native/dsh/runtime-profile/cordis.patch.yml) (`preset-care-billing`, `care-assistant`) | 請求担当（AI社員）・AI アシスタント: persona, tool surface (`care_*` + ask_user / todo / time only) |
| `bridge-identity` → `unlinkedReply` | [dsh/runtime-profile/cordis.patch.yml](../../../../care-ai-native/dsh/runtime-profile/cordis.patch.yml) | the 「設定 › SNS連携」 guide text for unlinked senders |
| `@dsh-bridge/web-kit` → `strings` / `notifyTypes` | [apps/care-web/src/lib/notify-core.ts](../../../../care-ai-native/apps/care-web/src/lib/notify-core.ts) (`NOTIFY_TYPES`, groups, `DEFAULT_OFF`) | the notification-preference rows of the SNS link page |
| `@dsh-bridge/plugin-memory` → `createMemoryPlugin` | [plugins/care-memory/src/index.js](../../../../care-ai-native/plugins/care-memory/src/index.js) (package `@care/dsh-care-memory`) | long-term memory with the earlier names: tools `care_memory_*`, storage `care_memory` / `care_memory_recall`, a scope-less save = 事業所の記憶, PII check `POST /api/ai/pii-scan` |
| `@dsh-bridge/web-kit` → `AiProfilePage` (`agents`) | [apps/care-web/src/pages/settings/AiProfile.tsx](../../../../care-ai-native/apps/care-web/src/pages/settings/AiProfile.tsx) | 「管理 › AI 社員の設定」 (`/settings/ai-profile`) with the four care AI employees; the profile lives in care-api (`sql/096_ai_profile.sql`) |

## Notification templates: intent table (`TEMPLATE_INTENTS`, plugins/care-notify/src/secretary.js)

`intent`: `info` 【ご報告】 / `action` 【対応のお願い】 / `urgent` 【至急】 / `approval` 【承認のお願い】 (no buttons: handed to 管理者 when the
requester is the only approver) / `consult` 【ご相談】. `ask` (every intent but info) or `note` (info) is the last line of
the AI-secretary message. The manifest declares the same templates with typed `params`, `intent` and `action`.

| template | intent | due | ask / note |
|---|---|---|---|
| `visit_record.submitted` | action | 本日中 | 業務 Web の「記録」で内容を確認し、承認の判断をお願いします。 |
| `visit_record.submitted.fallback` | approval | 本日中 | 業務 Web の「記録」で内容を確認し、承認の判断をお願いします。 |
| `visit_record.returned` | action |  | コメントを確認し、記録を直して再提出をお願いします（業務 Web の「記録」）。 |
| `visit.missed_check_in.assignee` | urgent | 至急 | 訪問中でしたら開始の打刻を、遅れる・伺えない場合は事業所へのご連絡をお願いします。 |
| `visit.missed_check_in.manager` | urgent | 至急 | 担当職員に状況を確認し、必要なら代わりの手配をお願いします（業務 Web の「訪問予定」）。 |
| `classification.signal_detected` | action |  | 業務 Web の「区分変更」で根拠を確認し、区分変更に向けた対応が必要かご判断をお願いします。 |
| `classification.signal_detected.care_manager` | consult |  | 業務 Web の「区分変更の兆候」で AI のまとめと根拠の記録を確かめ、区分変更の申請を検討するかお決めください。 |
| `visit_care_plan.submitted` | action |  | 業務 Web の「訪問介護計画書」で内容を確認し、承認の判断をお願いします。 |
| `visit_care_plan.submitted.fallback` | approval |  | 業務 Web の「訪問介護計画書」で内容を確認し、承認の判断をお願いします。 |
| `leave_request.submitted` | action | （件数・日付から計算） | 業務 Web の「希望休」で確認し、承認か差戻しをお願いします。 |
| `leave_request.submitted.fallback` | approval | （件数・日付から計算） | 業務 Web の「希望休」で確認し、承認か差戻しをお願いします。 |
| `leave_request.submitted.fallback.lead` | approval | （件数・日付から計算） | 業務 Web の「希望休」で確認し、承認か差戻しをお願いします。 |
| `leave_request.decided.approved` | info |  | ご対応は不要です。職員アプリでご確認だけお願いします。 |
| `leave_request.decided.returned` | action |  | 職員アプリで理由を確認し、必要なら日にちを変えて申請し直してください。 |
| `leave_request.decided` | info |  | 職員アプリで結果をご確認ください。ほかにご対応いただくことはありません。 |
| `shift.published` | info |  | ご対応は不要です。職員アプリでご自分の勤務日をご確認ください。 |
| `shift.assignment_changed` | info |  | ご対応は不要です。職員アプリで変更後の勤務をご確認ください。 |
| `attendance.month_closed` | action | （目安の日付があるとき） | （月から計算）業務 Web の「給与計算」で 10 月分の給与を計算し、管理者に承認を依頼してください。 |
| `payslip.issued` | info |  | ご対応は不要です。職員アプリでご確認ください。 |
| `safety_check.started` | urgent | （件数・日付から計算） | 職員アプリで、ご自身の状況を回答してください。 |
| `safety_check.reminder` | urgent | （件数・日付から計算） | 職員アプリで回答をお願いします。 |
| `safety_check.alert.urgent` | urgent | 至急 | 業務 Web の「安否確認」で状況を確認し、本人への連絡と支援の手配をお願いします。 |
| `safety_check.alert.response` | urgent | 至急 | 業務 Web の「安否確認」で回答を確認し、必要な対応をお願いします。 |
| `safety_check.alert.overdue` | urgent | 至急 | 業務 Web の「安否確認」で未回答の方を確認し、連絡を取ってください。 |
| `message.posted` | info |  | お手すきの際に、チャットで内容をご確認ください。 |
| `message.posted.announcement` | info |  | ご対応は不要です。チャットで内容をご確認ください。 |
| `care_document.due` | action | （件数・日付から計算） | 業務 Web の「帳票センター」で、期限までに作成・確認を済ませてください。 |
| `care_document.completed` | info |  | ご対応は不要です。念のため、業務 Web の「帳票センター」でご確認ください。 |
| `shift.swap_offered` | action | （件数・日付から計算） | 職員アプリで、承諾するか相談するかのお返事をお願いします。 |
| `shift.swap_decided.accepted` | info |  | ご対応は不要です。業務 Web でご確認だけお願いします。 |
| `shift.swap_decided.consult` | action |  | チャットで相談の内容を確認し、お返事をお願いします。 |
| `shift.swap_decided.declined` | action |  | 業務 Web で、ほかの職員への振替か日程の調整をお願いします。 |
| `incident.reported` | action（影響度 4 以上を含むと urgent） | （件数・日付から計算） | 業務 Web の「ヒヤリハット」で報告内容を確認し、必要な対応のご判断をお願いします。 |
| `incident.reported.care_manager` | urgent | 至急 | 介護担当と状況を確かめ、必要ならご家族・主治医への連絡と、計画の見直しをご検討ください。 |
| `record_correction.requested` | action |  | 業務 Web の「記録の訂正申請」で内容を確認し、承認か却下をお願いします。 |
| `record_correction.requested.fallback` | approval |  | 業務 Web の「記録の訂正申請」で内容を確認し、承認か却下をお願いします。 |
| `record_correction.decided.approved` | info |  | ご対応は不要です。職員アプリでご確認だけお願いします。 |
| `record_correction.decided.rejected` | action |  | 職員アプリで理由を確認し、必要なら申請し直してください。 |
| `care_inbox.received` | action |  | 業務 Web の「ケアマネ連携ボックス」で内容を確認し、振り分けをお願いします。 |
| `dunning.issued` | action |  | 業務 Web の「督促」で内容を確認し、送付の手配をお願いします。 |
| `business_report.ready` | info |  |  |
| `invoice.issued` | info |  | ご対応は不要です。念のため、業務 Web の「請求書」でご確認ください。 |
| `receipt.issued` | info |  | ご対応は不要です。業務 Web の「領収書 発行」でご確認いただけます。 |
| `import.completed` | info |  | ご対応は不要です。結果は業務 Web でご確認いただけます。 |
| `reconciliation.completed` | info（未解決があると action） |  | 業務 Web の「回数突合」で、未解決の差異を確認してください。 |
| `billing_hold.started` | info |  | ご対応は不要です。ご確認だけお願いします。 |
| `billing_hold.released` | action |  | 業務 Web の「月次請求」で、作成された請求の下書きを確認してください。 |
| `approval.decided` | info（却下を含むと action） |  | 業務 Web の「承認」で却下のコメントを確認し、修正のうえ依頼し直してください。 |
| `approval.decided.payroll` | info（差戻しを含むと action） |  | 業務 Web の「給与計算」でコメントを確認し、明細を直して承認を依頼し直してください。 |
| `approval.expired` | action |  | 必要でしたら、業務 Web の「承認」から依頼し直してください。 |
| `approval.expired.payroll` | action |  | 業務 Web の「給与計算」で明細を確認し、もう一度承認を依頼してください。 |
| `approval.reminded` | approval | （件数・日付から計算） | お届けした承認カード、または業務 Web の「承認」で、「承認」か「差戻」をお選びください。 |
| `approval.reminded.payroll` | approval | （件数・日付から計算） | 業務 Web の「承認」で明細を確認し、「承認」か「差戻」を選んでください（お届けした承認カードからも選べます）。 |
| `ai_proposal.created` | action |  | 業務 Web の「AI 提案」で内容を確認し、採用か却下をお決めください。 |
| `ai_proposal.created.monitoring` | action | 月末まで | 居宅訪問のあと、業務 Web の「モニタリング」で居宅訪問の記録を書くときの参考にしてください（目標の達成状況・満足度・計画の変更の必要は、ケアマネジャーが記入します）。 |
| `classification.change_applied` | info |  | ご対応は不要です。ご確認だけお願いします。 |
| `classification.change_decided` | info |  | ご対応は不要です。保留していた月の請求の下書きは、請求・給与担当が確認します。 |
| `visit_care_plan.approved` | info |  | ご対応は不要です。業務 Web でご確認だけお願いします。 |
| `visit_care_plan.delivered` | info |  | ご対応は不要です。お手すきの際に「受け取った計画書」でご確認ください（確認すると受領の記録が残ります）。 |
| `care_plan.imported` | info |  | ご対応は不要です。業務 Web の「訪問介護計画書」でご確認いただけます。 |
| `care_plan.delivered` | action |  | 業務 Web の「訪問介護計画書」で変更のあった表を確かめ、計画書の見直しをお願いします（AI の下書きが届いたら「AI 提案」でご確認ください）。 |
| `provision.delivered` | action |  | 業務 Web の「訪問予定」で、提供票（第 6 表）からの予定の生成のプレビューを確かめ、訪問予定を作ってください。 |
| `provision.actual_completed` | info |  | ご対応は不要です。差異があれば「提供票」でご確認ください。 |
| `provision.missing` | action | （日付から計算） | （月から計算）業務 Web の「提供票」で 12 月分を作り、交付してください。交付すると訪問介護の予定づくりに回ります。 |
| `certification.expiring` | action | （件数・日付から計算） | 業務 Web の「認定・期限」で更新申請の準備をお願いします。 |
| `care_plan.period_expiring` | action | （件数・日付から計算） | 業務 Web の「ケアプラン」で次の期間の版の準備をお願いします。 |
| `monitoring.due` | action | 月末まで | （AI の要約の件数を添える）月末までに居宅を訪問して本人に面接し、業務 Web の「モニタリング」で居宅訪問の記録を確定してください。 |
| `care_manager.assignment_changed` | info |  | ご対応は不要です。「担当利用者」でご確認ください。 |
| `care_manager.assignment_changed.manager` | info |  | ご対応は不要です。訪問介護計画書の交付先と、連絡するケアマネジャーが替わります。 |
| `care_manager.cover_started` | info |  | ご対応は不要です。代行の期間は MM/DD までです。 |
| `care_plan.review_requested` | action |  | 業務 Web の「チーム」で依頼のあったケアプランを確かめ、確認のコメントをお願いします（交付は止めません）。 |
| `escalation.raised` | consult |  | 担当の方に声をかけていただくか、お休みでしたら業務 Web で代わりにご対応ください。 |
| `escalation.raised.lead` | consult |  | 業務 Web のチーム画面で担当の方を確かめて声をかけていただくか、お休みでしたら代行の設定をお願いします。 |
| `escalation.raised.lead.fallback` | consult |  | 担当のケアマネに声をかけていただくか、お休みでしたら業務 Web で担当替え・代行の設定をお願いします。 |
| `escalation.raised.missed_check_in` | urgent | 至急 | 介護担当と連絡を取り、必要なら利用者宅への連絡と代わりの手配をお願いします（業務 Web の「訪問予定」）。 |
| `portal_message.received` | action |  | 業務 Web の「外部ケアマネの窓口」か利用者の画面（ケア連携）で連絡を確かめ、必要ならお返事をお願いします。 |
| `portal_message.received.fallback` | action |  | 業務 Web の「外部ケアマネの窓口」で連絡を確かめ、介護担当への引き継ぎかお返事をお願いします。 |
| `benefit_statement.due` | action | （締切の日付から計算） | （月から計算）業務 Web の「給付管理票」で 10 月分を作って確定してください（確定した票を請求・給与担当が国保連に伝送します）。 |
| `benefit_review.imported` | action |  | 業務 Web の「給付管理票」の「返戻・保留あり」で該当の票を確かめ、直した票を作って確定してください。 |
| `caseload.band_crossed` | info |  | ご対応は不要です。内訳は業務 Web の「件数・集中減算」でご確認いただけます（担当の調整は主任ケアマネとご相談ください）。 |
| `caseload.band_crossed.lead` | action |  | （事業所の判定のときは「事業所の件数と常勤換算」）業務 Web の「件数・集中減算」でチームの件数を確かめ、必要なら担当の調整をご検討ください。 |
| `concentration.over` | action |  | 業務 Web の「件数・集中減算」で内訳を確かめ、正当な理由の有無と判定書の準備をご検討ください。 |
| `usage_consent.missing` | action |  | （月から計算）業務 Web の「提供票」で 5 月分の利用票を開き、利用者の同意（同意日・方法）を記録してください。 |
| `cm_records.attention` | action |  | 業務 Web の「アセスメント」「サービス担当者会議（第4表）」「支援経過（第5表）」の一覧で「要対応だけ」を開き、順にご確認ください。 |
| `provider_message.received` | action |  | 業務 Web の「提供票」で該当の事業所の「連絡」を開いて確かめ、必要ならお返事をお願いします。 |
| `provider_actuals.received` | info |  | ご対応は不要です。予定との違いは業務 Web の「提供票」でご確認いただけます。 |
| `conference_schedule.upcoming` | action |  | 業務 Web の「サービス担当者会議（第4表）」で予定を開き、出席の依頼と照会（出られない事業所）を確かめてください。 |
| `conference_schedule.overdue` | action |  | 業務 Web の会議の予定を開き、開いたなら「開催の記録を作る」、開かなかったなら予定日を直すか取りやめてください。 |
| `public_master.release_ready` | action |  | 業務 Web の「管理 › 公的マスタ」で差分と検証の結果を確かめ、版の名前を入れて承認するか、却下してください。 |
| `public_master.release_failed` | action |  | 業務 Web の「管理 › 公的マスタ」で検証の結果を確かめ、正しいファイルを取り込み直すか、改定案を却下してください。 |
| `public_master.effective_soon` | info |  | ご対応は不要です。適用日から計算に使われます（版は業務 Web の「管理 › 公的マスタ」で確かめられます）。 |
| `public_master.update_detected` | info |  | 業務 Web の「管理 › 公的マスタ」の監視の欄で、見つけた版・お知らせを確かめられます。改定案ができたら別にお知らせします。 |

## Tools (`care_*`, plugins/care-tools/src)

`read` tools only `GET` (delegation = manifest tool roles ∩ the employee's role); `propose` tools only `POST` a proposal that a
person accepts in the business web. There is no `write` access.

| tool | access | care-api route | roles | source |
|---|---|---|---|---|
| `care_health` | read | `GET /health` | admin, manager, billing, staff | [index.js](../../../../care-ai-native/plugins/care-tools/src/index.js) |
| `care_list_buildings` | read | `GET /api/buildings` | admin, manager, billing, staff | [index.js](../../../../care-ai-native/plugins/care-tools/src/index.js) |
| `care_list_invoices` | read | `GET /api/invoices` | admin, billing | [index.js](../../../../care-ai-native/plugins/care-tools/src/index.js) |
| `care_get_invoice` | read | `GET /api/invoices/{invoiceId}` | admin, billing | [index.js](../../../../care-ai-native/plugins/care-tools/src/index.js) |
| `care_list_approvals` | read | `GET /api/approvals` | admin, billing | [index.js](../../../../care-ai-native/plugins/care-tools/src/index.js) |
| `care_propose_invoice_draft` | propose | `POST /api/ai/proposals` | admin, billing | [index.js](../../../../care-ai-native/plugins/care-tools/src/index.js) |
| `care_list_visit_records` | read | `GET /api/visit-records` | admin, manager, staff | [records.js](../../../../care-ai-native/plugins/care-tools/src/records.js) |
| `care_list_missed_visits` | read | `GET /api/visits` | admin, manager, staff | [records.js](../../../../care-ai-native/plugins/care-tools/src/records.js) |
| `care_propose_record_structuring` | propose | `POST /api/ai/proposals` | admin, manager, staff | [records.js](../../../../care-ai-native/plugins/care-tools/src/records.js) |
| `care_get_care_plan_source` | read | `GET /api/care-docs/{docId}` | admin, manager | [careplan.js](../../../../care-ai-native/plugins/care-tools/src/careplan.js) |
| `care_get_visit_care_plan` | read | `GET /api/visit-care-plans/{visitCarePlanId}` | admin, manager | [careplan.js](../../../../care-ai-native/plugins/care-tools/src/careplan.js) |
| `care_propose_visit_care_plan` | propose | `POST /api/ai/care-plan-proposals` | admin, manager | [careplan.js](../../../../care-ai-native/plugins/care-tools/src/careplan.js) |
| `care_propose_wording_alternatives` | propose | `POST /api/ai/care-plan-proposals` | admin, manager | [careplan.js](../../../../care-ai-native/plugins/care-tools/src/careplan.js) |
| `care_list_classification_signals` | read | `GET /api/classification-signals` | admin, manager | [careplan.js](../../../../care-ai-native/plugins/care-tools/src/careplan.js) |
| `care_propose_monthly_report` | propose | `POST /api/ai/document-proposals` | admin, manager | [documents.js](../../../../care-ai-native/plugins/care-tools/src/documents.js) |
| `care_propose_case_meeting_summary` | propose | `POST /api/ai/document-proposals` | admin, manager | [documents.js](../../../../care-ai-native/plugins/care-tools/src/documents.js) |
| `care_propose_assessment_draft` | propose | `POST /api/ai/document-proposals` | admin, manager | [caremanager.js](../../../../care-ai-native/plugins/care-tools/src/caremanager.js) |
| `care_propose_incident_classification` | propose | `POST /api/ai/incident-proposals` | admin, manager, staff | [incidents.js](../../../../care-ai-native/plugins/care-tools/src/incidents.js) |
| `care_propose_inbox_fields` | propose | `POST /api/ai/inbox-field-proposals` | admin, manager | [caremanager.js](../../../../care-ai-native/plugins/care-tools/src/caremanager.js) |
| `care_propose_import_mapping` | propose | `POST /api/billing-import/samples/{sampleId}/mapping-proposals` | admin, billing | [import-mapping.js](../../../../care-ai-native/plugins/care-tools/src/import-mapping.js) |
| `care_propose_dunning_letter` | propose | `POST /api/ai/dunning-proposals` | admin, billing | [dunning.js](../../../../care-ai-native/plugins/care-tools/src/dunning.js) |
| `care_get_business_report` | read | `GET /api/ai/business-report` | admin, manager, billing, staff, care_manager | [business-report.js](../../../../care-ai-native/plugins/care-tools/src/business-report.js) |
| `care_cm_caseload` | read | `GET /api/cm/home` | admin, care_manager | [cm-monitoring.js](../../../../care-ai-native/plugins/care-tools/src/cm-monitoring.js) |
| `care_cm_resident_summary` | read | `GET /api/cm/residents/{residentId}` | admin, care_manager | [cm-monitoring.js](../../../../care-ai-native/plugins/care-tools/src/cm-monitoring.js) |
| `care_cm_certifications` | read | `GET /api/cm/certifications` | admin, care_manager | [cm-reads.js](../../../../care-ai-native/plugins/care-tools/src/cm-reads.js) |
| `care_cm_signals` | read | `GET /api/cm/signals` | admin, care_manager | [cm-reads.js](../../../../care-ai-native/plugins/care-tools/src/cm-reads.js) |
| `care_help_search` | read | `GET /api/help/search` | admin, manager, billing, staff, care_manager | [help.js](../../../../care-ai-native/plugins/care-tools/src/help.js) |
| `care_propose_monitoring_draft` | propose | `POST /api/ai/monitoring-proposals` | care_manager | [cm-monitoring.js](../../../../care-ai-native/plugins/care-tools/src/cm-monitoring.js) |

Module-only (registered by the care tool module, not declared in the manifest): `care_list_invoice_gaps`
([billing-gaps.js](../../../../care-ai-native/plugins/care-tools/src/billing-gaps.js)), `care_get_visit_record`
([records.js](../../../../care-ai-native/plugins/care-tools/src/records.js)).
