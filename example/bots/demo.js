'use strict'

/**
 * Demo bots for the dashboards, like the demo clients of hmc-prometheus:
 * - Walker wanders around and sprints,
 * - Watcher stands at spawn, looks at the nearest entity and chats about the time and weather,
 * - Laggy does expensive work every tick and blocks its event loop for 8 seconds every two minutes,
 *   so that its main thread latency and hmc_collect_success show it.
 * Each bot runs in its own process. All of them render what they see, have the web console enabled and push their log to Loki.
 *
 * Environment: MC_HOST, MC_PORT, MC_VERSION, BOTS (comma separated names), RENDER (false to disable), LOKI_URL.
 */

const mineflayer = require('mineflayer')
let mineflayerPrometheus
try {
  mineflayerPrometheus = require('@headlesshq/mineflayer-prometheus')
} catch (e) {
  mineflayerPrometheus = require('../..') // running from the repository
}
const { prometheus } = mineflayerPrometheus

const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const VERSION = process.env.MC_VERSION || '1.21.4'
const NAMES = (process.env.BOTS || 'Walker,Watcher,Laggy').split(',').map(s => s.trim()).filter(Boolean)
const RENDER = process.env.RENDER !== 'false'
const LOKI_URL = process.env.LOKI_URL === undefined ? 'http://127.0.0.1:3100' : process.env.LOKI_URL

const BEHAVIOURS = { Walker: walk, Watcher: watch, Laggy: lag }

function startBot (name) {
  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: name, version: VERSION })
  bot.loadPlugin(prometheus({ render: RENDER, console: true, lokiUrl: LOKI_URL }))
  const timers = []
  bot.every = (ms, fn) => timers.push(setInterval(() => { if (bot.entity) fn() }, ms))

  bot.once('spawn', () => {
    console.log(`${name} spawned at ${bot.entity.position}`)
    const behaviour = BEHAVIOURS[name] || walk
    behaviour(bot)
  })
  bot.on('error', e => console.error(`${name}: ${e.message}`))
  bot.on('kicked', reason => console.error(`${name} was kicked: ${JSON.stringify(reason)}`))
  bot.once('end', reason => {
    timers.forEach(clearInterval)
    console.log(`${name} disconnected (${reason}), reconnecting in 10s`)
    setTimeout(() => startBot(name), 10000)
  })
}

function walk (bot) {
  let stuckTicks = 0
  bot.every(4000, () => {
    bot.look(Math.random() * Math.PI * 2, 0, true)
    bot.setControlState('forward', true)
    bot.setControlState('sprint', Math.random() < 0.4)
  })
  bot.on('physicsTick', () => {
    // jump over obstacles, turn around if that does not help
    const v = bot.entity.velocity
    stuckTicks = bot.getControlState('forward') && Math.abs(v.x) + Math.abs(v.z) < 0.02 ? stuckTicks + 1 : 0
    bot.setControlState('jump', stuckTicks > 2 || bot.entity.isInWater)
    if (stuckTicks > 30) {
      bot.look(bot.entity.yaw + Math.PI * (0.5 + Math.random()), 0, true)
      stuckTicks = 0
    }
  })
  chatter(bot, ['Going for a walk', 'Nice view from here', 'Has anyone seen a village?'])
}

function watch (bot) {
  bot.every(250, () => {
    const entity = bot.nearestEntity(e => e !== bot.entity && e.position.distanceTo(bot.entity.position) < 32)
    if (entity) bot.lookAt(entity.position.offset(0, entity.height || 1.6, 0), true)
    else bot.look(bot.entity.yaw + 0.05, 0, true)
  })
  bot.every(2000, () => {
    bot.setControlState('jump', true)
    setTimeout(() => bot.setControlState('jump', false), 300)
  })
  bot.every(60000, () => {
    const day = bot.time.timeOfDay
    bot.chat(`It is ${day < 13000 ? 'day' : 'night'} (${day}) and ${bot.thunderState > 0 ? 'thundering' : bot.isRaining ? 'raining' : 'clear'}`)
  })
}

function lag (bot) {
  walk(bot)
  // expensive work every tick, up to 40ms, which shows up as client tick time
  bot.on('physicsTick', () => busy(5 + Math.random() * 35))
  bot.every(120000, () => {
    bot.chat('Freezing for 8 seconds...')
    setTimeout(() => busy(8000), 500)
  })
}

function chatter (bot, messages) {
  bot.every(75000 + Math.random() * 30000, () => bot.chat(messages[Math.floor(Math.random() * messages.length)]))
}

function busy (ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { /* block the event loop */ }
}

// every bot gets its own process, like separate Minecraft clients, so that Laggy only blocks itself
if (process.env.DEMO_BOT) {
  startBot(process.env.DEMO_BOT)
} else {
  const { fork } = require('child_process')
  const children = new Set()
  let stopping = false
  const run = name => {
    const child = fork(__filename, [], { env: { ...process.env, DEMO_BOT: name } })
    children.add(child)
    child.on('exit', code => {
      children.delete(child)
      if (stopping) {
        if (children.size === 0) process.exit(0)
        return
      }

      console.log(`${name} exited with ${code}, restarting in 10s`)
      setTimeout(() => run(name), 10000)
    })
  }

  // docker stop only signals this process, the bots have to delete their discovery files
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      stopping = true
      if (children.size === 0) process.exit(0)
      for (const child of children) child.kill(signal)
    })
  }

  NAMES.forEach((name, i) => setTimeout(() => run(name), i * 3000))
}
