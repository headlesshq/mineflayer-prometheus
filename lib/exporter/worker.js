'use strict'

/**
 * The exporter thread: a worker thread with the HTTP server, so that /metrics answers even if the main thread of the bot
 * is blocked, exactly like HMC-Prometheus answers from its own threads while Minecraft's main thread is frozen.
 * The values are collected on the main thread, if it does not answer within collectTimeoutMs the previous values are
 * served and hmc_collect_success is 0.
 *
 * Serves /metrics, /-/healthy, /screenshot.png, /live, /console, /command and /.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { parentPort, workerData } = require('worker_threads')
const { performance } = require('perf_hooks')
const { Exposition, CONTENT_TYPE } = require('./exposition')
const { MetricsConverter } = require('./converter')
const { LokiPusher } = require('./loki')
const runtime = require('../metrics/runtime')

const config = workerData
const constLabels = { client: config.client }
const BOUNDARY = 'hmc-prometheus-frame'
const SCREENSHOT_TIMEOUT_MS = 10000
const COMMAND_TIMEOUT_MS = 30000
// Grafana opens a new stream when the dashboard refreshes
const MAX_STREAM_MS = 5 * 60 * 1000
const MAX_STREAMS = 4
const MAX_COMMAND_LENGTH = 4096

let nextId = 1
const requests = new Map()

let pendingCollect = null
let last = null // the last values collected by the main thread
let lastCollected = -1
const streams = []
let screenshotRequests = 0
let liveRequests = 0
const warned = new Set()

const lokiPusher = config.lokiUrl ? new LokiPusher(config.lokiUrl, config.client, warn) : null

function now () {
  return performance.timeOrigin + performance.now()
}

function warn (message) {
  parentPort.postMessage({ type: 'warn', message })
}

/** Sends a request to the main thread, resolves with its answer or null after the timeout. */
function request (message, timeoutMs, transfer) {
  const id = nextId++
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      requests.delete(id)
      resolve(null)
    }, timeoutMs)
    requests.set(id, answer => {
      clearTimeout(timer)
      requests.delete(id)
      resolve(answer)
    })
    parentPort.postMessage({ ...message, id, sentAt: now() }, transfer)
  })
}

parentPort.on('message', message => {
  switch (message.type) {
    case 'answer': {
      const callback = requests.get(message.id)
      if (callback) callback(message)
      break
    }
    case 'log':
      if (lokiPusher) lokiPusher.add(message.time, message.level, message.line)
      break
    case 'stop':
      stop()
      break
  }
})

/**
 * Collects on the main thread, a blocked main thread would otherwise pile up a request for every scrape.
 * @returns {Promise<boolean>} true if the values have been collected within the timeout.
 */
async function collectOnMainThread () {
  if (!pendingCollect) {
    const promise = new Promise(resolve => {
      const id = nextId++
      requests.set(id, answer => {
        requests.delete(id)
        resolve(answer)
      })
      parentPort.postMessage({ type: 'collect', id, sentAt: now() })
    })
    pendingCollect = promise
    promise.then(answer => {
      if (answer) {
        last = answer
        lastCollected = now()
      }

      if (pendingCollect === promise) pendingCollect = null
    })
  }

  const current = pendingCollect
  const answer = await Promise.race([current, new Promise(resolve => setTimeout(() => resolve(null), config.collectTimeoutMs))])
  return answer != null
}

async function metrics () {
  const success = await collectOnMainThread()
  const exposition = new Exposition()
  const converter = new MetricsConverter(constLabels, (name, e) => {
    if (!warned.has(name)) {
      warned.add(name)
      warn(`Failed to export metric ${name}: ${e.message}`)
    }
  })

  if (last) {
    for (const metric of last.metrics) converter.add(metric.name, metric.description, last.values[metric.name])
  }

  converter.gauge('hmc_collect_success', "Whether the last scrape could collect the metrics on Minecraft's main thread in time.", success ? 1 : 0)
  if (lastCollected !== -1) {
    converter.gauge('hmc_main_thread_latency_seconds', "Time until Minecraft's main thread started collecting the metrics.", last.latency)
    converter.gauge('hmc_collect_duration_seconds', "Time it took to collect the metrics on Minecraft's main thread.", last.duration)
    converter.gauge('hmc_data_age_seconds', 'Age of the served metrics, greater than 0 if the main thread did not collect them in time.',
      (now() - lastCollected) / 1000)
  }

  converter.writeTo(exposition)
  if (config.jvmMetrics) writeRuntimeMetrics(exposition, last && last.runtime)

  exposition.info('hmc_prometheus', 'Information about HMC-Prometheus.', { client: config.client, loader: config.loader, version: config.version })
  exposition.gauge('hmc_screenshots_available',
    'Whether /screenshot.png and /live serve screenshots, the game has to render and screenshots have to be enabled.',
    config.screenshots && last && last.screenshotsAvailable ? 1 : 0, constLabels)
  if (lokiPusher) {
    exposition.counter('hmc_loki_sent_lines', 'Log lines pushed to Loki.', lokiPusher.sent, constLabels)
    exposition.counter('hmc_loki_dropped_lines', 'Log lines dropped, because Loki was not reachable or rejected them.', lokiPusher.dropped, constLabels)
    exposition.counter('hmc_loki_failed_pushes', 'Failed attempts to push to Loki.', lokiPusher.failedPushes, constLabels)
    exposition.gauge('hmc_loki_queued_lines', 'Log lines waiting to be pushed to Loki.', lokiPusher.getQueued(), constLabels)
  }

  exposition.counter('hmc_screenshot_requests', 'Requests of /screenshot.png and /live.', screenshotRequests, { client: config.client, endpoint: 'screenshot.png' })
  exposition.counter('hmc_screenshot_requests', 'Requests of /screenshot.png and /live.', liveRequests, { client: config.client, endpoint: 'live' })
  exposition.gauge('hmc_screenshot_live_streams', 'Open /live streams.', streams.length, constLabels)
  return exposition.toString()
}

/**
 * The JVM and process metrics of the Prometheus Java client, with the values of Node.js, see runtime.js.
 */
function writeRuntimeMetrics (exposition, main) {
  const labels = area => ({ area, client: config.client })
  if (main) {
    exposition.gauge('jvm_memory_used_bytes', 'Used bytes of a given JVM memory area.', main.heap.used, labels('heap'))
    exposition.gauge('jvm_memory_used_bytes', 'Used bytes of a given JVM memory area.', main.nonHeap.used, labels('nonheap'))
    exposition.gauge('jvm_memory_committed_bytes', 'Committed (bytes) of a given JVM memory area.', main.heap.committed, labels('heap'))
    exposition.gauge('jvm_memory_committed_bytes', 'Committed (bytes) of a given JVM memory area.', main.nonHeap.committed, labels('nonheap'))
    exposition.gauge('jvm_memory_max_bytes', 'Max (bytes) of a given JVM memory area.', main.heap.max, labels('heap'))
    exposition.gauge('jvm_memory_max_bytes', 'Max (bytes) of a given JVM memory area.', main.nonHeap.max, labels('nonheap'))
    for (const gc of main.gc) {
      exposition.summary('jvm_gc_collection_seconds', 'Time spent in a given JVM garbage collector in seconds.',
        gc.count, gc.seconds, { client: config.client, gc: gc.name })
    }

    if (main.threads) {
      exposition.gauge('jvm_threads_current', 'Current thread count of a JVM', main.threads.live, constLabels)
      exposition.gauge('jvm_threads_daemon', 'Daemon thread count of a JVM', 0, constLabels)
      exposition.gauge('jvm_threads_peak', 'Peak thread count of a JVM', main.threads.peak, constLabels)
    }
  }

  exposition.info('jvm_runtime', 'JVM runtime info', { client: config.client, runtime: 'Node.js', vendor: 'OpenJS Foundation', version: process.versions.node })
  const p = runtime.processSnapshot()
  exposition.counter('process_cpu_seconds', 'Total user and system CPU time spent in seconds.', p.cpuSeconds, constLabels)
  exposition.gauge('process_start_time_seconds', 'Start time of the process since unix epoch in seconds.', p.startTimeSeconds, constLabels)
  exposition.gauge('process_resident_memory_bytes', 'Resident memory size in bytes.', p.residentBytes, constLabels)
  if (p.virtualBytes != null) exposition.gauge('process_virtual_memory_bytes', 'Virtual memory size in bytes.', p.virtualBytes, constLabels)
  if (p.openFds != null) exposition.gauge('process_open_fds', 'Number of open file descriptors.', p.openFds, constLabels)
  if (p.maxFds != null) exposition.gauge('process_max_fds', 'Maximum number of open file descriptors.', p.maxFds, constLabels)
}

class ScreenshotError extends Error {}

/**
 * @param {boolean} live a JPEG frame for /live, otherwise a PNG screenshot.
 */
async function takeScreenshot (live = false) {
  if (!config.screenshots) throw new ScreenshotError('Rendering is disabled, enable it with the option render: true')
  const frameMs = 1000 / Math.max(0.1, config.liveFps)
  // a frame is shared by all viewers that ask for it within its interval
  const answer = await request(live
    ? { type: 'screenshot', format: 'jpeg', live: true, maxAgeMs: frameMs * 0.9 }
    : { type: 'screenshot', format: 'png', live: false, maxAgeMs: config.screenshotIntervalMs }, SCREENSHOT_TIMEOUT_MS)
  if (!answer) throw new ScreenshotError('Timed out waiting for a screenshot, the bot might be frozen')
  if (answer.error) throw new ScreenshotError(answer.error)
  return Buffer.from(answer.png)
}

async function screenshot (res) {
  screenshotRequests++
  try {
    send(res, 200, 'image/png', await takeScreenshot())
  } catch (e) {
    if (!(e instanceof ScreenshotError)) throw e
    send(res, config.screenshots ? 503 : 404, 'image/svg+xml', placeholder(e.message))
  }
}

async function live (req, res) {
  if (!config.screenshots) {
    send(res, 404, 'image/svg+xml', placeholder('Rendering is disabled, enable it with the option render: true'))
    return
  }

  liveRequests++
  const stream = { ended: false }
  // browsers do not always close a stream when an img tag reloads, so the oldest stream is ended
  while (streams.length >= MAX_STREAMS) streams.shift().ended = true
  streams.push(stream)
  req.on('close', () => { stream.ended = true })
  try {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=' + BOUNDARY, 'Cache-Control': 'no-store' })
    const end = Date.now() + MAX_STREAM_MS
    while (Date.now() < end && !stream.ended && !res.destroyed) {
      const start = Date.now()
      try {
        writeFrame(res, 'image/jpeg', await takeScreenshot(true))
      } catch (e) {
        if (!(e instanceof ScreenshotError)) throw e
        // nothing will change, show why and end the stream
        writeFrame(res, 'image/svg+xml', placeholder(e.message))
        return
      }

      await sleep(Math.max(0, 1000 / Math.max(0.1, config.liveFps) - (Date.now() - start)))
    }
  } finally {
    const index = streams.indexOf(stream)
    if (index >= 0) streams.splice(index, 1)
    res.end()
  }
}

function writeFrame (res, contentType, bytes) {
  res.write(`--${BOUNDARY}\r\nContent-Type: ${contentType}\r\nContent-Length: ${bytes.length}\r\n\r\n`)
  res.write(bytes)
  res.write('\r\n')
}

let consoleTemplate = null
function consolePage (res) {
  if (!consoleTemplate) consoleTemplate = fs.readFileSync(path.join(__dirname, 'console.html'), 'utf8')
  send(res, 200, 'text/html; charset=utf-8', consoleTemplate
    .replace('{{client}}', escapeJs(config.client))
    .replace('{{enabled}}', String(!!config.console)))
}

/**
 * Executing commands from a browser is dangerous, every website you visit could send requests to 127.0.0.1, so:
 * the console is disabled unless the option console is true, commands need the header X-HMC-Console, which browsers
 * only send to other origins after a CORS preflight request that this server never allows, and the Host header has to
 * be one of the addresses of this bot, against DNS rebinding.
 */
async function command (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    send(res, 405, 'text/plain; charset=utf-8', 'Use POST\n')
    return
  }

  if (!config.console) {
    send(res, 403, 'text/plain; charset=utf-8', 'The console is disabled. Enable it with the option console: true\n')
    return
  }

  if (req.headers['x-hmc-console'] === undefined || !isAllowedHost(req.headers.host)) {
    send(res, 403, 'text/plain; charset=utf-8', 'Forbidden\n')
    return
  }

  const line = (await readBody(req)).trim()
  if (!line) {
    send(res, 200, 'text/plain; charset=utf-8', '')
    return
  }

  const answer = await request({ type: 'command', line }, COMMAND_TIMEOUT_MS)
  let output
  if (!answer) {
    output = `(still running after ${COMMAND_TIMEOUT_MS / 1000}s, later output only appears in the log)`
  } else {
    output = answer.output + (answer.error ? '\n' + answer.error : '')
  }

  if (lokiPusher) lokiPusher.flush()
  res.setHeader('X-HMC-Loki', String(!!lokiPusher))
  send(res, 200, 'text/plain; charset=utf-8', output)
}

function isAllowedHost (host) {
  if (!host) return false
  let name = host.toLowerCase()
  if (name.startsWith('[')) {
    const end = name.indexOf(']')
    name = end < 0 ? name : name.substring(0, end + 1)
  } else if (name.includes(':')) {
    name = name.substring(0, name.indexOf(':'))
  }

  return config.allowedHosts.includes(name)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      if (body.length <= MAX_COMMAND_LENGTH) body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function index () {
  return '<!doctype html><html><head><meta charset="utf-8"><title>mineflayer-prometheus</title></head>' +
    `<body style="font-family:sans-serif"><h1>mineflayer-prometheus: ${escapeHtml(config.client)}</h1><ul>` +
    '<li><a href="/metrics">/metrics</a></li>' +
    '<li><a href="/screenshot.png">/screenshot.png</a></li>' +
    '<li><a href="/live">/live</a></li>' +
    '<li><a href="/console">/console</a></li>' +
    '<li><a href="/-/healthy">/-/healthy</a></li>' +
    '</ul></body></html>'
}

function placeholder (message) {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="854" height="480" viewBox="0 0 854 480">' +
    '<rect width="854" height="480" fill="#22252b"/>' +
    '<text x="427" y="240" fill="#ccccdc" font-family="sans-serif" font-size="18" text-anchor="middle">' +
    escapeHtml(message) + '</text></svg>')
}

function send (res, code, contentType, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  res.writeHead(code, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Content-Length': bytes.length })
  res.end(bytes)
}

function escapeHtml (value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escapeJs (value) {
  return value.replace(/["\\<>&\u0000-\u001f\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function handle (req, res) {
  const url = new URL(req.url, 'http://localhost')
  switch (url.pathname) {
    case '/metrics':
      send(res, 200, CONTENT_TYPE, await metrics())
      break
    case '/-/healthy':
      send(res, 200, 'text/plain; charset=utf-8', 'Exporter is healthy.\n')
      break
    case '/screenshot.png':
      await screenshot(res)
      break
    case '/live':
      await live(req, res)
      break
    case '/console':
      consolePage(res)
      break
    case '/command':
      await command(req, res)
      break
    case '/':
      send(res, 200, 'text/html; charset=utf-8', index())
      break
    default:
      send(res, 404, 'text/plain; charset=utf-8', 'Not found\n')
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    warn('Failed to handle ' + req.url + ': ' + (e && e.stack ? e.stack : e))
    if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal error\n')
    else res.destroy()
  })
})

/** Tries the port and the following ports, if they are in use, e.g. by other bots. */
function listen (port, last) {
  server.removeAllListeners('error')
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && port < last) {
      listen(port + 1, last)
    } else {
      parentPort.postMessage({
        type: 'error',
        message: `Failed to bind to any port from ${config.port} to ${last} on ${config.host}: ${e.message}`
      })
    }
  })
  server.listen(port, config.host)
}

server.once('listening', () => parentPort.postMessage({ type: 'listening', port: server.address().port }))

function stop () {
  for (const stream of streams) stream.ended = true
  server.close()
  if (server.closeAllConnections) server.closeAllConnections()
  const done = () => process.exit(0)
  if (lokiPusher) lokiPusher.close().then(done, done)
  else done()
}

listen(config.port, config.port + Math.max(0, config.portRange))
