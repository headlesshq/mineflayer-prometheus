'use strict'

/**
 * Renders what the bot sees with prismarine-viewer, the renderer of PrismarineJS, headless with WebGL from headless-gl.
 * Frames are only rendered while someone requests screenshots, at most one per interval, all viewers share it.
 *
 * Needs the optional dependencies prismarine-viewer, three and node-canvas-webgl (with its native canvas and gl),
 * and on Linux a display, e.g. xvfb-run. If they are missing, the bot works and the screenshots explain why.
 */
class Renderer {
  /**
   * @param bot the mineflayer bot.
   * @param {{width: number, height: number, viewDistance: number, intervalMs: number, renderWaitMs: number}} options
   * @param {() => void} onFrame called for every rendered frame, for the FPS.
   */
  constructor (bot, options, onFrame = () => {}) {
    this.bot = bot
    this.options = options
    this.onFrame = onFrame
    this.error = 'The bot has not spawned yet, so nothing is rendered'
    this.started = false
    this.cache = {} // the latest frame per format, shared by all viewers
    this.cleanup = []
  }

  isAvailable () {
    return this.started && !this.error
  }

  /**
   * Sets up the renderer, once the bot has spawned.
   */
  start () {
    if (this.started) return
    this.started = true
    try {
      this._start()
      this.error = null
    } catch (e) {
      this.error = describeError(e)
    }
  }

  _start () {
    const bot = this.bot
    // prismarine-viewer expects these globals, like in a browser
    if (!global.THREE) global.THREE = require('three')
    const THREE = global.THREE
    if (!global.Worker) global.Worker = require('worker_threads').Worker
    const { createCanvas } = require('node-canvas-webgl/lib')
    const { Viewer, WorldView } = require('prismarine-viewer/viewer')

    const { width, height, viewDistance } = this.options
    this.canvas = createCanvas(width, height)
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas })
    } catch (e) {
      throw new Error('Failed to create a WebGL context, on Linux run the bot with a display, e.g. xvfb-run: ' + e.message)
    }

    this.viewer = new Viewer(this.renderer)
    // the meshing workers of the viewer must not keep the process alive
    for (const worker of this.viewer.world.workers) if (worker.unref) worker.unref()
    if (!this.viewer.setVersion(bot.version)) {
      throw new Error(`prismarine-viewer does not support Minecraft ${bot.version}`)
    }

    // prismarine-viewer logs every entity it has no model for, e.g. dropped items, with console.log and draws a box,
    // or throws, which would end up in the bot. Neither is worth a line in the log of the bot.
    const updateEntity = this.viewer.updateEntity.bind(this.viewer)
    this.viewer.updateEntity = entity => {
      const log = console.log
      console.log = () => {}
      try {
        updateEntity(entity)
      } catch (e) {
        // not rendered
      } finally {
        console.log = log
      }
    }

    this.worldView = new WorldView(bot.world, viewDistance, bot.entity.position)
    this.viewer.listen(this.worldView)
    this.lastChunkAt = Date.now()
    this.worldView.on('loadChunk', () => { this.lastChunkAt = Date.now() })
    this.worldView.init(bot.entity.position)
    this.worldView.listenToBot(bot)
    // only loads the chunks around the bot, the camera is placed when a frame is rendered, see _capture
    const onMove = () => this.worldView.updatePosition(bot.entity.position)

    onMove()
    bot.on('move', onMove)
    this.cleanup.push(() => bot.removeListener('move', onMove))
    this.cleanup.push(() => this.worldView.removeListenersFromBot(bot))
  }

  /**
   * Returns the latest frame, or renders a new one if the latest is older than maxAgeMs.
   * Screenshots are PNGs that wait until the world around the bot is meshed, live frames are JPEGs, which are encoded
   * five times faster, and only wait for the world before the first frame, so that a stream does not stall while the bot
   * walks into new chunks.
   *
   * @param {{format?: 'png'|'jpeg', maxAgeMs?: number, live?: boolean}} [request]
   * @returns {Promise<Buffer>}
   */
  get ({ format = 'png', maxAgeMs = this.options.intervalMs, live = false } = {}) {
    if (!this.isAvailable()) return Promise.reject(new Error(this.error || 'Not rendering'))
    const now = Date.now()
    const cached = this.cache[format]
    if (cached && (cached.pending || now - cached.takenAt < maxAgeMs)) return cached.promise

    const frame = { pending: true, takenAt: now }
    frame.promise = this._capture(format, live).finally(() => { frame.pending = false })
    this.cache[format] = frame
    return frame.promise
  }

  async _capture (format, live) {
    // the chunks are loaded into the viewer one by one and meshed by workers, e.g. right after spawning or when the bot
    // walks into new chunks, wait until that is done, but not forever
    const until = Date.now() + this.options.renderWaitMs
    while (!(live && this.rendered ? true : this._isWorldReady()) && Date.now() < until) await sleep(50)

    return new Promise((resolve, reject) => {
      try {
        // moves the entities of the viewer
        this.viewer.update()
        // Viewer.setFirstPersonCamera tweens the camera, which only moves on the next updates, so it would render from
        // where the camera was before, set it directly instead
        const entity = this.bot.entity
        const camera = this.viewer.camera
        camera.position.set(entity.position.x, entity.position.y + (this.bot.getControlState('sneak') ? 1.27 : 1.62), entity.position.z)
        camera.rotation.set(entity.pitch, entity.yaw, 0, 'ZYX')
        this.renderer.render(this.viewer.scene, camera)
        this.rendered = true
        this.onFrame()
        // encoding runs on the thread pool, it does not block the bot
        const callback = (err, buffer) => err ? reject(err) : resolve(buffer)
        if (format === 'jpeg') this.canvas.toBuffer(callback, 'image/jpeg', { quality: 0.8 })
        else this.canvas.toBuffer(callback, 'image/png')
      } catch (e) {
        reject(e)
      }
    })
  }

  /**
   * @returns true if the chunk of the bot has been loaded, no chunk arrived for a moment and every section is meshed.
   */
  _isWorldReady () {
    const world = this.viewer.world
    const position = this.bot.entity.position
    const column = `${Math.floor(position.x / 16) * 16},${Math.floor(position.z / 16) * 16}`
    return !!world.loadedChunks[column] && world.sectionsOutstanding.size === 0 && Date.now() - this.lastChunkAt > 300
  }

  close () {
    for (const fn of this.cleanup.splice(0)) {
      try {
        fn()
      } catch (e) {
        // already gone
      }
    }

    if (this.viewer) {
      for (const worker of this.viewer.world.workers) worker.terminate()
    }

    this.error = 'The bot has disconnected'
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function describeError (e) {
  const message = e && e.message ? e.message : String(e)
  if (e && e.code === 'MODULE_NOT_FOUND') {
    return 'Rendering needs prismarine-viewer, three and node-canvas-webgl: ' + message.split('\n')[0]
  }

  return message.startsWith('Failed') ? message : 'Failed to start rendering: ' + message
}

module.exports = { Renderer }
