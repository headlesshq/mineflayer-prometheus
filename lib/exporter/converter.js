'use strict'

/**
 * Converts the values of metrics into Prometheus metrics, exactly like the MetricsConverter of HMC-Prometheus.
 * Every metric gets the prefix hmc_, dots become underscores, e.g. server.tps becomes hmc_server_tps.
 * - Numbers and booleans (as 0 and 1) become gauges.
 * - Strings become info metrics with the string as the value label, e.g. hmc_server_brand_info{value="Paper"} 1.
 * - Maps are flattened, e.g. client.mspt = {avg, max} becomes hmc_client_mspt_avg and hmc_client_mspt_max.
 * - Lists of maps become one series per element, the strings of an element become its labels,
 *   e.g. players.list becomes hmc_players_list_ping{name="...", uuid="...", gamemode="..."}.
 * Values that are null, e.g. because the bot is not in a world, are left out.
 */

const PREFIX = 'hmc_'
const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/
// the Prometheus Java client rejects these suffixes for gauges and infos
const RESERVED_SUFFIXES = ['_total', '_created', '_bucket', '_info']

class MetricsConverter {
  /**
   * @param {Object<string, string>} constLabels labels for every data point, e.g. {client: 'bot-1'}.
   * @param {(name: string, error: Error) => void} warn called once per metric that can't be exported.
   */
  constructor (constLabels, warn = () => {}) {
    this.constLabels = constLabels
    this.warnFn = warn
    /** @type {Map<string, {help: string, points: {labels: object, value: number}[]}>} */
    this.gauges = new Map()
    /** @type {Map<string, {help: string, points: {labels: object}[]}>} */
    this.infos = new Map()
    this.dataPoints = new Map()
    this.warned = new Set()
  }

  /**
   * Adds a metric, e.g. add('server.tps', 'Server TPS', 19.9).
   */
  add (name, help, value) {
    this._add(PREFIX + sanitize(name), help, value, {})
  }

  gauge (name, help, value) {
    this._addGauge(name, help, value, {})
  }

  info (name, help, labels) {
    this._addInfo(name, help, labels)
  }

  /**
   * Writes the metrics into an Exposition, gauges first, then infos, like HMC-Prometheus.
   */
  writeTo (exposition) {
    for (const [name, gauge] of this.gauges) {
      for (const point of gauge.points) exposition.gauge(name, gauge.help, point.value, point.labels)
    }

    for (const [name, info] of this.infos) {
      for (const point of info.points) exposition.info(name, info.help, point.labels)
    }
  }

  _add (name, help, value, labels) {
    if (value == null) return
    if (typeof value === 'number' || typeof value === 'bigint') {
      this._addGauge(name, help, Number(value), labels)
    } else if (typeof value === 'boolean') {
      this._addGauge(name, help, value ? 1 : 0, labels)
    } else if (Array.isArray(value)) {
      for (const element of value) this._addListElement(name, help, element, labels)
    } else if (typeof value === 'object' && !(value instanceof Date)) {
      for (const [key, entry] of Object.entries(value)) this._add(name + '_' + sanitize(key), help, entry, labels)
    } else {
      this._addInfo(name, help, addLabel(labels, 'value', String(value)))
    }
  }

  /**
   * The scalar values of a map in a list identify the element, so they become labels.
   * If the element does not contain any numbers it becomes an info metric.
   */
  _addListElement (name, help, element, labels) {
    if (element != null && typeof element === 'object' && !Array.isArray(element)) {
      let elementLabels = labels
      const values = []
      for (const [rawKey, value] of Object.entries(element)) {
        const key = this._sanitizeLabel(rawKey)
        if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' ||
            (value != null && typeof value === 'object')) {
          values.push([key, value])
        } else {
          elementLabels = addLabel(elementLabels, key, value == null ? '' : String(value))
        }
      }

      if (values.length === 0) {
        this._addInfo(name, help, elementLabels)
      } else {
        for (const [key, value] of values) this._add(name + '_' + key, help, value, elementLabels)
      }
    } else if (element != null && typeof element !== 'number' && typeof element !== 'boolean') {
      this._addInfo(name, help, addLabel(labels, 'value', String(element)))
    }
  }

  _addGauge (name, help, value, labels) {
    if (this.infos.has(name) || !this._isNewDataPoint(name, labels)) return
    try {
      validateName(name)
      const merged = this._merge(labels)
      let gauge = this.gauges.get(name)
      if (!gauge) {
        gauge = { help, points: [] }
        this.gauges.set(name, gauge)
      }

      gauge.points.push({ labels: merged, value })
    } catch (e) {
      this._warn(name, e)
    }
  }

  _addInfo (name, help, labels) {
    if (this.gauges.has(name) || !this._isNewDataPoint(name, labels)) return
    try {
      validateName(name)
      const merged = this._merge(labels)
      let info = this.infos.get(name)
      if (!info) {
        info = { help, points: [] }
        this.infos.set(name, info)
      }

      info.points.push({ labels: merged })
    } catch (e) {
      this._warn(name, e)
    }
  }

  /** Prometheus does not allow two data points with the same labels, e.g. two players with the same name. */
  _isNewDataPoint (name, labels) {
    let set = this.dataPoints.get(name)
    if (!set) {
      set = new Set()
      this.dataPoints.set(name, set)
    }

    const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    if (set.has(key)) return false
    set.add(key)
    return true
  }

  _merge (labels) {
    const result = { ...this.constLabels }
    for (const [key, value] of Object.entries(labels)) {
      if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error('Duplicate label name ' + key)
      result[key] = value
    }

    return sortLabels(result)
  }

  /** The client label is added to every metric, so a label with the same name gets renamed, like Prometheus would. */
  _sanitizeLabel (name) {
    const label = sanitizeLabelName(sanitize(name))
    return Object.prototype.hasOwnProperty.call(this.constLabels, label) ? 'exported_' + label : label
  }

  _warn (name, e) {
    if (!this.warned.has(name)) {
      this.warned.add(name)
      this.warnFn(name, e)
    }
  }
}

function addLabel (labels, key, value) {
  if (Object.prototype.hasOwnProperty.call(labels, key)) throw new Error('Duplicate label name ' + key)
  return { ...labels, [key]: value }
}

function sortLabels (labels) {
  const result = {}
  for (const key of Object.keys(labels).sort()) result[key] = labels[key]
  return result
}

function validateName (name) {
  if (!NAME.test(name)) throw new Error(`'${name}' is not a valid metric name`)
  for (const suffix of RESERVED_SUFFIXES) {
    if (name.endsWith(suffix)) throw new Error(`'${name}': the suffix ${suffix} is reserved`)
  }
}

function sanitize (name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, '_')
}

function sanitizeLabelName (name) {
  let result = name.replace(/[^a-zA-Z0-9_]/g, '_')
  if (/^[0-9]/.test(result)) result = '_' + result
  while (result.startsWith('__')) result = result.substring(1) // reserved for Prometheus
  return LABEL.test(result) ? result : '_'
}

module.exports = { MetricsConverter, sanitize }
