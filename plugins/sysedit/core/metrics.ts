// The measures from the plan, computed from what the plugin already writes:
// change sets, the skip log and explain-back checks. Two halves: does it keep
// understanding intact, and does it keep people fast.

import type { ChangeSet } from './changeset.ts'

export type SkipEntry = { at: string; reason: string; change?: string; risk?: string }

export type ExplainBack = {
  at: string
  change?: string
  flow: string
  /** 0 to 1: the share of the flow's steps the engineer explained correctly without the tool. */
  score: number
  missed: string[]
}

export type Metrics = {
  changes: number
  byStatus: Record<string, number>
  /** Median minutes from a change's creation to its submission for review. */
  medianMinutesToSubmit: number | null
  /** Median minutes from submission to approval: time spent defending the change. */
  medianMinutesInReview: number | null
  blockingAsked: number
  /** Blocking questions whose answer changed the map, over all answered blocking questions. */
  grillHitRate: number | null
  /** Rated-useful questions over all rated questions. */
  usefulRate: number | null
  /** Changes whose verify found drift at least once, over changes verified. */
  driftCaughtRate: number | null
  skips: number
  /** Skips over all changes started plus skips. A high skip rate is a design problem. */
  skipRate: number | null
  explainBackMean: number | null
  explainBackCount: number
}

const minutes = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60000

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const ratio = (num: number, den: number) => (den === 0 ? null : num / den)

export function computeMetrics(changes: readonly ChangeSet[], skips: readonly SkipEntry[], explains: readonly ExplainBack[]): Metrics {
  const byStatus: Record<string, number> = {}
  const toSubmit: number[] = []
  const inReview: number[] = []
  let blockingAsked = 0
  let blockingAnswered = 0
  let changedMap = 0
  let rated = 0
  let useful = 0
  let verified = 0
  let drifted = 0

  for (const cs of changes) {
    byStatus[cs.status] = (byStatus[cs.status] ?? 0) + 1
    const at = (event: string) => cs.history.find(h => h.event === event)?.at
    const submitted = at('submitted')
    const approved = at('approved')
    if (submitted) toSubmit.push(minutes(cs.createdAt, submitted))
    if (submitted && approved) inReview.push(minutes(submitted, approved))
    for (const q of cs.questions) {
      if (q.severity === 'blocking') {
        blockingAsked += 1
        if (q.status === 'answered') {
          blockingAnswered += 1
          if (q.answer?.changedMap) changedMap += 1
        }
      }
      if (q.rating) {
        rated += 1
        if (q.rating === 'useful') useful += 1
      }
    }
    const verifiedOnce = cs.history.some(h => h.event === 'verified')
    const driftOnce = cs.history.some(h => h.event === 'drift')
    if (verifiedOnce || driftOnce) {
      verified += 1
      if (driftOnce) drifted += 1
    }
  }

  const skippedChanges = changes.filter(c => c.status === 'skipped').length
  const looseSkips = skips.filter(s => !s.change || !changes.some(c => c.id === s.change)).length
  const totalSkips = skippedChanges + looseSkips

  return {
    changes: changes.length,
    byStatus,
    medianMinutesToSubmit: median(toSubmit),
    medianMinutesInReview: median(inReview),
    blockingAsked,
    grillHitRate: ratio(changedMap, blockingAnswered),
    usefulRate: ratio(useful, rated),
    driftCaughtRate: ratio(drifted, verified),
    skips: totalSkips,
    skipRate: ratio(totalSkips, changes.length + looseSkips),
    explainBackMean: explains.length === 0 ? null : explains.reduce((a, e) => a + e.score, 0) / explains.length,
    explainBackCount: explains.length,
  }
}

export function formatMetrics(m: Metrics): string {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)
  const mins = (x: number | null) => (x === null ? '—' : `${x.toFixed(1)} min`)
  return [
    `Changes: ${m.changes} (${Object.entries(m.byStatus).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
    `Time to submit a drawn change (median): ${mins(m.medianMinutesToSubmit)}`,
    `Time defending it in review (median): ${mins(m.medianMinutesInReview)}`,
    `Grill hit rate (blocking answers that changed the map): ${pct(m.grillHitRate)} of ${m.blockingAsked} blocking asked`,
    `Questions rated useful: ${pct(m.usefulRate)}`,
    `Drift caught before merge: ${pct(m.driftCaughtRate)}`,
    `Skips: ${m.skips} (skip rate ${pct(m.skipRate)})`,
    `Explain-back mean score: ${pct(m.explainBackMean)} over ${m.explainBackCount} check(s)`,
  ].join('\n')
}
