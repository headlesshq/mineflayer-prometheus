'use strict'

/**
 * Ports of the trackers of HMC-Specifics (me.earth.headlessmc.mc.metrics), so that the values are computed the same way.
 * All times are in nanoseconds as BigInt-free numbers from process.hrtime, which is precise enough for our purposes.
 */

const NANOS_PER_SECOND = 1e9
const NANOS_PER_MILLI = 1e6

function nanoTime () {
  return Number(process.hrtime.bigint())
}

/**
 * Average and maximum of the last size values.
 */
class RollingAverage {
  constructor (size) {
    if (size <= 0) throw new Error('Size must be positive, but was ' + size)
    this.values = new Float64Array(size)
    this.index = 0
    this.count = 0
  }

  add (value) {
    this.values[this.index] = value
    this.index = (this.index + 1) % this.values.length
    this.count = Math.min(this.count + 1, this.values.length)
  }

  /** @returns {number|null} */
  getAverage () {
    if (this.count === 0) return null
    let sum = 0
    for (let i = 0; i < this.count; i++) sum += this.values[i]
    return sum / this.count
  }

  /** @returns {number|null} */
  getMax () {
    if (this.count === 0) return null
    let max = this.values[0]
    for (let i = 1; i < this.count; i++) max = Math.max(max, this.values[i])
    return max
  }

  reset () {
    this.index = 0
    this.count = 0
  }
}

/**
 * Counts events per second, averaged over the last completed seconds.
 */
class RateCounter {
  constructor (seconds) {
    if (seconds <= 0) throw new Error('Seconds must be positive, but was ' + seconds)
    // one more bucket for the current, incomplete second
    this.buckets = new Array(seconds + 1).fill(0)
    this.currentSecond = null
  }

  record (now) {
    this._advance(now)
    this.buckets[this._index(this.currentSecond)]++
  }

  getRate (now) {
    if (this.currentSecond === null) return 0
    this._advance(now)
    let sum = 0
    for (let i = 1; i < this.buckets.length; i++) sum += this.buckets[this._index(this.currentSecond - i)]
    return sum / (this.buckets.length - 1)
  }

  reset () {
    this.currentSecond = null
    this.buckets.fill(0)
  }

  _advance (now) {
    const second = Math.floor(now / NANOS_PER_SECOND)
    if (this.currentSecond === null || second - this.currentSecond >= this.buckets.length) {
      this.buckets.fill(0)
    } else {
      for (let s = this.currentSecond + 1; s <= second; s++) this.buckets[this._index(s)] = 0
    }

    if (this.currentSecond === null || second > this.currentSecond) this.currentSecond = second
  }

  _index (second) {
    const n = this.buckets.length
    return ((second % n) + n) % n
  }
}

/**
 * Estimates the TPS of a server from the game time the server sends about once per second (every 20 ticks).
 * If no new samples arrive the server is probably not ticking, so the estimate decreases.
 */
class TpsCalculator {
  constructor (maxSamples) {
    if (maxSamples < 2) throw new Error('Need at least two samples, but got ' + maxSamples)
    this.maxSamples = maxSamples
    this.samples = []
  }

  add (now, gameTime) {
    const last = this.samples[this.samples.length - 1]
    if (last && gameTime < last.gameTime) this.samples = [] // probably joined another server
    this.samples.push({ nanoTime: now, gameTime })
    while (this.samples.length > this.maxSamples) this.samples.shift()
  }

  getTps (now, maxTps) {
    if (this.samples.length < 2) return null
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const end = now - last.nanoTime > TpsCalculator.STALE_NANOS ? now : last.nanoTime
    const elapsed = end - first.nanoTime
    if (elapsed <= 0) return null
    const tps = (last.gameTime - first.gameTime) * NANOS_PER_SECOND / elapsed
    return Math.max(0, Math.min(maxTps, tps))
  }

  reset () {
    this.samples = []
  }
}

/** If no sample has been received for this long the time since the last sample is taken into account. */
TpsCalculator.STALE_NANOS = 3 * NANOS_PER_SECOND

/**
 * Collects metrics from bot events, like the MetricsTracker of HMC-Specifics does from mixins.
 */
class MetricsTracker {
  constructor (now = nanoTime) {
    this.now = now
    this.tickTimes = new RollingAverage(100)
    this.tpsCalculator = new TpsCalculator(20)
    this.received = new RateCounter(5)
    this.sent = new RateCounter(5)
    this.frames = new RateCounter(5)
    this.tickStart = -1
    this.lastPacket = -1
    this.joined = -1
  }

  onTickStart () {
    this.tickStart = this.now()
  }

  onTickEnd () {
    if (this.tickStart !== -1) {
      this.tickTimes.add((this.now() - this.tickStart) / NANOS_PER_MILLI)
      this.tickStart = -1
    }
  }

  onTimeUpdate (gameTime) {
    this.tpsCalculator.add(this.now(), gameTime)
  }

  onJoin () {
    this.joined = this.now()
    this.tpsCalculator.reset()
  }

  onPacketReceived () {
    const now = this.now()
    this.lastPacket = now
    this.received.record(now)
  }

  onPacketSent () {
    this.sent.record(this.now())
  }

  onFrame () {
    this.frames.record(this.now())
  }

  getAverageTickTime () {
    return this.tickTimes.getAverage()
  }

  getMaxTickTime () {
    return this.tickTimes.getMax()
  }

  getTps (tickRate) {
    return this.tpsCalculator.getTps(this.now(), tickRate == null ? 20 : tickRate)
  }

  getPacketsReceivedPerSecond () {
    return this.received.getRate(this.now())
  }

  getPacketsSentPerSecond () {
    return this.sent.getRate(this.now())
  }

  getFramesPerSecond () {
    return this.frames.getRate(this.now())
  }

  getMillisSinceLastPacket () {
    return this.lastPacket === -1 ? null : Math.floor((this.now() - this.lastPacket) / NANOS_PER_MILLI)
  }

  getSecondsSinceJoin () {
    return this.joined === -1 ? null : Math.floor((this.now() - this.joined) / NANOS_PER_SECOND)
  }
}

module.exports = { RollingAverage, RateCounter, TpsCalculator, MetricsTracker, nanoTime }
