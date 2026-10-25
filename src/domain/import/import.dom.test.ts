// @vitest-environment jsdom
import { parseCSV, detectDelimiter, toCSV } from './csv'
import { readXlsx, XlsxError } from './xlsx'
import { ImportFileError, decodeText, sha256Hex, suggestMapping, summarize, tableFromCSVBytes, toTable, validateFileMeta, validateRows } from './pipeline'
import { cats, tx } from '@/domain/finance/testkit'

const asOf = '2026-03-15'
const enc = (s: string) => new TextEncoder().encode(s)

describe('CSV', () => {
  it('detecta ponto e vírgula e vírgula', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';')
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',')
    // vírgula decimal dentro de campo com ; como separador
    expect(detectDelimiter('data;valor\n01/03/2026;1.250,50\n02/03/2026;10,00\n')).toBe(';')
  })
  it('respeita aspas, aspas escapadas e quebras de linha', () => {
    const rows = parseCSV('a,b\n"x, y","diz ""oi""\nlinha 2"\n', ',')
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'diz "oi"\nlinha 2'],
    ])
  })
  it('remove BOM e ignora linhas vazias', () => {
    expect(parseCSV('﻿a;b\r\n\r\n1;2\r\n', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
  it('exportação neutraliza fórmulas', () => {
    const out = toCSV([['=HYPERLINK("x")', '+1', 'ok', 10]])
    expect(out).toContain(`"'=HYPERLINK(""x"")"`)
    expect(out).toContain("'+1")
    expect(out).toContain(';10')
  })
})

describe('codificação', () => {
  it('UTF-8 válido', () => {
    expect(decodeText(enc('Descrição')).encoding).toBe('UTF-8')
  })
  it('cai para Windows-1252 em arquivos do Excel brasileiro', () => {
    const latin = new Uint8Array([0x44, 0x65, 0x73, 0x63, 0x72, 0x69, 0xe7, 0xe3, 0x6f]) // "Descrição"
    const r = decodeText(latin)
    expect(r.encoding).toBe('Windows-1252')
    expect(r.text).toBe('Descrição')
  })
})

describe('validação do arquivo', () => {
  it('restringe extensão e tamanho', () => {
    expect(() => validateFileMeta('planilha.exe', 10)).toThrow(ImportFileError)
    expect(() => validateFileMeta('dados.csv', 0)).toThrow(/vazio/)
    expect(() => validateFileMeta('dados.csv', 6 * 1024 * 1024)).toThrow(/limite/)
    expect(() => validateFileMeta('Dados.XLSX', 1000)).not.toThrow()
  })
  it('rejeita binário disfarçado de CSV', () => {
    expect(() => tableFromCSVBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toThrow(/Excel/)
    expect(() => tableFromCSVBytes(new Uint8Array([0x61, 0, 0x62]))).toThrow(/binários/)
  })
  it('exige cabeçalho e dados', () => {
    expect(() => toTable([['a']])).toThrow(ImportFileError)
  })
  it('hash idêntico para o mesmo conteúdo', async () => {
    const a = await sha256Hex(enc('abc').buffer as ArrayBuffer)
    const b = await sha256Hex(enc('abc').buffer as ArrayBuffer)
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
  })
})

describe('mapeamento de colunas', () => {
  it('sugere campos por sinônimos com acentos e variações', () => {
    const m = suggestMapping(['Data', 'Histórico', 'Valor (R$)', 'Categoria', 'Situação', 'Vencimento', 'Fornecedor'])
    expect(m).toMatchObject({ date: 0, description: 1, amount: 2, category: 3, status: 4, dueDate: 5, counterparty: 6 })
  })
  it('não usa a mesma coluna duas vezes', () => {
    const m = suggestMapping(['Data pagamento', 'Valor'])
    const used = Object.values(m)
    expect(new Set(used).size).toBe(used.length)
  })
})

describe('validação das linhas', () => {
  const csv = [
    'Data;Descrição;Valor;Tipo;Categoria;Situação',
    '01/03/2026;Venda balcão;1.250,50;Receita;Vendas;Recebido',
    '02/03/2026;Energia;-480,00;;Energia;pago',
    '31/02/2026;Data ruim;100;Despesa;;',
    '03/03/2026;Valor ruim;abc;Despesa;;',
    '20/03/2026;Aluguel;4500;Despesa;Inexistente;pendente',
    '01/03/2026;Venda balcão;1.250,50;Receita;Vendas;Recebido',
    ';;;;;',
  ].join('\n')
  const table = tableFromCSVBytes(enc(csv))
  const mapping = suggestMapping(table.headers)
  const rows = validateRows(table, mapping, { categories: cats, existing: [], asOf })

  it('lê linhas válidas com valores e datas brasileiros', () => {
    expect(rows[0].tx).toMatchObject({ kind: 'income', amount: 125050, competenceDate: '2026-03-01', status: 'settled', categoryId: 'vendas' })
    expect(rows[1].tx).toMatchObject({ kind: 'expense', amount: 48000, settledDate: '2026-03-02', categoryId: 'energia' })
  })
  it('não descarta linhas inválidas silenciosamente', () => {
    expect(rows).toHaveLength(6) // linha totalmente vazia é ignorada pelo leitor
    expect(rows[2].errors[0]).toMatch(/inválida/)
    expect(rows[3].errors[0]).toMatch(/Valor inválido/)
    expect(rows[2].include).toBe(false)
  })
  it('avisa categoria inexistente sem criar', () => {
    expect(rows[4].tx?.categoryId).toBeNull()
    expect(rows[4].warnings.join()).toMatch(/não existe/)
    expect(rows[4].tx?.status).toBe('pending')
  })
  it('sinaliza linha repetida no mesmo arquivo, mas não decide pelo usuário', () => {
    expect(rows[5].warnings.join()).toMatch(/Igual à linha 2/)
    expect(rows[5].include).toBe(true)
  })
  it('reimportação: linhas já importadas ficam desmarcadas', () => {
    const existing = [tx({ kind: 'income', amount: 125050, competenceDate: '2026-03-01', sourceRef: rows[0].tx!.sourceRef })]
    const again = validateRows(table, mapping, { categories: cats, existing, asOf })
    expect(again[0].alreadyImported).toBe(true)
    expect(again[0].include).toBe(false)
  })
  it('mesmo valor e data de um lançamento manual é só suspeita', () => {
    const existing = [tx({ id: 'manual', kind: 'expense', amount: 48000, competenceDate: '2026-03-02' })]
    const again = validateRows(table, mapping, { categories: cats, existing, asOf })
    expect(again[1].possibleDuplicateOf).toBe('manual')
    expect(again[1].include).toBe(true)
  })
  it('resume sucessos, avisos e falhas', () => {
    const s = summarize(rows)
    expect(s).toMatchObject({ total: 6, valid: 4, withErrors: 2 })
  })
  it('rejeita liquidação no futuro', () => {
    const t = toTable([
      ['Data', 'Descrição', 'Valor', 'Pago em'],
      ['10/03/2026', 'x', '10', '20/04/2026'],
    ])
    const r = validateRows(t, suggestMapping(t.headers), { categories: cats, existing: [], asOf })
    expect(r[0].errors.join()).toMatch(/futuro/)
  })
})

// ZIP mínimo (sem compressão) para testar o leitor XLSX sem bibliotecas.
function makeZip(files: Record<string, string>): ArrayBuffer {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameB = enc(name)
    const data = enc(content)
    const local = new Uint8Array(30 + nameB.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameB.length, true)
    local.set(nameB, 30)
    const cd = new Uint8Array(46 + nameB.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameB.length, true)
    cv.setUint32(42, offset, true)
    cd.set(nameB, 46)
    parts.push(local, data)
    central.push(cd)
    offset += local.length + data.length
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const all = [...parts, ...central, eocd]
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of all) {
    out.set(p, o)
    o += p.length
  }
  return out.buffer
}

describe('XLSX', () => {
  it('lê textos compartilhados, números e seriais de data', async () => {
    const zip = makeZip({
      'xl/sharedStrings.xml':
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Data</t></si><si><t>Descrição</t></si><si><t>Valor</t></si><si><r><t>Venda </t></r><r><t>&amp; serviço</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2"><v>46027</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>1250.5</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>06/01/2026</t></is></c><c r="C3"><f>1+1</f><v>2</v></c></row>' +
        '</sheetData></worksheet>',
    })
    const rows = await readXlsx(zip)
    expect(rows[0]).toEqual(['Data', 'Descrição', 'Valor'])
    expect(rows[1]).toEqual([46027, 'Venda & serviço', 1250.5])
    expect(rows[2]).toEqual(['06/01/2026', null, 2]) // fórmula: só o valor em cache, nunca executada
    const table = toTable(rows)
    const r = validateRows(table, suggestMapping(table.headers), { categories: cats, existing: [], asOf })
    expect(r[0].tx).toMatchObject({ competenceDate: '2026-01-05', amount: 125050 })
    expect(r[1].errors.join()).toMatch(/Descrição vazia/)
  })
  it('rejeita arquivos que não são ZIP', async () => {
    await expect(readXlsx(enc('não é xlsx').buffer as ArrayBuffer)).rejects.toThrow(XlsxError)
  })
})
