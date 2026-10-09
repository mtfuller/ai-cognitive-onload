// withRetry: retry an async call a fixed number of times with a short
// backoff. Used by the outbox relay; nothing in checkout uses it yet.

export async function withRetry<T>(fn: () => Promise<T>, retries = 1, backoffMs = 50): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (attempt < retries) await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)))
    }
  }
  throw lastError
}
