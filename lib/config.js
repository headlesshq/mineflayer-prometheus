'use strict'

const os = require('os')
const path = require('path')

/**
 * The options of mineflayer-prometheus, with the same names and defaults as in HMC-Prometheus where they apply.
 * Every option can also be set with an environment variable, e.g. MINEFLAYER_PROMETHEUS_LOKI_URL for lokiUrl,
 * which overrides the option passed in code, so that scripts can configure bots without changing them.
 */
const DEFAULTS = {
  enabled: true,
  client: '',
  host: '127.0.0.1',
  port: 9400,
  portRange: 100,
  include: [],
  exclude: ['jvm'],
  jvmMetrics: true,
  collectTimeoutMs: 2000,
  discoveryDir: path.join(os.homedir(), '.hmc-prometheus', 'targets'),
  discoveryAddress: '',
  grafanaUrl: 'http://localhost:3000',
  lokiUrl: '',
  captureConsole: false,
  render: false,
  screenshotIntervalMs: 1000,
  liveFps: 10,
  renderWidth: 854,
  renderHeight: 480,
  viewDistance: 6,
  renderWaitMs: 5000,
  console: false,
  stopOnEnd: true
}

const DESCRIPTIONS = {
  enabled: 'Start the exporter with the bot.',
  client: 'Value of the client label, identifies this bot in Grafana. Defaults to the username of the bot.',
  host: 'Address to bind to. Use 0.0.0.0 if Prometheus runs on another machine.',
  port: 'First port to try.',
  portRange: 'How many following ports to try, if the port is in use.',
  include: 'Metrics to export, by name, group or last part. All if empty.',
  exclude: 'Metrics not to export. The jvm group is covered by the jvm_* and process_* metrics.',
  jvmMetrics: 'Export the runtime metrics of Node.js as jvm_* and process_* metrics, like the Prometheus Java client.',
  collectTimeoutMs: 'How long a scrape waits for the main thread.',
  discoveryDir: 'Directory for the Prometheus discovery files, empty to disable.',
  discoveryAddress: 'Address written to the discovery file, e.g. host.docker.internal. Defaults to host.',
  grafanaUrl: 'Used by the prometheus command to print a link to the dashboard of this bot.',
  lokiUrl: 'Base URL of Loki to push the log to, e.g. http://127.0.0.1:3100.',
  captureConsole: 'Also push everything written with console.* to Loki.',
  render: 'Render the game with prismarine-viewer and serve it on /screenshot.png and /live.',
  screenshotIntervalMs: 'Minimum time between two screenshots.',
  liveFps: 'Frames per second of /live, each frame takes about 40ms of the main thread of the bot.',
  renderWidth: 'Width of the screenshots.',
  renderHeight: 'Height of the screenshots.',
  viewDistance: 'View distance of the renderer in chunks.',
  renderWaitMs: 'How long a screenshot waits for chunks that are still being meshed.',
  console: 'Allow executing commands from the web console on /console.',
  stopOnEnd: 'Stop the exporter when the bot disconnects, so that a reconnecting bot can take over its client name.'
}

function resolveConfig (options = {}, env = process.env) {
  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (options[key] !== undefined) config[key] = options[key]
    const envValue = env['MINEFLAYER_PROMETHEUS_' + key.replace(/([A-Z])/g, '_$1').toUpperCase()]
    if (envValue !== undefined) config[key] = parse(key, envValue)
  }

  for (const key of ['include', 'exclude']) {
    if (typeof config[key] === 'string') config[key] = parse(key, config[key])
  }

  config.commands = options.commands || {}
  return config
}

function parse (key, value) {
  const type = Array.isArray(DEFAULTS[key]) ? 'array' : typeof DEFAULTS[key]
  switch (type) {
    case 'array':
      return value.split(',').map(s => s.trim()).filter(Boolean)
    case 'boolean':
      return value === 'true' || value === '1'
    case 'number': {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error(`Invalid value '${value}' for ${key}, expected a number`)
      return number
    }
    default:
      return value
  }
}

module.exports = { DEFAULTS, DESCRIPTIONS, resolveConfig }
