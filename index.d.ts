import type { Bot, BotOptions } from 'mineflayer'

export interface PrometheusOptions {
  /** Start the exporter with the bot. Default true. */
  enabled?: boolean
  /** Value of the client label. Defaults to the username of the bot. */
  client?: string
  /** Address to bind to. Default 127.0.0.1. */
  host?: string
  /** First port to try. Default 9400. */
  port?: number
  /** How many following ports to try. Default 100. */
  portRange?: number
  /** Metrics to export, by name, group or last part. All if empty. */
  include?: string[] | string
  /** Metrics not to export. Default ['jvm']. */
  exclude?: string[] | string
  /** Export the runtime metrics of Node.js as jvm_* and process_*. Default true. */
  jvmMetrics?: boolean
  /** How long a scrape waits for the main thread. Default 2000. */
  collectTimeoutMs?: number
  /** Directory for the Prometheus discovery files, empty to disable. Default ~/.hmc-prometheus/targets. */
  discoveryDir?: string
  /** Address written to the discovery file. Defaults to host. */
  discoveryAddress?: string
  /** Used for the dashboard link in the status. Default http://localhost:3000. */
  grafanaUrl?: string
  /** Base URL of Loki to push the log to, e.g. http://127.0.0.1:3100. Disabled by default. */
  lokiUrl?: string
  /** Also push everything written with console.* to Loki. Default false. */
  captureConsole?: boolean
  /** Render with prismarine-viewer and serve /screenshot.png and /live. Default false. */
  render?: boolean
  /** Minimum time between two screenshots. Default 1000. */
  screenshotIntervalMs?: number
  /** Frames per second of /live. Default 10. */
  liveFps?: number
  /** Default 854. */
  renderWidth?: number
  /** Default 480. */
  renderHeight?: number
  /** View distance of the renderer in chunks. Default 6. */
  viewDistance?: number
  /** How long a screenshot waits for chunks that are still being meshed. Default 5000. */
  renderWaitMs?: number
  /** Allow executing commands from the web console on /console. Default false. */
  console?: boolean
  /** Stop the exporter when the bot disconnects. Default true. */
  stopOnEnd?: boolean
  /** Commands for the web console. */
  commands?: Record<string, ((args: string[], bot: Bot) => unknown) | { description: string, run: (args: string[], bot: Bot) => unknown }>
}

export interface Metric {
  name: string
  description: string
  get: () => unknown
}

export class MetricsService {
  register (name: string, description: string, get: () => unknown): Metric | null
  unregister (name: string): Metric | null
  get (name: string): Metric | null
  getMetrics (): Metric[]
  select (...queries: string[]): Metric[]
  collect (metrics: Metric[]): Record<string, unknown>
}

export interface PrometheusApi {
  metrics: MetricsService
  config: Required<Omit<PrometheusOptions, 'include' | 'exclude'>> & { include: string[], exclude: string[] }
  start (): Promise<void>
  stop (): Promise<void>
  status (): string
  describeConfig (): string
  log (level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', logger: string, message: string): void
  isRunning (): boolean
  getUrl (): string | null
  getClient (): string | null
}

declare module 'mineflayer' {
  interface Bot {
    prometheus: PrometheusApi
  }
}

export function prometheus (options?: PrometheusOptions): (bot: Bot, options: BotOptions) => void
export const plugin: (bot: Bot, options: BotOptions) => void
export const DEFAULTS: Required<PrometheusOptions>
