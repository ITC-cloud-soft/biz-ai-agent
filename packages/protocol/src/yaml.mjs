// A small YAML-subset parser (zero dependencies) for Bridge manifests and the OpenAPI document.
//
// Supported:  block mappings / sequences (any nesting, "- key: v" compact maps), flow [..] / {..} (may span lines),
//             plain / 'single' / "double" quoted scalars, | and > block scalars (with - + chomping and indent hints),
//             # comments, a leading "---".
// Scalars:    null ~ true false, integers, floats; EVERYTHING else is a string (so 2026-10-26 and 08:30 stay strings).
// Rejected:   tabs as indentation, anchors / aliases / tags, multi-document streams, duplicate keys, multi-line
//             plain / quoted scalars (use | or >), complex keys.
// A manifest may also be written as JSON: parseDocument() picks the parser from the file name / first character.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message)
    this.name = 'YamlError'
    this.line = line ?? null
  }
}

/** Strips a trailing comment ("#" at the start or after whitespace, outside quotes). */
function stripComment(s) {
  let quote = null
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (quote) {
      if (quote === '"' && c === '\\') i += 1
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i += 1
        else quote = null
      }
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) quote = c
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}

function unescapeDouble(body, line) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) => {
    if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16))
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16))
    const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', 0: '\0', ' ': ' ' }
    if (e in map) return map[e]
    throw new YamlError(`unsupported escape \\${e}`, line)
  })
}

const NUMBER_RE = /^[-+]?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/

function resolvePlain(text, line) {
  if (text === '' || text === '~' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (NUMBER_RE.test(text)) return Number(text)
  if (/^(&|\*|!)[\w!-]/.test(text)) throw new YamlError(`anchors, aliases and tags are not supported: ${text.slice(0, 20)}`, line)
  return text
}

// ---------------------------------------------------------------- flow collections
function parseFlow(src, line) {
  let i = 0
  const fail = (msg) => { throw new YamlError(`${msg} in flow collection: ${src.slice(0, 60)}`, line) }
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i += 1 }
  function quoted() {
    const q = src[i]
    i += 1
    let out = ''
    for (; i < src.length; i += 1) {
      const c = src[i]
      if (q === '"' && c === '\\') { out += c + src[i + 1]; i += 1 } else if (c === q) {
        if (q === "'" && src[i + 1] === "'") { out += "'"; i += 1 } else { i += 1; return q === '"' ? unescapeDouble(out, line) : out }
      } else out += c
    }
    return fail('unterminated quote')
  }
  function value(inMap) {
    ws()
    if (src[i] === '[') return seq()
    if (src[i] === '{') return map()
    if (src[i] === '"' || src[i] === "'") return quoted()
    const start = i
    while (i < src.length && !(src[i] === ',' || src[i] === ']' || src[i] === '}' || (inMap && src[i] === ':' && /\s|$/.test(src[i + 1] ?? ' ')))) i += 1
    return resolvePlain(src.slice(start, i).trim(), line)
  }
  function seq() {
    i += 1
    const out = []
    ws()
    if (src[i] === ']') { i += 1; return out }
    for (;;) {
      out.push(value(false))
      ws()
      if (src[i] === ',') { i += 1; ws(); if (src[i] === ']') { i += 1; return out } continue }
      if (src[i] === ']') { i += 1; return out }
      return fail('expected , or ]')
    }
  }
  function map() {
    i += 1
    const out = {}
    ws()
    if (src[i] === '}') { i += 1; return out }
    for (;;) {
      ws()
      const key = (src[i] === '"' || src[i] === "'") ? quoted() : (() => {
        const start = i
        while (i < src.length && !(src[i] === ':' && /\s|$/.test(src[i + 1] ?? ' ')) && src[i] !== ',' && src[i] !== '}') i += 1
        return src.slice(start, i).trim()
      })()
      ws()
      let v = null
      if (src[i] === ':') { i += 1; v = value(true) }
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(`duplicate key ${key}`)
      out[key] = v
      ws()
      if (src[i] === ',') { i += 1; ws(); if (src[i] === '}') { i += 1; return out } continue }
      if (src[i] === '}') { i += 1; return out }
      return fail('expected , or }')
    }
  }
  const result = value(false)
  ws()
  if (i < src.length) fail('trailing characters')
  return result
}

const bracketDepth = (s) => {
  let depth = 0
  let quote = null
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (quote) {
      if (quote === '"' && c === '\\') i += 1
      else if (c === quote) quote = null
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) quote = c
    else if (c === '[' || c === '{') depth += 1
    else if (c === ']' || c === '}') depth -= 1
  }
  return depth
}

// ---------------------------------------------------------------- block structure
function scalarValue(text, line) {
  const t = text.trim()
  if (t[0] === '"' || t[0] === "'") {
    const q = t[0]
    let out = ''
    let i = 1
    for (; i < t.length; i += 1) {
      const c = t[i]
      if (q === '"' && c === '\\') { out += c + t[i + 1]; i += 1 } else if (c === q) {
        if (q === "'" && t[i + 1] === "'") { out += "'"; i += 1 } else break
      } else out += c
    }
    if (i >= t.length) throw new YamlError('unterminated quoted scalar (multi-line quoted scalars are not supported; use | or >)', line)
    if (t.slice(i + 1).trim()) throw new YamlError(`unexpected text after quoted scalar: ${t.slice(i + 1, i + 20)}`, line)
    return q === '"' ? unescapeDouble(out, line) : out
  }
  if (t[0] === '[' || t[0] === '{') return parseFlow(t, line)
  return resolvePlain(t, line)
}

/** Position of the ":" that ends a mapping key (outside quotes, followed by whitespace or the end), or -1. */
function keyColon(s) {
  let quote = null
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (quote) {
      if (quote === '"' && c === '\\') i += 1
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i += 1
        else quote = null
      }
    } else if ((c === '"' || c === "'") && i === 0) quote = c
    else if (c === ':' && (i + 1 === s.length || s[i + 1] === ' ')) return i
    else if ((c === '[' || c === '{') && i === 0) return -1
  }
  return -1
}

function keyOf(raw, line) {
  const k = raw.trim()
  if (k[0] === '"' || k[0] === "'") return String(scalarValue(k, line))
  if (/^(&|\*|!)[\w!-]/.test(k)) throw new YamlError(`anchors, aliases and tags are not supported: ${k}`, line)
  return k
}

export function parseYaml(source) {
  const text = String(source).replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n').map((raw, idx) => {
    if (/^\t/.test(raw) || /^ *\t/.test(raw)) throw new YamlError('tabs are not allowed for indentation', idx + 1)
    const content = stripComment(raw)
    const trimmed = content.trim()
    return { raw, n: idx + 1, indent: raw.length - raw.trimStart().length, text: trimmed, blank: trimmed === '' }
  })
  let pos = 0
  const skipBlank = () => { while (pos < lines.length && lines[pos].blank) pos += 1 }
  skipBlank()
  if (lines[pos]?.text === '---') { pos += 1; skipBlank() }
  if (pos >= lines.length) return null

  /** Collects a | or > block scalar whose parent sits at `parentIndent`. */
  function blockScalar(header, parentIndent, line) {
    const m = /^([|>])([-+]?)([1-9]?)([-+]?)$/.exec(header)
    if (!m) throw new YamlError(`bad block scalar header: ${header}`, line)
    const style = m[1]
    const chomp = m[2] || m[4]
    const body = []
    let blockIndent = m[3] ? parentIndent + Number(m[3]) : null
    while (pos < lines.length) {
      const l = lines[pos]
      if (l.raw.trim() === '') { body.push({ blank: true }); pos += 1; continue }
      if (blockIndent === null) {
        if (l.indent <= parentIndent) break
        blockIndent = l.indent
      }
      if (l.indent < blockIndent) break
      body.push({ blank: false, text: l.raw.slice(blockIndent) })
      pos += 1
    }
    let trailing = 0 // blank lines after the content (kept by "+")
    while (body.length && body[body.length - 1].blank) { body.pop(); trailing += 1 }
    let out
    if (style === '|') out = body.map((b) => (b.blank ? '' : b.text)).join('\n')
    else {
      out = ''
      let prevBlank = false
      body.forEach((b, idx) => {
        if (b.blank) { out += '\n'; prevBlank = true } else {
          if (idx > 0 && !prevBlank) out += ' '
          out += b.text
          prevBlank = false
        }
      })
    }
    if (chomp === '-') return out
    if (chomp === '+') return `${out}\n${'\n'.repeat(trailing)}`
    return body.length ? `${out}\n` : ''
  }

  /** Inline value after "key:" or "- ": handles flow spanning lines, block scalars, plain / quoted scalars. */
  function inlineValue(rest, parentIndent, line) {
    const r = rest.trim()
    if (r[0] === '|' || r[0] === '>') return blockScalar(r, parentIndent, line)
    let flow = r
    if ((r[0] === '[' || r[0] === '{') && bracketDepth(r) > 0) {
      while (bracketDepth(flow) > 0) {
        if (pos >= lines.length) throw new YamlError('unterminated flow collection', line)
        flow += ` ${lines[pos].text}`
        pos += 1
      }
    }
    return scalarValue(flow, line)
  }

  function parseNode(minIndent) {
    skipBlank()
    const l = lines[pos]
    if (!l || l.indent < minIndent) return null
    if (l.text === '-' || l.text.startsWith('- ')) return parseSeq(l.indent)
    if (keyColon(l.text) >= 0) return parseMap(l.indent)
    pos += 1
    return inlineValue(l.text, l.indent - 1, l.n)
  }

  function parseSeq(indent) {
    const out = []
    for (;;) {
      skipBlank()
      const l = lines[pos]
      if (!l || l.indent !== indent || !(l.text === '-' || l.text.startsWith('- '))) {
        if (l && l.indent > indent) throw new YamlError('bad indentation in sequence', l.n)
        return out
      }
      const rest = l.text === '-' ? '' : l.text.slice(2)
      if (rest.trim() === '') {
        pos += 1
        out.push(parseNode(indent + 1))
        continue
      }
      const offset = l.raw.indexOf(rest, indent + 1)
      if (rest === '-' || rest.startsWith('- ') || keyColon(rest) >= 0) {
        // compact nested collection: re-read the remainder of this line as its own line
        lines[pos] = { ...l, raw: `${' '.repeat(offset)}${rest}`, indent: offset, text: rest }
        out.push(parseNode(offset))
      } else {
        pos += 1
        out.push(inlineValue(rest, indent, l.n))
      }
    }
  }

  function parseMap(indent) {
    const out = {}
    for (;;) {
      skipBlank()
      const l = lines[pos]
      if (!l || l.indent !== indent || l.text === '-' || l.text.startsWith('- ')) {
        if (l && l.indent > indent) throw new YamlError('bad indentation in mapping', l.n)
        return out
      }
      const c = keyColon(l.text)
      if (c < 0) throw new YamlError(`expected "key: value": ${l.text.slice(0, 40)}`, l.n)
      const key = keyOf(l.text.slice(0, c), l.n)
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key "${key}"`, l.n)
      const rest = l.text.slice(c + 1).trim()
      pos += 1
      if (rest === '') {
        skipBlank()
        const next = lines[pos]
        if (next && next.indent > indent) out[key] = parseNode(indent + 1)
        else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) out[key] = parseSeq(indent)
        else out[key] = null
      } else out[key] = inlineValue(rest, indent, l.n)
    }
  }

  const result = parseNode(0)
  skipBlank()
  if (pos < lines.length) throw new YamlError(`unexpected content: ${lines[pos].text.slice(0, 40)}`, lines[pos].n)
  return result
}

/** JSON when the name ends in .json (or the text starts with { / [ and parses as JSON), otherwise YAML. */
export function parseDocument(source, name = '') {
  const s = String(source).replace(/^﻿/, '')
  if (/\.json$/i.test(name)) return JSON.parse(s)
  if (/^\s*[{[]/.test(s) && !/\.ya?ml$/i.test(name)) {
    try { return JSON.parse(s) } catch { /* fall through to YAML (flow style) */ }
  }
  return parseYaml(s)
}
