// 見本：設備点検（examples/equipment-inspection）の手書きツール。
//
// 読み取りツール（facility_list_equipment / facility_list_overdue）は manifest の
// tools から bridge-tools が自動で作る。ここは manifest から作れない「提案」ツールを 1 つだけ手で書く見本：
//
//   facility_propose_reschedule  次回点検日の変更の提案（POST /bridge/v1/proposals {kind: inspection_reschedule, payload}）
//
// 使い方（製品 profile の cordis.patch.yml）：
//   - id: bridge-tools
//     name: '@dsh-bridge/plugin-tools'
//     config:
//       toolModules:
//         - module: '@dsh-bridge/plugin-tools/examples/equipment-inspection'
//           application: equipment-inspection
//
// 業務の形の検証（設備 ID の形・実在する日付・理由の長さ）はここで行い、権限・採択・反映は業務システムが行う。

/** この見本が前提にするアプリケーション ID（toolModules の application を省略したとき）。 */
export const application = 'equipment-inspection'

const EQUIPMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * @param {object} kit  bridge-tools がアプリケーションごとに渡すヘルパー（proposeTool / args / application / requestJson / text）
 * @returns {Array<object>} ツール（defineTool の結果）
 */
export default function equipmentInspectionTools(kit) {
  return [
    kit.proposeTool({
      name: 'facility_propose_reschedule',
      kind: 'inspection_reschedule',
      description: 'propose a new next-inspection date for one piece of equipment (equipmentId, dueOn YYYY-MM-DD, optional reason '
        + '<= 200 characters without personal names). A facility manager accepts or rejects it in the business web app.',
      parameters: {
        type: 'object',
        properties: {
          equipmentId: { type: 'string', description: 'Equipment ID (from facility_list_equipment / facility_list_overdue).' },
          dueOn: { type: 'string', description: 'Proposed next inspection date, YYYY-MM-DD.' },
          reason: { type: 'string', description: 'Optional short reason for the reviewer. No personal names.' },
        },
        required: ['equipmentId', 'dueOn'],
      },
      // 点検の結果・修理の承認はこのツールでは扱わない（モデルが送ってきたら理由付きで断る）
      forbidden: ['result', 'status', 'approve', 'inspectedOn'],
      forbiddenReason: 'this tool only proposes a new date; inspections are recorded and approved by people in the business web app',
      validate(input, tool) {
        const payload = {
          equipmentId: kit.args.string(tool, 'equipmentId', input.equipmentId, { required: true, max: 64, pattern: EQUIPMENT_ID_RE }),
          dueOn: kit.args.date(tool, 'dueOn', input.dueOn, { required: true }),
        }
        const reason = kit.args.string(tool, 'reason', input.reason, { max: 200 })
        if (reason !== undefined) payload.reason = reason
        return payload
      },
    }),
  ]
}
