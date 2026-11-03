'use strict'

const os = require('os')
const runtime = require('./runtime')

/**
 * The metrics of HMC-Specifics (DefaultMetrics), with the same names, descriptions, units and value shapes,
 * but read from a mineflayer bot. Values that a bot does not have are null and therefore not exported,
 * e.g. client.fps without rendering or server.integrated, because a bot can't play singleplayer.
 */

const MB = 1024 * 1024
const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator']

function registerAll (service, source, tracker) {
  registerJvm(service)
  registerClient(service, source, tracker)
  registerServer(service, source, tracker)
  registerPlayers(service, source)
  registerWorld(service, source)
  registerPlayer(service, source)
}

/**
 * The jvm group of HMC-Specifics, with the values of Node.js. Excluded by default, like in HMC-Prometheus,
 * because the jvm_* and process_* metrics cover them.
 */
function registerJvm (service) {
  service.register('jvm.memory', 'Heap memory used, free, total and max in MB.', () => {
    const heap = runtime.heap()
    return {
      used: Math.floor(heap.used / MB),
      free: Math.floor((heap.committed - heap.used) / MB),
      total: Math.floor(heap.committed / MB),
      max: Math.floor(heap.max / MB),
      percent: heap.used * 100 / heap.max
    }
  })
  service.register('jvm.gc', 'Collections and total collection time in ms per garbage collector.',
    () => runtime.gc().map(gc => ({ name: gc.name, count: gc.count, time: Math.round(gc.seconds * 1000) })))
  service.register('jvm.threads', 'Live, peak and daemon threads.', () => {
    const threads = runtime.threads()
    return threads == null ? null : { live: threads.live, peak: threads.peak, daemon: 0 }
  })
  service.register('jvm.cpu', 'CPU load of this process and of the system in percent.', () => runtime.cpuLoad())
  service.register('jvm.uptime', 'Uptime of the JVM in seconds.', () => Math.floor(process.uptime()))
  service.register('jvm.processors', 'Processors available to the JVM.',
    () => typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length)
}

function registerClient (service, source, tracker) {
  service.register('client.version', 'The Minecraft version of the client.', () => source.getMinecraftVersion())
  service.register('client.fps', 'Frames per second.', () => source.getFps())
  service.register('client.mspt', 'Average and max milliseconds per client tick over the last 100 ticks.', () => {
    const avg = tracker.getAverageTickTime()
    return avg == null ? null : { avg, max: tracker.getMaxTickTime() }
  })
}

function registerServer (service, source, tracker) {
  service.register('server.connected', 'Whether the client is in a world.', () => source.isInWorld())
  service.register('server.address', 'The address of the server.', inWorld(source, s => s.getServerAddress()))
  service.register('server.singleplayer', 'Whether the client plays on its integrated server.', inWorld(source, () => false))
  service.register('server.brand', 'The brand of the server.', inWorld(source, s => s.getServerBrand()))
  service.register('server.ping', 'Our latency in ms, as reported by the server.', inWorld(source, s => s.getPing()))
  service.register('server.tps', 'Server TPS, estimated from the game time the server sends every second.',
    inWorld(source, s => tracker.getTps(s.getTickRate())))
  service.register('server.tickrate', 'Tick rate of the server and if it is frozen, since 1.20.3.', inWorld(source, s => {
    const rate = s.getTickRate()
    return rate == null ? null : { rate, frozen: s.isTickingFrozen() }
  }))
  // a bot never runs an integrated server, so this is always null and left out
  service.register('server.integrated', 'TPS and milliseconds per tick of the integrated server.', () => null)
  service.register('server.packets', 'Packets received and sent per second.', inWorld(source, () => ({
    in: tracker.getPacketsReceivedPerSecond(),
    out: tracker.getPacketsSentPerSecond()
  })))
  service.register('server.lastpacket', 'Milliseconds since the last packet has been received.',
    inWorld(source, () => tracker.getMillisSinceLastPacket()))
  service.register('server.session', 'Seconds since joining the world.', inWorld(source, () => tracker.getSecondsSinceJoin()))
}

function registerPlayers (service, source) {
  service.register('players.count', 'Amount of players in the tab list.', inWorld(source, s => s.getPlayerList().length))
  service.register('players.list', 'Name, uuid, ping and game mode of the players in the tab list.',
    inWorld(source, s => s.getPlayerList()))
  service.register('players.ping', 'Min, average and max ping of the players in the tab list.', inWorld(source, s => {
    const players = s.getPlayerList()
    if (players.length === 0) return null
    const pings = players.map(p => p.ping)
    return {
      min: Math.min(...pings),
      avg: pings.reduce((a, b) => a + b, 0) / pings.length,
      max: Math.max(...pings)
    }
  }))
}

function registerWorld (service, source) {
  service.register('world.dimension', 'The dimension the player is in.', inWorld(source, s => s.getDimension()))
  service.register('world.time', 'Game time and day time of the world.', inWorld(source, s => {
    const game = s.getGameTime()
    return game == null ? null : { game, day: s.getDayTime() }
  }))
  service.register('world.weather', 'The weather, clear, rain or thunder.', inWorld(source, s => {
    const raining = s.isRaining()
    if (raining == null) return null
    return s.isThundering() ? 'thunder' : raining ? 'rain' : 'clear'
  }))
  service.register('world.difficulty', 'The difficulty of the world.', inWorld(source, s => s.getDifficulty()))
  service.register('world.chunks', 'Amount of chunks loaded by the client.', inWorld(source, s => s.getLoadedChunks()))
  service.register('world.entities', 'Amount of entities loaded by the client.', inWorld(source, s => s.getEntityCount()))
}

function registerPlayer (service, source) {
  service.register('player.name', 'The name of the player.', inWorld(source, s => s.getPlayerName()))
  service.register('player.position', 'Position and rotation of the player.', inWorld(source, s => s.getPlayerPosition()))
  service.register('player.health', 'Health of the player.', inWorld(source, s => s.getHealth()))
  service.register('player.food', 'Food level and saturation of the player.', inWorld(source, s => {
    const food = s.getFood()
    return food == null ? null : { food, saturation: s.getSaturation() }
  }))
  service.register('player.xp', 'Experience level of the player.', inWorld(source, s => s.getXpLevel()))
  service.register('player.gamemode', 'Game mode of the player.', inWorld(source, s => s.getGameMode()))
  service.register('player.dead', 'Whether the player is dead.', inWorld(source, s => s.isDead()))
}

function inWorld (source, fn) {
  return () => source.isInWorld() ? fn(source) : null
}

/**
 * Reads the values of the default metrics from a mineflayer bot, like the version specific MetricsSources of HMC-Specifics.
 */
class BotMetricsSource {
  /**
   * @param bot the mineflayer bot.
   * @param options the options the bot has been created with, for the server address.
   * @param tracker the tracker of the bot.
   * @param getRenderer returns the renderer, or null if the bot does not render.
   */
  constructor (bot, options, tracker, getRenderer) {
    this.bot = bot
    this.options = options || {}
    this.tracker = tracker
    this.getRenderer = getRenderer
    this.spawned = false
    this.tickRate = null
    this.tickingFrozen = null
  }

  getMinecraftVersion () {
    return this.bot.version || null
  }

  getFps () {
    const renderer = this.getRenderer()
    return renderer && renderer.isAvailable() ? this.tracker.getFramesPerSecond() : null
  }

  isInWorld () {
    return this.spawned && !!this.bot.entity
  }

  getServerAddress () {
    const host = this.options.host || 'localhost'
    const port = this.options.port || 25565
    return port === 25565 || port === '25565' ? host : host + ':' + port
  }

  getServerBrand () {
    return this.bot.game ? this.bot.game.serverBrand || null : null
  }

  getPing () {
    return this.bot.player && typeof this.bot.player.ping === 'number' ? this.bot.player.ping : null
  }

  /** @returns the tick rate of the server, since 1.20.3, otherwise null like in HMC-Specifics. */
  getTickRate () {
    if (this.tickRate != null) return this.tickRate
    return this.supportsTickRate() ? 20 : null
  }

  isTickingFrozen () {
    return this.tickingFrozen == null ? (this.supportsTickRate() ? false : null) : this.tickingFrozen
  }

  supportsTickRate () {
    try {
      return !!this.bot.registry && this.bot.registry.version['>=']('1.20.3')
    } catch (e) {
      return false
    }
  }

  getPlayerList () {
    const players = []
    for (const player of Object.values(this.bot.players || {})) {
      if (!player || player.listed === false) continue
      players.push({
        name: player.username,
        uuid: player.uuid || null,
        ping: typeof player.ping === 'number' ? player.ping : 0,
        gamemode: typeof player.gamemode === 'number' ? GAME_MODES[player.gamemode & 3] : null
      })
    }

    return players
  }

  getDimension () {
    const dimension = this.bot.game && this.bot.game.dimension
    if (!dimension) return null
    // mineflayer strips the namespace, Minecraft 1.16+ and HMC-Specifics include it
    return dimension.includes(':') ? dimension : 'minecraft:' + dimension
  }

  getGameTime () {
    const time = this.bot.time
    return time && time.age != null ? Number(time.age) : null
  }

  getDayTime () {
    const time = this.bot.time
    return time && time.time != null ? Number(time.time) : null
  }

  isRaining () {
    return typeof this.bot.isRaining === 'boolean' ? this.bot.isRaining : null
  }

  isThundering () {
    return this.bot.thunderState > 0
  }

  getDifficulty () {
    if (this.difficulty) return this.difficulty
    return this.bot.game ? this.bot.game.difficulty || null : null
  }

  getLoadedChunks () {
    const world = this.bot.world
    if (!world) return null
    if (typeof world.getColumns === 'function') return world.getColumns().length
    return world.async && world.async.columns ? Object.keys(world.async.columns).length : null
  }

  getEntityCount () {
    return this.bot.entities ? Object.keys(this.bot.entities).length : null
  }

  getPlayerName () {
    return this.bot.username || null
  }

  /** @returns the position and the rotation in degrees, converted to Minecraft's convention. */
  getPlayerPosition () {
    const entity = this.bot.entity
    if (!entity || !entity.position) return null
    return {
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      yaw: wrapDegrees((Math.PI - entity.yaw) * 180 / Math.PI),
      pitch: -entity.pitch * 180 / Math.PI
    }
  }

  getHealth () {
    return typeof this.bot.health === 'number' ? this.bot.health : null
  }

  getFood () {
    return typeof this.bot.food === 'number' ? this.bot.food : null
  }

  getSaturation () {
    return typeof this.bot.foodSaturation === 'number' ? this.bot.foodSaturation : null
  }

  getXpLevel () {
    return this.bot.experience ? this.bot.experience.level : null
  }

  getGameMode () {
    return this.bot.game ? this.bot.game.gameMode || null : null
  }

  isDead () {
    return this.bot.isAlive === false || (typeof this.bot.health === 'number' && this.bot.health <= 0)
  }
}

function wrapDegrees (degrees) {
  const wrapped = ((degrees % 360) + 360) % 360
  return wrapped >= 180 ? wrapped - 360 : wrapped
}

module.exports = { registerAll, BotMetricsSource }
