'use strict'

/**
 * A registry for metrics, like the MetricsService of HMC-Specifics.
 * A metric has a dotted name, e.g. server.tps, a description and a function that returns its value:
 * a number, boolean, string, a map (plain object) of values, a list of maps, or null if there is no value.
 * Each bot has its own service, so that other plugins can register their own metrics on bot.prometheus.metrics.
 */
class MetricsService {
  constructor () {
    /** @type {Map<string, {name: string, description: string, get: () => any}>} */
    this.metrics = new Map()
  }

  /**
   * Registers a metric, replacing any metric with the same name.
   *
   * @param {string} name e.g. pathfinder.goals
   * @param {string} description
   * @param {() => any} get called on every scrape
   */
  register (name, description, get) {
    const previous = this.metrics.get(name)
    this.metrics.set(name, { name, description, get })
    return previous || null
  }

  unregister (name) {
    const previous = this.metrics.get(name)
    this.metrics.delete(name)
    return previous || null
  }

  get (name) {
    return this.metrics.get(name) || null
  }

  /** @returns all metrics, in the order they have been registered in. */
  getMetrics () {
    return [...this.metrics.values()]
  }

  /**
   * Selects metrics, a query matches, ignoring case, the full name of a metric (server.tps),
   * a group (server for all server.* metrics) or the last part of the name (tps for server.tps).
   *
   * @param {...string} queries if none are given, all metrics are returned.
   * @throws if a query does not match any metric.
   */
  select (...queries) {
    const all = this.getMetrics()
    if (queries.length === 0) return all
    const result = new Set()
    for (const query of queries) {
      const matches = selectQuery(all, query)
      if (matches.length === 0) throw new Error(`Unknown metric '${query}'. Use 'metrics --list' to list all metrics.`)
      matches.forEach(m => result.add(m))
    }

    return [...result]
  }

  /**
   * Gets the values of the given metrics. Errors thrown by a metric are logged and its value will be null.
   *
   * @returns {Object<string, any>} from the name of each metric to its value.
   */
  collect (metrics, onError = defaultOnError) {
    const result = {}
    for (const metric of metrics) {
      let value
      try {
        value = metric.get()
      } catch (e) {
        onError(metric, e)
        value = null
      }

      result[metric.name] = value === undefined ? null : value
    }

    return result
  }
}

function selectQuery (metrics, query) {
  const lower = query.toLowerCase()
  const exact = metrics.find(m => m.name.toLowerCase() === lower)
  if (exact) return [exact]
  return metrics.filter(m => {
    const name = m.name.toLowerCase()
    return name.startsWith(lower + '.') || name.endsWith('.' + lower)
  })
}

const warned = new Set()
function defaultOnError (metric, e) {
  if (!warned.has(metric.name)) {
    warned.add(metric.name)
    console.warn(`[mineflayer-prometheus] Failed to collect metric ${metric.name}:`, e)
  }
}

module.exports = { MetricsService }
