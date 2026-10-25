// Optional maintenance command only: refresh the OFL CJK subset used by the
// isolated Chrome fixture. Tests themselves never make a font/network request.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = new URL('../../', import.meta.url)
const files = []
const collect = async directory => {
  const { readdir } = await import('node:fs/promises')
  for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) await collect(path)
    else if (/\.(ts|tsx|mjs|jsx)$/.test(entry.name)) files.push(path)
  }
}
// Derive the glyph set from the live sources instead of a hand-maintained list:
// deleted or renamed UI files must not break this maintenance command.
await collect('src')
await collect('test/browser')
const input = (await Promise.all(files.map(path => readFile(new URL(path, root), 'utf8')))).join('')
const text = [...new Set(input.match(/[\u3400-\u9fff]/gu))].sort().join('')
const cssUrl = `https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400&text=${encodeURIComponent(text)}`
const css = await fetch(cssUrl).then(response => { if (!response.ok) throw new Error(`Font CSS HTTP ${response.status}`); return response.text() })
const match = css.match(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[\w\W]*?)\) format\('(truetype|woff2)'\)/)
if (!match || match[2] !== 'truetype') throw new Error('Unexpected upstream subset format; do not silently replace the test asset')
const fontUrl = match[1]
const font = Buffer.from(await fetch(fontUrl).then(response => { if (!response.ok) throw new Error(`Font HTTP ${response.status}`); return response.arrayBuffer() }))
const licenseUrl = 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt'
const license = await fetch(licenseUrl).then(response => { if (!response.ok) throw new Error(`License HTTP ${response.status}`); return response.text() })
const directory = new URL('test/browser/fonts/', root)
await mkdir(directory, { recursive: true })
await writeFile(new URL('noto-sans-sc-subset.ttf', directory), font)
await writeFile(new URL('OFL.txt', directory), license.replace(/[ \t]+$/gm, ''))
await writeFile(new URL('source.json', directory), `${JSON.stringify({ family: 'Noto Sans SC', weight: 400, glyphCount: text.length, sha256: createHash('sha256').update(font).digest('hex'), cssUrl, fontUrl, licenseUrl }, null, 2)}\n`)
console.log(`Saved ${font.length} font bytes covering ${text.length} CJK characters to ${fileURLToPath(directory)}`)
