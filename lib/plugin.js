'use strict'

const fs = require('fs')
const path = require('path')
const { Worker } = require('worker_threads')
const { performance } = require('perf_hooks')
const { MetricsService } = require('./metrics/service')
const { MetricsTracker } = require('./metrics/tracker')
const { registerAll, BotMetricsSource } = require('./metrics/defaults')
const runtime = require('./metrics/runtime')
const { resolveConfig, DESCRIPTIONS } = require('./config')
const { TargetDiscovery } = require('./discovery')
const { Renderer } = require('./renderer')
const { createCommands } = require('./commands')

const NAME = 'mineflayer-prometheus'
const VERSION = require('../package.json').version
const DASHBOARD_PATH = '/d/hmc-client/minecraft-client?var-client='
const MAX_BUFFERED_LINES = 1000

/** Discovery files of all running exporters of this process, deleted when the process exits. */
const discoveryFiles = new Set()
function removeDiscoveryFiles () {
  for (const file of discoveryFiles) {
    try {
      fs.rmSync(file, { force: true })
    } catch (e) {
      // nothing we can do
    }
  }

  discoveryFiles.clear()
}

process.once('exit', removeDiscoveryFiles)
// Node.js does not run exit handlers when it is killed by a signal, e.g. by docker stop. If nobody else handles the
// signal, behave like the default and exit, otherwise leave the shutdown to the other handlers.
for (const [signal, number] of [['SIGTERM', 15], ['SIGINT', 2]]) {
  process.on(signal, function onSignal () {
    removeDiscoveryFiles()
    if (process.listenerCount(signal) === 1) process.exit(128 + number)
  })
}

/** Bots that capture console.*, see captureConsole. */
const consoleSinks = new Set()
let consolePatched = false
function patchConsole () {
  if (consolePatched) return
  consolePatched = true
  const util = require('util')
  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['debug', 'DEBUG'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method]
    console[method] = function (...args) {
      original.apply(this, args)
      if (consoleSinks.size === 0) return
      try {
        const line = util.format(...args)
        for (const sink of consoleSinks) sink(level, line)
      } catch (e) {
        // logging must never fail because of us
      }
    }
  }
}

/**
 * Creates the plugin, e.g. bot.loadPlugin(prometheus({ client: 'bot-1', render: true })).
 *
 * @param {object} [options] see config.js and the README.
 */
function prometheus (options = {}) {
  return function mineflayerPrometheus (bot, botOptions) {
    inject(bot, botOptions || {}, options)
  }
}

function inject (bot, botOptions, options) {
  const config = resolveConfig(options)
  const service = new MetricsService()
  const tracker = new MetricsTracker()
  let renderer = null
  const source = new BotMetricsSource(bot, botOptions, tracker, () => renderer)
  registerAll(service, source, tracker)
  runtime.observeGc()

  let exporter = null // the running exporter thread
  let starting = null
  const buffered = [] // lines logged before the exporter started
  const cleanup = []

  function on (emitter, event, listener) {
    emitter.on(event, listener)
    cleanup.push(() => emitter.removeListener(event, listener))
  }

  // client tick time: the time the physics tick listeners take, e.g. pathfinder, like Minecraft's runTick
  const emit = bot.emit
  bot.emit = function (event, ...args) {
    if (event !== 'physicsTick') return emit.call(this, event, ...args)
    tracker.onTickStart()
    try {
      return emit.call(this, event, ...args)
    } finally {
      tracker.onTickEnd()
    }
  }
  cleanup.push(() => { bot.emit = emit })

  const client = bot._client
  if (client) {
    on(client, 'packet', () => tracker.onPacketReceived())
    on(client, 'set_ticking_state', packet => {
      const rate = packet.tick_rate ?? packet.tickRate
      const frozen = packet.is_frozen ?? packet.isFrozen
      if (typeof rate === 'number') source.tickRate = rate
      if (typeof frozen === 'boolean') source.tickingFrozen = frozen
    })
    // newer protocol versions map the difficulty to its name, which mineflayer looks up again and loses
    on(client, 'difficulty', packet => {
      const d = packet.difficulty
      source.difficulty = typeof d === 'string' ? d : ['peaceful', 'easy', 'normal', 'hard'][d] || null
    })
    const write = client.write
    client.write = function (...args) {
      tracker.onPacketSent()
      return write.apply(this, args)
    }
    cleanup.push(() => { client.write = write })
  }

  on(bot, 'login', () => {
    tracker.onJoin()
    log('INFO', 'mineflayer', `Logged in as ${bot.username} on ${source.getServerAddress()} (${bot.version})`)
    if (!exporter && !starting && config.enabled) start().catch(() => {})
  })
  on(bot, 'time', () => {
    if (bot.time && bot.time.age != null) tracker.onTimeUpdate(Number(bot.time.age))
  })
  on(bot, 'spawn', () => {
    if (!source.spawned) log('INFO', 'mineflayer', `Spawned at ${bot.entity.position} in ${source.getDimension()}`)
    source.spawned = true
    if (config.render) {
      if (!renderer) renderer = new Renderer(bot, {
        width: config.renderWidth,
        height: config.renderHeight,
        viewDistance: config.viewDistance,
        intervalMs: config.screenshotIntervalMs,
        renderWaitMs: config.renderWaitMs
      }, () => tracker.onFrame())
      renderer.start()
      if (renderer.error) log('WARN', NAME, renderer.error)
    }
  })
  on(bot, 'message', (message, position) => {
    if (position === 'game_info') return // the action bar, Minecraft does not log it either
    log('INFO', 'chat', '[CHAT] ' + (typeof message.toAnsi === 'function' ? message.toAnsi() : String(message)))
  })
  on(bot, 'death', () => log('INFO', 'mineflayer', `${bot.username} died`))
  on(bot, 'kicked', reason => log('WARN', 'mineflayer', 'Kicked: ' + formatReason(bot, reason)))
  on(bot, 'error', e => log('ERROR', 'mineflayer', e && e.stack ? e.stack : String(e)))
  on(bot, 'end', reason => {
    source.spawned = false
    log('WARN', 'mineflayer', 'Disconnected: ' + formatReason(bot, reason))
    if (renderer) renderer.close()
    if (config.stopOnEnd) {
      stop().finally(() => cleanup.splice(0).forEach(fn => fn()))
    }
  })

  const consoleSink = (level, line) => log(level, 'console', line)
  if (config.captureConsole) {
    patchConsole()
    consoleSinks.add(consoleSink)
    cleanup.push(() => consoleSinks.delete(consoleSink))
  }

  function log (level, logger, message) {
    const line = `[main/${level}] [${logger}]: ${message}`
    const entry = { type: 'log', time: Date.now(), level, line }
    if (exporter) {
      exporter.worker.postMessage(entry)
    } else if (config.lokiUrl) {
      buffered.push(entry)
      if (buffered.length > MAX_BUFFERED_LINES) buffered.shift()
    }
  }

  function warn (message) {
    // not with console.warn, which could be captured and pushed again
    process.stderr.write(`[${NAME}] ${message}\n`)
    log('WARN', NAME, message)
  }

  const commands = createCommands(bot, { metrics: service, status: () => status() }, config.commands)

  function getClientName () {
    if (config.client) return config.client
    if (bot.username) return bot.username
    // offline accounts already have their name, Microsoft accounts only after logging in
    const auth = botOptions.auth || 'offline'
    return auth === 'offline' && botOptions.username ? botOptions.username : null
  }

  function selectMetrics () {
    const result = new Map()
    const select = query => {
      try {
        return service.select(query)
      } catch (e) { // the metric might be registered later
        return []
      }
    }

    if (config.include.length === 0) service.getMetrics().forEach(m => result.set(m.name, m))
    else config.include.forEach(q => select(q).forEach(m => result.set(m.name, m)))
    config.exclude.forEach(q => select(q).forEach(m => result.delete(m.name)))
    return [...result.values()]
  }

  async function onRequest (worker, message) {
    switch (message.type) {
      case 'collect': {
        const start = performance.timeOrigin + performance.now()
        const metrics = selectMetrics()
        const values = toClonable(service.collect(metrics))
        const answer = {
          type: 'answer',
          id: message.id,
          metrics: metrics.map(m => ({ name: m.name, description: m.description })),
          values,
          runtime: config.jvmMetrics ? runtime.mainThreadSnapshot() : null,
          screenshotsAvailable: !!renderer && renderer.isAvailable(),
          latency: Math.max(0, start - message.sentAt) / 1000
        }
        answer.duration = (performance.timeOrigin + performance.now() - start) / 1000
        worker.postMessage(answer)
        break
      }
      case 'screenshot': {
        let answer
        try {
          if (!renderer) throw new Error(config.render ? 'The bot has not spawned yet, so nothing is rendered' : 'Rendering is disabled')
          answer = { type: 'answer', id: message.id, png: await renderer.get({ format: message.format, maxAgeMs: message.maxAgeMs, live: message.live }) }
        } catch (e) {
          answer = { type: 'answer', id: message.id, error: e.message }
        }

        worker.postMessage(answer)
        break
      }
      case 'command': {
        let output = ''
        let error = null
        log('INFO', 'console', '> ' + message.line)
        try {
          output = await commands.execute(message.line)
        } catch (e) {
          error = String(e && e.message ? e.message : e)
        }

        for (const line of (output + (error ? '\n' + error : '')).split('\n').filter(Boolean)) {
          log(error ? 'ERROR' : 'INFO', 'console', line)
        }

        worker.postMessage({ type: 'answer', id: message.id, output, error })
        break
      }
      case 'warn':
        warn(message.message)
        break
    }
  }

  /**
   * Starts (or restarts) the exporter.
   * @returns {Promise<void>} resolves when it serves metrics.
   */
  async function start () {
    if (starting) return starting
    if (exporter) await stop()
    const clientName = getClientName()
    if (!clientName) {
      // started on login, once the username is known
      return
    }

    starting = new Promise((resolve, reject) => {
      const host = config.host
      const allowedHosts = ['127.0.0.1', 'localhost', '[::1]']
      for (const h of [host, config.discoveryAddress]) {
        if (h && h !== '0.0.0.0' && h !== '::') allowedHosts.push(h.toLowerCase())
      }

      const worker = new Worker(path.join(__dirname, 'exporter', 'worker.js'), {
        workerData: {
          client: clientName,
          host,
          port: config.port,
          portRange: config.portRange,
          jvmMetrics: config.jvmMetrics,
          collectTimeoutMs: config.collectTimeoutMs,
          screenshots: !!config.render,
          screenshotIntervalMs: config.screenshotIntervalMs,
          liveFps: config.liveFps,
          console: !!config.console,
          allowedHosts,
          lokiUrl: config.lokiUrl,
          loader: 'mineflayer',
          version: VERSION
        }
      })
      worker.unref() // the exporter must not keep a process alive whose bot has ended

      const state = { worker, client: clientName, port: null, discoveryFile: null, address: null, stopped: null }
      worker.on('message', message => {
        if (message.type === 'listening') {
          state.port = message.port
          state.address = config.discoveryAddress || (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host)
          exporter = state
          for (const entry of buffered.splice(0)) worker.postMessage(entry)
          writeDiscovery(state).finally(() => {
            log('INFO', NAME, `${NAME} serving metrics of client '${clientName}' on ${getUrl(state)}`)
            resolve()
          })
        } else if (message.type === 'error') {
          warn(message.message)
          worker.terminate()
          reject(new Error(message.message))
        } else {
          onRequest(worker, message).catch(e => warn('Failed to answer the exporter: ' + (e.stack || e)))
        }
      })
      worker.on('error', e => {
        warn('The exporter failed: ' + (e.stack || e))
        reject(e)
      })
      worker.on('exit', () => {
        if (exporter === state) {
          exporter = null
          removeDiscovery(state)
        }
      })
    })

    try {
      await starting
    } finally {
      starting = null
    }
  }

  async function writeDiscovery (state) {
    if (!config.discoveryDir) return
    try {
      state.discoveryFile = await new TargetDiscovery(config.discoveryDir).write(state.address, state.port, state.client)
      discoveryFiles.add(state.discoveryFile)
    } catch (e) {
      warn(`Failed to write Prometheus discovery file to ${config.discoveryDir}: ${e.message}`)
    }
  }

  function removeDiscovery (state) {
    if (state.discoveryFile) {
      discoveryFiles.delete(state.discoveryFile)
      try {
        fs.rmSync(state.discoveryFile, { force: true })
      } catch (e) {
        warn(`Failed to delete ${state.discoveryFile}: ${e.message}`)
      }
    }
  }

  /**
   * Stops the exporter, which removes the bot from discovery. Pushes the queued log lines once more.
   */
  async function stop () {
    if (starting) await starting.catch(() => {})
    const state = exporter
    if (!state) return
    exporter = null
    removeDiscovery(state)
    await new Promise(resolve => {
      const timer = setTimeout(() => state.worker.terminate().then(resolve, resolve), 6000)
      state.worker.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      state.worker.postMessage({ type: 'stop' })
    })
  }

  function getUrl (state) {
    return `http://${state.address}:${state.port}/metrics`
  }

  function status () {
    const lines = [`${NAME} ${VERSION} (mineflayer)`, `Status:    ${exporter ? 'running' : 'stopped'}`]
    if (exporter) {
      lines.push(`Client:    ${exporter.client}`, `Metrics:   ${getUrl(exporter)}`)
      if (exporter.discoveryFile) lines.push(`Discovery: ${exporter.discoveryFile}`)
      if (config.render) {
        lines.push(`Live view: http://${exporter.address}:${exporter.port}/live` +
          (renderer && renderer.isAvailable() ? '' : ` (unavailable: ${renderer ? renderer.error : 'the bot has not spawned yet'})`))
      }

      if (config.lokiUrl) lines.push(`Loki:      ${config.lokiUrl}`)
      if (config.grafanaUrl) {
        lines.push(`Dashboard: ${config.grafanaUrl.replace(/\/+$/, '')}${DASHBOARD_PATH}${encodeURIComponent(exporter.client)}`)
      }
    }

    return lines.join('\n')
  }

  function describeConfig () {
    return Object.keys(DESCRIPTIONS).map(key => `${key} = ${JSON.stringify(config[key])}: ${DESCRIPTIONS[key]}`).join('\n')
  }

  const api = {
    /** The metrics of this bot, register your own with bot.prometheus.metrics.register(name, description, get). */
    metrics: service,
    tracker,
    config,
    commands: commands.commands,
    start,
    stop,
    status,
    describeConfig,
    log,
    isRunning: () => !!exporter,
    getUrl: () => exporter ? getUrl(exporter) : null,
    getClient: () => exporter ? exporter.client : null,
    getRenderer: () => renderer
  }

  bot.prometheus = api

  if (config.enabled) {
    start().catch(() => {})
  }
}

function formatReason (bot, reason) {
  if (reason == null) return ''
  if (typeof reason === 'string') {
    try {
      return formatReason(bot, JSON.parse(reason))
    } catch (e) {
      return reason
    }
  }

  if (typeof reason.toAnsi === 'function') return reason.toAnsi()
  if (typeof reason === 'object') {
    try {
      const ChatMessage = require('prismarine-chat')(bot.registry)
      return new ChatMessage(reason).toAnsi()
    } catch (e) {
      return JSON.stringify(reason)
    }
  }

  return String(reason)
}

/**
 * Values of custom metrics may be anything, the exporter thread gets plain data.
 */
function toClonable (value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return Number(value)
  if (depth > 8 || typeof value === 'function' || typeof value === 'symbol') return null
  if (Array.isArray(value)) return value.map(v => toClonable(v, depth + 1))
  if (value instanceof Map) return toClonable(Object.fromEntries(value), depth)
  if (typeof value === 'object') {
    const result = {}
    for (const [key, v] of Object.entries(value)) result[key] = toClonable(v, depth + 1)
    return result
  }

  return String(value)
}

module.exports = { prometheus, NAME, VERSION }
