'use strict'

const fs = require('fs')
const net = require('net')
const path = require('path')

/**
 * Prometheus file based service discovery, the same as HMC-Prometheus, so that Prometheus finds every running bot,
 * no matter which port it got. Every bot writes mineflayer-prometheus-<port>.json into the discovery directory and
 * deletes it when it stops. Files of bots that crashed are deleted by the next bot that starts, if nothing listens on
 * their port anymore. Until then Prometheus reports them with up == 0, so a crashed bot shows up in Grafana.
 */
const FILE_PREFIX = 'mineflayer-prometheus-'
const TARGET = /"targets"\s*:\s*\[\s*"([^"]+):(\d+)"/

class TargetDiscovery {
  constructor (dir) {
    this.dir = dir
  }

  /**
   * @returns {Promise<string>} the written file.
   */
  async write (address, port, client) {
    await fs.promises.mkdir(this.dir, { recursive: true })
    await this.cleanUp(port)
    const file = path.join(this.dir, `${FILE_PREFIX}${port}.json`)
    const json = JSON.stringify([{ targets: [`${address}:${port}`], labels: { client } }]) + '\n'
    // Prometheus watches the directory, it must not see a partially written file
    const tmp = path.join(this.dir, `.${FILE_PREFIX}${port}.json.tmp`)
    await fs.promises.writeFile(tmp, json)
    await fs.promises.rename(tmp, file)
    return file
  }

  /** Deletes the files of bots that are not running anymore. */
  async cleanUp (ownPort) {
    let names
    try {
      names = await fs.promises.readdir(this.dir)
    } catch (e) {
      return
    }

    await Promise.all(names.filter(n => n.startsWith(FILE_PREFIX) && n.endsWith('.json')).map(async name => {
      const file = path.join(this.dir, name)
      try {
        const match = TARGET.exec(await fs.promises.readFile(file, 'utf8'))
        if (!match) return
        const port = parseInt(match[2], 10)
        if (port !== ownPort && !(await isListening(match[1], port))) await fs.promises.rm(file, { force: true })
      } catch (e) {
        // another bot deleted it
      }
    }))
  }
}

function isListening (host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port, timeout: 250 })
    const done = result => {
      socket.destroy()
      resolve(result)
    }

    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

module.exports = { TargetDiscovery }
