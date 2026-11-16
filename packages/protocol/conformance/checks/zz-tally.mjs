// P5 / P6 run last and judge the WHOLE run.
import assert from 'node:assert/strict'

export function register(s) {
  s.check('P5', 'every response of this run (errors included) carried the header bridge-protocol: 1', async (c) => {
    const bad = c.target.protocolHeaderViolations
    assert.equal(bad.length, 0, `${bad.length} protocol responses without the bridge-protocol header, for example: ${bad.slice(0, 4).join(' | ')}`)
  })

  s.check('P6', 'every error code seen in this run is lower snake case ([a-z0-9_]+): codes are stable identifiers, not field names', async (c) => {
    const bad = [...c.target.errorCodes.entries()].filter(([code]) => !/^[a-z0-9_]+$/.test(code))
    assert.equal(bad.length, 0, `${bad.length} error code(s) are not lower snake case: ${bad.slice(0, 8).map(([code, where]) => `${code} (${where})`).join(' | ')}`)
    assert.ok(c.target.errorCodes.size >= 15, `the run saw only ${c.target.errorCodes.size} distinct error codes`)
  })
}
