'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { TpsCalculator, RateCounter, RollingAverage, MetricsTracker } = require('../lib/metrics/tracker')

const S = 1e9

test('tps from game time samples', () => {
  const tps = new TpsCalculator(20)
  assert.strictEqual(tps.getTps(0, 20), null)
  tps.add(0, 0)
  tps.add(S, 20)
  tps.add(2 * S, 30) // the server lagged
  assert.strictEqual(tps.getTps(2 * S, 20), 15)
  // no samples for longer than 3s, the server is probably not ticking
  assert.strictEqual(tps.getTps(6 * S, 20), 5)
  assert.strictEqual(tps.getTps(2 * S, 10), 10)
})

test('tps resets when the game time goes back', () => {
  const tps = new TpsCalculator(20)
  tps.add(0, 1000)
  tps.add(S, 1020)
  tps.add(2 * S, 5)
  assert.strictEqual(tps.getTps(2 * S, 20), null)
})

test('rate counter averages completed seconds', () => {
  const rate = new RateCounter(5)
  for (let i = 0; i < 10; i++) rate.record(0.5 * S)
  assert.strictEqual(rate.getRate(1.1 * S), 2)
  assert.strictEqual(rate.getRate(10 * S), 0)
})

test('rolling average and max', () => {
  const avg = new RollingAverage(2)
  assert.strictEqual(avg.getAverage(), null)
  avg.add(1)
  avg.add(3)
  avg.add(5)
  assert.strictEqual(avg.getAverage(), 4)
  assert.strictEqual(avg.getMax(), 5)
})

test('tracker tick times and session', () => {
  let now = 0
  const tracker = new MetricsTracker(() => now)
  tracker.onJoin()
  tracker.onTickStart()
  now += 2e6
  tracker.onTickEnd()
  now += 3 * S
  assert.strictEqual(tracker.getAverageTickTime(), 2)
  assert.strictEqual(tracker.getSecondsSinceJoin(), 3)
  assert.strictEqual(tracker.getMillisSinceLastPacket(), null)
})
