'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { prometheus } = require('..')

/** Just enough of a mineflayer bot. */
function fakeBot () {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.write = () => {}
  bot.version = '1.21.4'
  bot.username = 'TestBot'
  bot.registry = { version: { '>=': () => true } }
  bot.game = { serverBrand: 'Paper', dimension: 'overworld', difficulty: 'normal', gameMode: 'survival' }
  bot.player = { ping: 42 }
  bot.players = {
    TestBot: { username: 'TestBot', uuid: 'u1', ping: 42, gamemode: 0 },
    Alex: { username: 'Alex', uuid: 'u2', ping: 80, gamemode: 1 }
  }
  bot.time = { age: 1000, time: 25000 }
  bot.isRaining = false
  bot.thunderState = 0
  bot.world = { getColumns: () => [1, 2, 3] }
  bot.entities = { 1: {}, 2: {} }
  bot.entity = { position: { x: 1, y: 64, z: -3, toString: () => '(1, 64, -3)' }, yaw: Math.PI, pitch: 0 }
  bot.health = 20
  bot.food = 18
  bot.foodSaturation = 5
  bot.experience = { level: 7 }
  bot.isAlive = true
  bot.chat = msg => { bot.lastChat = msg }
  bot.quit = () => {}
  return bot
}

async function scrape (url) {
  const response = await fetch(url)
  assert.strictEqual(response.status, 200)
  return response.text()
}

test('exports the metrics of hmc-prometheus', async t => {
  const discoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineflayer-prometheus-'))
  const bot = fakeBot()
  prometheus({ port: 19400, discoveryDir, console: true, collectTimeoutMs: 300 })(bot, { host: 'play.example.org' })
  await bot.prometheus.start()
  t.after(async () => {
    await bot.prometheus.stop()
    fs.rmSync(discoveryDir, { recursive: true, force: true })
  })

  bot.emit('login')
  bot.emit('spawn')
  bot._client.emit('difficulty', { difficulty: 'hard', difficultyLocked: false })
  const url = bot.prometheus.getUrl()
  const text = await scrape(url)
  for (const expected of [
    'hmc_client_version_info{client="TestBot",value="1.21.4"} 1',
    'hmc_server_connected{client="TestBot"} 1',
    'hmc_server_address_info{client="TestBot",value="play.example.org"} 1',
    'hmc_server_singleplayer{client="TestBot"} 0',
    'hmc_server_brand_info{client="TestBot",value="Paper"} 1',
    'hmc_server_ping{client="TestBot"} 42',
    'hmc_server_tickrate_rate{client="TestBot"} 20',
    'hmc_players_count{client="TestBot"} 2',
    'hmc_players_list_ping{client="TestBot",gamemode="creative",name="Alex",uuid="u2"} 80',
    'hmc_players_ping_max{client="TestBot"} 80',
    'hmc_world_dimension_info{client="TestBot",value="minecraft:overworld"} 1',
    'hmc_world_time_game{client="TestBot"} 1000',
    'hmc_world_time_day{client="TestBot"} 25000',
    'hmc_world_weather_info{client="TestBot",value="clear"} 1',
    'hmc_world_chunks{client="TestBot"} 3',
    'hmc_world_difficulty_info{client="TestBot",value="hard"} 1',
    'hmc_player_name_info{client="TestBot",value="TestBot"} 1',
    'hmc_player_position_yaw{client="TestBot"} 0',
    'hmc_player_food_food{client="TestBot"} 18',
    'hmc_player_dead{client="TestBot"} 0',
    'hmc_collect_success{client="TestBot"} 1',
    'hmc_prometheus_info{client="TestBot",loader="mineflayer",version="0.1.0"} 1',
    'hmc_screenshots_available{client="TestBot"} 0'
  ]) {
    assert.ok(text.includes(expected + '\n'), `missing ${expected} in\n${text}`)
  }

  for (const name of ['hmc_main_thread_latency_seconds', 'jvm_memory_used_bytes{area="heap"', 'jvm_memory_max_bytes{area="heap"',
    'jvm_threads_current', 'process_cpu_seconds_total']) {
    assert.ok(text.includes(name), `missing ${name}`)
  }

  assert.ok(!text.includes('hmc_jvm_'), 'the jvm group is excluded by default')
  assert.ok(!text.includes('hmc_client_fps'), 'no fps without rendering')

  const files = fs.readdirSync(discoveryDir)
  assert.deepStrictEqual(files, [`mineflayer-prometheus-${new URL(url).port}.json`])
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(discoveryDir, files[0]), 'utf8')),
    [{ targets: [`127.0.0.1:${new URL(url).port}`], labels: { client: 'TestBot' } }])

  // a blocked main thread: the exporter still answers, with the previous values
  // scrape from another thread, this one is blocked
  const { Worker } = require('worker_threads')
  const scraper = new Worker(`
    const { parentPort, workerData } = require('worker_threads')
    parentPort.once('message', () => fetch(workerData).then(r => r.text()).then(t => parentPort.postMessage(t)))
  `, { eval: true, workerData: url })
  await new Promise(resolve => scraper.once('online', resolve))
  const stalePromise = new Promise(resolve => scraper.once('message', resolve))
  scraper.postMessage('go')
  const until = Date.now() + 1000
  while (Date.now() < until) { /* block */ }
  const stale = await stalePromise
  await scraper.terminate()
  assert.ok(stale.includes('hmc_collect_success{client="TestBot"} 0\n'), stale)
  assert.ok(stale.includes('hmc_server_ping{client="TestBot"} 42\n'))

  // the console
  const base = url.replace('/metrics', '')
  const forbidden = await fetch(base + '/command', { method: 'POST', body: 'chat hi' })
  assert.strictEqual(forbidden.status, 403)
  const response = await fetch(base + '/command', { method: 'POST', body: 'chat hello', headers: { 'X-HMC-Console': '1' } })
  assert.strictEqual(response.status, 200)
  assert.strictEqual(bot.lastChat, 'hello')
  const metrics = await (await fetch(base + '/command', { method: 'POST', body: 'metrics server.ping', headers: { 'X-HMC-Console': '1' } })).text()
  assert.strictEqual(metrics, 'server.ping: 42')

  const screenshot = await fetch(base + '/screenshot.png')
  assert.strictEqual(screenshot.status, 404)
  assert.match(await screenshot.text(), /Rendering is disabled/)

  bot.emit('end', 'test')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.strictEqual(bot.prometheus.isRunning(), false)
  assert.deepStrictEqual(fs.readdirSync(discoveryDir), [])
})

test('takes the next port if the port is in use, and reports it once', async t => {
  const net = require('net')
  const blocker = net.createServer().listen(19500, '127.0.0.1')
  await new Promise(resolve => blocker.once('listening', resolve))
  const discoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineflayer-prometheus-'))
  const bot = fakeBot()
  prometheus({ port: 19500, discoveryDir })(bot, {})
  await bot.prometheus.start()
  t.after(async () => {
    await bot.prometheus.stop()
    blocker.close()
    fs.rmSync(discoveryDir, { recursive: true, force: true })
  })
  assert.strictEqual(new URL(bot.prometheus.getUrl()).port, '19501')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.deepStrictEqual(fs.readdirSync(discoveryDir), ['mineflayer-prometheus-19501.json'])
})

test('deletes the discovery file when the process is killed with SIGTERM', async t => {
  const { spawn } = require('child_process')
  const discoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineflayer-prometheus-'))
  t.after(() => fs.rmSync(discoveryDir, { recursive: true, force: true }))
  const script = `
    const { EventEmitter } = require('events')
    const { prometheus } = require(${JSON.stringify(path.join(__dirname, '..'))})
    const bot = new EventEmitter()
    bot._client = new EventEmitter()
    bot._client.write = () => {}
    bot.username = 'SignalBot'
    prometheus({ port: 19600, discoveryDir: ${JSON.stringify(discoveryDir)} })(bot, {})
    bot.prometheus.start().then(() => console.log('started'))
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise(resolve => child.stdout.on('data', d => { if (String(d).includes('started')) resolve() }))
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.strictEqual(fs.readdirSync(discoveryDir).length, 1)
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  assert.deepStrictEqual(await exited, { code: 143, signal: null })
  assert.deepStrictEqual(fs.readdirSync(discoveryDir), [])
})
