/**
 * Leitor XLSX mínimo, sem bibliotecas: lê o ZIP com DecompressionStream nativo do navegador
 * e interpreta o XML da primeira planilha com DOMParser. Nada do arquivo é executado:
 * fórmulas são lidas pelo valor em cache, macros e objetos são ignorados.
 *
 * Limitações documentadas: lê só a primeira planilha; datas chegam como número serial
 * (convertidas no mapeamento); arquivos criptografados ou .xls antigos não são suportados.
 */

const MAX_UNCOMPRESSED = 40 * 1024 * 1024

export class XlsxError extends Error {}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  offset: number
}

function readEntries(buf: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new XlsxError('Arquivo XLSX inválido ou corrompido')
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  const entries = new Map<string, ZipEntry>()
  const dec = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || view.getUint32(p, true) !== 0x02014b50) throw new XlsxError('Estrutura ZIP inválida')
    const flags = view.getUint16(p + 8, true)
    if (flags & 0x1) throw new XlsxError('Planilhas protegidas por senha não são suportadas')
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const offset = view.getUint32(p + 42, true)
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen))
    entries.set(name, { name, method, compressedSize, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function readEntry(buf: Uint8Array, e: ZipEntry): Promise<string> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(e.offset, true) !== 0x04034b50) throw new XlsxError('Estrutura ZIP inválida')
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true)
  const raw = buf.subarray(start, start + e.compressedSize)
  if (e.method === 0) return new TextDecoder().decode(raw)
  if (e.method !== 8) throw new XlsxError('Compressão do arquivo não suportada')
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    // Proteção contra "zip bomb".
    if (total > MAX_UNCOMPRESSED) {
      await reader.cancel()
      throw new XlsxError('Conteúdo descompactado excede o limite permitido')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return new TextDecoder().decode(out)
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new XlsxError('XML interno da planilha inválido')
  return doc
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function textOf(el: Element): string {
  // <si> pode conter vários <r><t>…</t></r> (texto com formatação).
  const ts = el.getElementsByTagName('t')
  let s = ''
  for (let i = 0; i < ts.length; i++) s += ts[i].textContent ?? ''
  return s
}

export type Cell = string | number | null

export async function readXlsx(data: ArrayBuffer, maxRows = 10_000): Promise<Cell[][]> {
  const buf = new Uint8Array(data)
  const entries = readEntries(buf)

  let sheetPath = 'xl/worksheets/sheet1.xml'
  const wb = entries.get('xl/workbook.xml')
  const rels = entries.get('xl/_rels/workbook.xml.rels')
  if (wb && rels) {
    const wbDoc = parseXml(await readEntry(buf, wb))
    const first = wbDoc.getElementsByTagName('sheet')[0]
    const rid = first?.getAttribute('r:id') ?? first?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    if (rid) {
      const relDoc = parseXml(await readEntry(buf, rels))
      const relEls = relDoc.getElementsByTagName('Relationship')
      for (let i = 0; i < relEls.length; i++) {
        if (relEls[i].getAttribute('Id') === rid) {
          const target = relEls[i].getAttribute('Target') ?? ''
          sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
        }
      }
    }
  }
  const sheet = entries.get(sheetPath) ?? [...entries.values()].find((e) => /^xl\/worksheets\/[^/]+\.xml$/.test(e.name))
  if (!sheet) throw new XlsxError('Nenhuma planilha encontrada no arquivo')

  const shared: string[] = []
  const ss = entries.get('xl/sharedStrings.xml')
  if (ss) {
    const doc = parseXml(await readEntry(buf, ss))
    const sis = doc.getElementsByTagName('si')
    for (let i = 0; i < sis.length; i++) shared.push(textOf(sis[i]))
  }

  const doc = parseXml(await readEntry(buf, sheet))
  const rowEls = doc.getElementsByTagName('row')
  if (rowEls.length > maxRows + 1) throw new XlsxError(`A planilha tem mais de ${maxRows} linhas`)
  const rows: Cell[][] = []
  for (let r = 0; r < rowEls.length; r++) {
    const cells = rowEls[r].getElementsByTagName('c')
    const row: Cell[] = []
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]
      const idx = cell.getAttribute('r') ? colIndex(cell.getAttribute('r')!) : c
      if (idx > 200) continue
      const t = cell.getAttribute('t')
      const v = cell.getElementsByTagName('v')[0]?.textContent ?? null
      let value: Cell = null
      if (t === 's') value = v != null ? (shared[Number(v)] ?? null) : null
      else if (t === 'inlineStr') value = textOf(cell)
      else if (t === 'str' || t === 'e') value = v
      else if (t === 'b') value = v === '1' ? 'VERDADEIRO' : 'FALSO'
      else value = v != null && v !== '' ? Number(v) : null
      while (row.length < idx) row.push(null)
      row[idx] = value
    }
    if (row.some((v) => v !== null && String(v).trim() !== '')) rows.push(row)
  }
  return rows
}
