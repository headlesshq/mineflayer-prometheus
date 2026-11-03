'use strict'

/**
 * Writes the Prometheus text exposition format (version 0.0.4), like the Prometheus Java client does for HMC-Prometheus:
 * info metrics are gauges with the suffix _info and the value 1, counters get the suffix _total.
 */
class Exposition {
  constructor () {
    /** @type {Map<string, {name: string, type: string, help: string, samples: string[]}>} */
    this.families = new Map()
  }

  /**
   * @param {string} name the name of the family, as it appears in # TYPE, e.g. hmc_server_brand_info.
   * @param {string} type gauge, counter or summary.
   */
  family (name, type, help) {
    let family = this.families.get(name)
    if (!family) {
      family = { name, type, help, samples: [] }
      this.families.set(name, family)
    }

    return family
  }

  gauge (name, help, value, labels) {
    this.family(name, 'gauge', help).samples.push(sample(name, labels, value))
  }

  info (name, help, labels) {
    this.family(name + '_info', 'gauge', help).samples.push(sample(name + '_info', labels, 1))
  }

  counter (name, help, value, labels) {
    this.family(name + '_total', 'counter', help).samples.push(sample(name + '_total', labels, value))
  }

  summary (name, help, count, sum, labels) {
    const family = this.family(name, 'summary', help)
    family.samples.push(sample(name + '_count', labels, count))
    family.samples.push(sample(name + '_sum', labels, sum))
  }

  toString () {
    let result = ''
    for (const family of this.families.values()) {
      if (family.samples.length === 0) continue
      result += `# HELP ${family.name} ${escapeHelp(family.help || '')}\n# TYPE ${family.name} ${family.type}\n`
      result += family.samples.join('')
    }

    return result
  }
}

function sample (name, labels, value) {
  const entries = labels ? Object.entries(labels) : []
  const labelString = entries.length === 0
    ? ''
    : '{' + entries.map(([k, v]) => `${k}="${escapeLabelValue(String(v))}"`).join(',') + '}'
  return `${name}${labelString} ${formatValue(value)}\n`
}

function formatValue (value) {
  if (value === Infinity) return '+Inf'
  if (value === -Infinity) return '-Inf'
  if (Number.isNaN(value)) return 'NaN'
  return String(value)
}

function escapeLabelValue (value) {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function escapeHelp (value) {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

module.exports = { Exposition, CONTENT_TYPE: 'text/plain; version=0.0.4; charset=utf-8' }
