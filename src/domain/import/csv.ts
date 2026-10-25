/**
 * Leitor CSV (RFC 4180) sem dependências: aspas, aspas escapadas, quebras de linha dentro de campos,
 * separadores vírgula, ponto e vírgula ou tabulação (detectados automaticamente).
 */
export type Delimiter = ',' | ';' | '\t'

export function detectDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 20_000)
  const candidates: Delimiter[] = [';', ',', '\t']
  let best: Delimiter = ','
  let bestScore = -1
  for (const d of candidates) {
    const counts: number[] = []
    let inQuotes = false
    let count = 0
    for (let i = 0; i < sample.length && counts.length < 20; i++) {
      const ch = sample[i]
      if (ch === '"') inQuotes = !inQuotes
      else if (!inQuotes && ch === d) count++
      else if (!inQuotes && ch === '\n') {
        counts.push(count)
        count = 0
      }
    }
    if (count) counts.push(count)
    const nonEmpty = counts.filter((c) => c > 0)
    if (!nonEmpty.length) continue
    // Pontuação: consistência entre linhas × quantidade de colunas.
    const mode = nonEmpty.sort((a, b) => a - b)[Math.floor(nonEmpty.length / 2)]
    const consistent = counts.filter((c) => c === mode).length
    const score = consistent * 10 + mode
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

export function parseCSV(text: string, delimiter: Delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') inQuotes = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Escapa células para exportação, neutralizando injeção de fórmulas (=, +, -, @) em planilhas. */
export function toCSV(rows: (string | number | null | undefined)[][], delimiter: Delimiter = ';'): string {
  const esc = (v: string | number | null | undefined) => {
    let s = v == null ? '' : String(v)
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
    if (s.includes('"') || s.includes(delimiter) || /[\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
    return s
  }
  // BOM para o Excel abrir acentos corretamente.
  return '﻿' + rows.map((r) => r.map(esc).join(delimiter)).join('\r\n')
}
