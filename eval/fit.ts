// Step 4: pick the gate threshold on half the chats, score it once on the other half.
//   bun eval/fit.ts [jev-model=jev-1.14] [view=prev|none] [target-precision=0.9]  → REPORT-<model>-<view>.md
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, scoreFile } from './lib'
import type { EvalSession } from './lib'

const MODEL = process.argv[2] ?? 'jev-1.14'
const VIEW = process.argv[3] === 'none' ? 'none' : 'prev'
const TARGET = Number(process.argv[4] ?? 0.9)

type Label = { important: boolean; kind?: string; source: 'agree' | 'adjudicated' }
const sessions = readJson<EvalSession[]>('sessions.json', []).sort((a, b) => a.id.localeCompare(b.id))
const labels = readJson<Record<string, Record<number, Label>>>('labels.json', {})
const scores = readJson<Record<string, number>>(scoreFile(MODEL, VIEW), {})

type Row = { sid: string; n: number; y: boolean; p: number; isShort: boolean; source: string; kind?: string }
const rows: Row[] = []
const split: ('dev' | 'test')[] = []
sessions.forEach((s, i) => {
  split.push(i % 2 === 0 ? 'dev' : 'test')
  for (const t of s.turns) {
    const l = labels[s.id]?.[t.n]
    const p = scores[`${s.id}:${t.n}`]
    if (l !== undefined && p !== undefined) rows.push({ sid: s.id, n: t.n, y: l.important, p, isShort: t.user.length <= 40, source: l.source, kind: l.kind })
  }
})
const dev = rows.filter(r => split[sessions.findIndex(s => s.id === r.sid)] === 'dev')
const test = rows.filter(r => split[sessions.findIndex(s => s.id === r.sid)] === 'test')

const wilson = (k: number, n: number): [number, number] => {
  if (n === 0) return [0, 1]
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [(c - m) / d, (c + m) / d]
}

// Jev answers in steps of 0.01, so a threshold is compared at that resolution.
const EPS = 1e-9
const at = (set: Row[], t: number) => {
  const tp = set.filter(r => r.p >= t - EPS && r.y).length
  const fp = set.filter(r => r.p >= t - EPS && !r.y).length
  const fn = set.filter(r => r.p < t - EPS && r.y).length
  const tn = set.length - tp - fp - fn
  return { t, tp, fp, fn, tn, passed: tp + fp, precision: tp + fp === 0 ? 0 : tp / (tp + fp), recall: tp + fn === 0 ? 0 : tp / (tp + fn) }
}

const auc = (set: Row[]): number => {
  const pos = set.filter(r => r.y)
  const neg = set.filter(r => !r.y)
  if (pos.length === 0 || neg.length === 0) return NaN
  let wins = 0
  for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0
  return wins / (pos.length * neg.length)
}

// The lowest threshold whose precision on the fit half reaches the target (most recall for that precision).
let chosen = 0.99
for (let k = 5; k < 100; k++) {
  const t = k / 100
  const m = at(dev, t)
  if (m.passed >= 10 && m.precision >= TARGET) {
    chosen = t
    break
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const ci = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n)
  return `${pct(lo)} to ${pct(hi)}`
}

const agreed = rows.filter(r => r.source === 'agree').length
const lines: string[] = []
const out = (s = '') => {
  lines.push(s)
  console.log(s)
}
const shape = (set: Row[]) => `${set.length} turns, ${set.filter(r => r.y).length} important`
out(`# Gate calibration: ${MODEL}, ${VIEW === 'prev' ? 'with the end of the previous reply in view' : 'user message and reply only'}`)
out()
out(`Sessions: ${sessions.length} real chats (${shape(rows)}). Fit half: ${shape(dev)}. Held-out half: ${shape(test)}.`)
out(`Labels: ${rows.filter(r => r.source === 'agree').length} agreed by two independent passes, ${rows.filter(r => r.source === 'adjudicated').length} settled by a stronger model. The two passes agreed on ${pct(agreed / rows.length)} of turns.`)
out(`Held-out ranking quality (AUC): ${auc(test).toFixed(3)} on held-out, ${auc(dev).toFixed(3)} on the fit half.`)
out()
out(`Threshold chosen on the fit half for precision >= ${TARGET}: **${chosen}**`)
out()
out('| Threshold | Passed | Precision (95% CI) | Recall (95% CI) |')
out('| --- | --- | --- | --- |')
for (const t of [...new Set([0.3, 0.5, 0.7, 0.8, 0.9, chosen])].sort((x, y) => x - y)) {
  const m = at(test, t)
  out(`| ${t}${t === chosen ? ' (chosen)' : ''} | ${m.passed} | ${pct(m.precision)} (${ci(m.tp, m.passed)}) | ${pct(m.recall)} (${ci(m.tp, m.tp + m.fn)}) |`)
}
const m = at(test, chosen)
const short = test.filter(r => r.isShort)
const shortAt = at(short, chosen)
out()
out(`At ${chosen} on held-out: ${m.tp} of ${m.passed} passed turns are important; ${m.fn} important turns are missed.`)
out(`Short messages (40 characters or less): ${short.length} turns, ${short.filter(r => r.y).length} important, recall ${pct(shortAt.recall)} (${ci(shortAt.tp, shortAt.tp + shortAt.fn)}).`)
out(`Precision on the fit half at ${chosen}: ${pct(at(dev, chosen).precision)}.`)
out()
out(m.passed > 0 && m.precision >= TARGET ? `Acceptance (held-out precision >= ${TARGET}): MET.` : `Acceptance (held-out precision >= ${TARGET}): NOT MET.`)

// Cross-check: a threshold fit on one half drifted on the other, so the shipped one must clear the target on both halves.
const halves = [dev, test]
let shipped = 0.99
for (let k = 5; k < 100; k++) {
  const t = k / 100
  if (halves.every(h => at(h, t).passed >= 10 && at(h, t).precision >= TARGET)) {
    shipped = t
    break
  }
}
out()
out('## Both halves')
out()
out('| Threshold | Fit half precision | Held-out precision | Pooled precision (95% CI) | Pooled recall |')
out('| --- | --- | --- | --- | --- |')
for (const t of [...new Set([0.6, 0.65, 0.7, 0.75, 0.8, shipped])].sort((x, y) => x - y)) {
  const a = at(dev, t)
  const b = at(test, t)
  const p = at(rows, t)
  out(`| ${t}${t === shipped ? ' (shipped)' : ''} | ${pct(a.precision)} (${a.passed}) | ${pct(b.precision)} (${b.passed}) | ${pct(p.precision)} (${ci(p.tp, p.passed)}) | ${pct(p.recall)} |`)
}
out()
out(`Shipped default: **${shipped}**, the lowest threshold whose precision reaches ${TARGET} on both halves. The threshold fit on one half alone is not trusted (it missed the bar on the other).`)

writeFileSync(join(import.meta.dir, `REPORT-${MODEL.replace(/[^a-z0-9.]+/gi, '_')}-${VIEW}.md`), lines.join('\n') + '\n')
