// Ceremony scales with risk. A first guess at a request's tier from its words
// and, once drawn, the size of the change. Claude states the tier and the
// engineer can overrule it; the guess only decides what Claude suggests.

import type { Risk } from './changeset.ts'

const HIGH = [
  /\b(payment|charge|capture|refund|billing|invoice|money|price|pricing)\b/i,
  /\b(auth|login|password|token|session|permission|role|acl|oauth|secret)\b/i,
  /\b(migrat\w*|schema|drop|delete|purge|backfill)\b/i,
  /\b(checkout|order|inventory|stock)\b/i,
  /\b(queue|event|webhook|retry|idempoten\w*|transaction|outbox|cache)\b/i,
  /\b(concurren\w*|race|lock|timeout)\b/i,
]

const LOW = [
  /\b(typo|spelling|comment|docs?|readme|changelog|wording|copy text|lint|format(ting)?)\b/i,
  /\b(rename|bump|upgrade (a|the) dev ?dependency|log (line|message))\b/i,
  /\b(test name|snapshot)\b/i,
]

export function guessRisk(request: string, opCount = 0): { risk: Risk; why: string } {
  const high = HIGH.find(re => re.test(request))
  if (high || opCount >= 6) {
    return { risk: 'high', why: high ? `the request touches ${request.match(high)![0]}` : `${opCount} operations on the map` }
  }
  const low = LOW.find(re => re.test(request))
  if (low && opCount <= 1) return { risk: 'low', why: `looks like a ${request.match(low)![0]} change` }
  return { risk: 'medium', why: 'a code change with no obvious hot spot' }
}
