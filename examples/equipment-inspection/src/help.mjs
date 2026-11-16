// How-to questions on SNS answered from this system's manual (manual/*.md) with @dsh-bridge/help — the minimal integration:
// the index is built at start from the manual and this system's screens (one page: `/`, every role), the public sections are the
// sign-in and SNS linking (answered to a sender that is not linked yet), and the answers' links use the page's own URL.
import { fileURLToPath } from 'node:url'
import { buildHelpIndex, createHelpService, parseManual, readManualDir } from '@dsh-bridge/help'

export const MANUAL_DIR = fileURLToPath(new URL('../manual/', import.meta.url))
export const ROLES = Object.freeze(['admin', 'manager', 'inspector'])
export const ROLE_LABELS = Object.freeze({ admin: '施設管理者', manager: '設備責任者', inspector: '点検員' })
/** This system's screens and who may open them (the business system knows its own guards). */
export const SCREENS = Object.freeze([{ path: '/', roles: [...ROLES] }])

export function helpIndex(dir = MANUAL_DIR) {
  const { files, synonyms } = readManualDir(dir)
  return buildHelpIndex({ chapters: parseManual(files), routes: SCREENS, roles: [...ROLES], publicSections: ['manual-basics-*'], synonyms })
}

/** The server-kit `help` option. webBase: this system's URL (the answers' links). The page has no manual page of its own (manualPage ''). */
export function createHelp({ webBase = '' } = {}) {
  return createHelpService(helpIndex(), { webBase, roleLabels: ROLE_LABELS, manualPage: '' })
}
