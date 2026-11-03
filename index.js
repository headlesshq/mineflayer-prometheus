'use strict'

const { prometheus } = require('./lib/plugin')
const { MetricsService } = require('./lib/metrics/service')
const { MetricsConverter } = require('./lib/exporter/converter')
const { Exposition } = require('./lib/exporter/exposition')
const { DEFAULTS } = require('./lib/config')

module.exports = {
  /** Creates the plugin with options: bot.loadPlugin(prometheus({ render: true })). */
  prometheus,
  /** The plugin with the default options: bot.loadPlugin(plugin). */
  plugin: prometheus(),
  MetricsService,
  MetricsConverter,
  Exposition,
  DEFAULTS
}
