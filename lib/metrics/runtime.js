'use strict'

const fs = require('fs')
const os = require('os')
const v8 = require('v8')

/**
 * Runtime metrics of Node.js, in the shape of the JVM metrics that HMC-Prometheus exports,
 * so that the same dashboards work: V8's heap is the "heap" area, memory outside of it the "nonheap" area,
 * and every kind of V8 garbage collection is a garbage collector.
 * Heap and GC are per thread in Node.js, so they are read on the main thread of the bot.
 */

const GC_NAMES = {
  1: 'Scavenge', // NODE_PERFORMANCE_GC_MINOR
  2: 'MarkSweepCompact', // NODE_PERFORMANCE_GC_MAJOR
  4: 'IncrementalMarking', // NODE_PERFORMANCE_GC_INCREMENTAL
  8: 'ProcessWeakCallbacks' // NODE_PERFORMANCE_GC_WEAKCB
}

const gcStats = new Map()
let gcObserver = null
let peakThreads = 0
let lastCpu = null

/**
 * Starts observing garbage collections, once per thread.
 */
function observeGc () {
  if (gcObserver) return
  try {
    const { PerformanceObserver } = require('perf_hooks')
    gcObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const kind = entry.detail ? entry.detail.kind : entry.kind
        const name = GC_NAMES[kind] || 'Unknown'
        const stats = gcStats.get(name) || { name, count: 0, seconds: 0 }
        stats.count++
        stats.seconds += entry.duration / 1000
        gcStats.set(name, stats)
      }
    })
    gcObserver.observe({ entryTypes: ['gc'] })
  } catch (e) {
    gcObserver = { disconnect () {} }
  }
}

/** @returns used, committed and max bytes of the V8 heap of this thread. */
function heap () {
  const stats = v8.getHeapStatistics()
  return { used: stats.used_heap_size, committed: stats.total_heap_size, max: stats.heap_size_limit }
}

/** @returns memory allocated outside the V8 heap, e.g. Buffers and chunk data. */
function nonHeap () {
  const usage = process.memoryUsage()
  return { used: usage.external, committed: usage.external, max: -1 }
}

function gc () {
  return [...gcStats.values()].map(s => ({ ...s }))
}

/** @returns live and peak threads of the process, from /proc on Linux, otherwise null. */
function threads () {
  const status = readProcStatus()
  if (!status || status.Threads == null) return null
  const live = parseInt(status.Threads, 10)
  peakThreads = Math.max(peakThreads, live)
  return { live, peak: peakThreads }
}

/** @returns CPU load of this process (since the last call) and of the system in percent. */
function cpuLoad () {
  const now = process.hrtime.bigint()
  const usage = process.cpuUsage()
  const cpus = os.cpus().length || 1
  let processLoad = null
  if (lastCpu) {
    const elapsedMicros = Number(now - lastCpu.time) / 1000
    const usedMicros = usage.user + usage.system - lastCpu.user - lastCpu.system
    processLoad = elapsedMicros > 0 ? Math.min(100, usedMicros * 100 / elapsedMicros / cpus) : null
  }

  lastCpu = { time: now, user: usage.user, system: usage.system }
  const system = Math.min(100, os.loadavg()[0] * 100 / cpus)
  return { process: processLoad, system: os.platform() === 'win32' ? null : system }
}

/** @returns everything the exporter thread needs from the main thread, as a structured clonable object. */
function mainThreadSnapshot () {
  const t = threads()
  return { heap: heap(), nonHeap: nonHeap(), gc: gc(), threads: t }
}

/** Process wide values, which can be read from any thread. */
function processSnapshot () {
  const usage = process.cpuUsage()
  const result = {
    cpuSeconds: (usage.user + usage.system) / 1e6,
    startTimeSeconds: Math.round(Date.now() / 1000 - process.uptime()),
    residentBytes: process.memoryUsage().rss,
    virtualBytes: null,
    openFds: null,
    maxFds: null
  }

  const status = readProcStatus()
  if (status && status.VmSize) result.virtualBytes = parseInt(status.VmSize, 10) * 1024
  try {
    result.openFds = fs.readdirSync('/proc/self/fd').length
  } catch (e) {
    // not Linux
  }

  try {
    const limits = fs.readFileSync('/proc/self/limits', 'utf8').match(/^Max open files\s+(\d+)/m)
    if (limits) result.maxFds = parseInt(limits[1], 10)
  } catch (e) {
    // not Linux
  }

  return result
}

function readProcStatus () {
  try {
    const result = {}
    for (const line of fs.readFileSync('/proc/self/status', 'utf8').split('\n')) {
      const index = line.indexOf(':')
      if (index > 0) result[line.substring(0, index)] = line.substring(index + 1).trim()
    }

    return result
  } catch (e) {
    return null
  }
}

module.exports = { observeGc, heap, nonHeap, gc, threads, cpuLoad, mainThreadSnapshot, processSnapshot }
