'use strict'

/**
 * Pushes log lines to Loki in batches, with the labels job="minecraft", client and level, like HMC-Prometheus.
 * Lines are queued, so logging never waits for Loki. If Loki is not reachable, the batch is retried with a backoff
 * and the oldest lines are dropped once the queue is full. Uses the JSON push API.
 */

const CAPACITY = 20000
const BATCH_SIZE = 1000
const MAX_BACKOFF_MS = 30000

class LokiPusher {
  constructor (baseUrl, client, warn = () => {}) {
    this.url = new URL(baseUrl.replace(/\/+$/, '') + '/loki/api/v1/push').toString()
    this.client = client
    this.warn = warn
    this.queue = []
    this.batch = []
    this.sent = 0
    this.dropped = 0
    this.failedPushes = 0
    this.sequence = 0
    this.running = true
    this.lastPushSucceeded = true
    this.lastError = null
    this.wake = null
    this.loop = this.run()
  }

  /**
   * Queues a line, never blocks.
   *
   * @param {number} timeMillis the time the line was logged at.
   * @param {string} level the log level, e.g. INFO.
   * @param {string} line may contain ANSI escape codes and line breaks.
   */
  add (timeMillis, level, line) {
    // Loki deduplicates lines with the same timestamp, the sequence keeps lines of the same millisecond apart and in order
    const nanos = BigInt(Math.floor(timeMillis)) * 1000000n + BigInt(this.sequence++ % 1000000)
    // Grafana does not understand the short form ESC[m
    this.queue.push({ nanos: nanos.toString(), level: level.toLowerCase(), line: line.replace(/\u001b\[m/g, '\u001b[0m') })
    while (this.queue.length > CAPACITY) {
      this.queue.shift()
      this.dropped++
    }
  }

  /** Pushes the queued lines now, instead of waiting up to a second for more lines. */
  flush () {
    if (this.wake) this.wake()
  }

  getQueued () {
    return this.queue.length + this.batch.length
  }

  /** Stops the pusher, trying to push the queued lines once more. */
  async close () {
    this.running = false
    this.flush()
    await Promise.race([this.loop, sleep(5000)])
  }

  async run () {
    let backoff = 1000
    while (this.running || this.batch.length > 0 || this.queue.length > 0) {
      if (this.batch.length === 0) {
        if (this.queue.length === 0) {
          await this.sleep(1000)
          continue
        }

        // collect what else arrives within a second, so that we push less often, unless a flush is requested
        if (this.running) await this.sleep(1000)
        this.batch = this.queue.splice(0, BATCH_SIZE)
      }

      if (await this.push(this.batch)) {
        this.batch = []
        backoff = 1000
      } else if (!this.running) {
        return // one last attempt on close
      } else {
        await this.sleep(backoff)
        backoff = Math.min(MAX_BACKOFF_MS, backoff * 2)
      }
    }
  }

  sleep (ms) {
    return new Promise(resolve => {
      const timer = setTimeout(done, ms)
      const self = this
      function done () {
        clearTimeout(timer)
        if (self.wake === done) self.wake = null
        resolve()
      }
      this.wake = done
    })
  }

  /** @returns {Promise<boolean>} true if the batch should not be retried. */
  async push (batch) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)
      let response
      try {
        response = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: this.toJson(batch),
          signal: controller.signal
        })
      } finally {
        clearTimeout(timeout)
      }

      if (response.ok) {
        this.sent += batch.length
        this.onResult(true, null)
        return true
      }

      const text = (await response.text().catch(() => '')).substring(0, 512).trim()
      this.onResult(false, `HTTP ${response.status}: ${text}`)
      // 4xx, e.g. lines that are too old, will not succeed if we retry, 429 and 5xx might
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        this.dropped += batch.length
        return true
      }

      return false
    } catch (e) {
      this.onResult(false, String(e && e.cause ? e.cause : e))
      return false
    }
  }

  onResult (success, error) {
    if (!success) {
      this.failedPushes++
      // only log when the state changes, a missing Loki should not spam the log, which we also push
      if (this.lastPushSucceeded) this.warn(`Failed to push logs to ${this.url}: ${error}`)
      this.lastError = error
    } else if (!this.lastPushSucceeded) {
      this.warn(`Pushing logs to ${this.url} again`)
    }

    this.lastPushSucceeded = success
  }

  toJson (batch) {
    const byLevel = new Map()
    for (const entry of batch) {
      if (!byLevel.has(entry.level)) byLevel.set(entry.level, [])
      byLevel.get(entry.level).push([entry.nanos, entry.line])
    }

    return JSON.stringify({
      streams: [...byLevel].map(([level, values]) => ({ stream: { job: 'minecraft', client: this.client, level }, values }))
    })
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms).unref())
}

module.exports = { LokiPusher }
