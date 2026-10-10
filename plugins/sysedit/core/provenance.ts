// Whose words are these? Answers, approvals and skips are the engineer's to
// give. Claude records them with a `quote` of what the engineer said, and the
// mod checks that quote against what the engineer actually typed this session,
// so "answer them yourself" can't become an answer, and a paraphrase Claude
// invented can't become an approval.

export type QuoteCheck = { ok: true } | { ok: false; reason: string }

/** Lower-case, straight quotes, single spaces: so a quote survives copy and paste. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The engineer handing a decision back to Claude. Not an answer. */
const DELEGATION = [
  /\b(answer|decide|pick|choose|do) (them|it|those|these|this|that)? ?(for me|yourself|on your own)\b/,
  /\byourself\b/,
  /\b(whatever|however) you (think|want|like|prefer|see fit)\b/,
  /\b(up to you|your call|you decide|you choose|you pick|dealer'?s choice|use your (best )?judg(e)?ment)\b/,
  /\bi don'?t (care|mind)\b/,
]

const APPROVAL = /\b(approve[ds]?|approval|go ahead|lgtm|looks good|ship it|sign(ed)? off|green ?light|build it|yes,? (approve|build|go))\b/

export function isDelegation(text: string): boolean {
  const t = normalise(text)
  return DELEGATION.some(re => re.test(t))
}

/** The engineer's own words, from what they typed this session. */
export function checkQuote(quote: unknown, engineerSaid: readonly string[]): QuoteCheck {
  if (typeof quote !== 'string' || normalise(quote).length < 2) {
    return { ok: false, reason: "Quote the engineer's own words for this, verbatim, in `quote`. If they haven't said it, ask them." }
  }
  const q = normalise(quote)
  if (!engineerSaid.some(said => normalise(said).includes(q))) {
    return {
      ok: false,
      reason: `"${quote.slice(0, 120)}" isn't something the engineer said in this session. Record only their own words; if they haven't answered, ask them.`,
    }
  }
  if (isDelegation(quote)) {
    return {
      ok: false,
      reason:
        "That quote hands the decision to Claude, and only the engineer decides. Make it quick for them instead: give each open question in a line with lettered options so they can reply like \"q2 b, q3 a\", or tell them /sysedit:skip <reason> bypasses the process (it's logged).",
    }
  }
  return { ok: true }
}

/** An approval must be the engineer saying, in this session, to approve. */
export function checkApproval(quote: unknown, engineerSaid: readonly string[]): QuoteCheck {
  const base = checkQuote(quote, engineerSaid)
  if (!base.ok) return base
  const q = normalise(String(quote))
  if (!APPROVAL.test(q) && !/^(yes|yep|yeah|ok|okay|sure|do it|go)\b/.test(q)) {
    return { ok: false, reason: `"${String(quote).slice(0, 120)}" doesn't approve the change. Ask the engineer whether to approve it.` }
  }
  return { ok: true }
}
