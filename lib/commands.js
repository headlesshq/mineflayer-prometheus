'use strict'

/**
 * The commands of the web console. HMC-Prometheus executes the commands of HMC-Specifics, a bot has its own:
 * a few built-in ones and the ones passed with the option commands, e.g.
 * commands: { goto: async (args, bot) => { ...; return 'on my way' } }.
 */
function createCommands (bot, prometheus, custom) {
  const commands = {
    help: {
      description: 'Lists all commands.',
      run: () => Object.entries(commands).map(([name, c]) => `${name}: ${c.description}`).join('\n') +
        '\n/<command>: Sends a command to the server, e.g. /time query day.'
    },
    chat: {
      description: 'Sends a chat message, e.g. chat hello.',
      run: args => {
        if (args.length === 0) return 'Usage: chat <message>'
        bot.chat(args.join(' '))
        return ''
      }
    },
    metrics: {
      description: 'Shows metrics, all or by name, group or last part, e.g. metrics server, metrics --list.',
      run: args => {
        const service = prometheus.metrics
        if (args[0] === '--list') {
          return service.getMetrics().map(m => `${m.name}: ${m.description}`).join('\n')
        }

        const values = service.collect(service.select(...args))
        return Object.entries(values).map(([name, value]) => `${name}: ${format(value)}`).join('\n')
      }
    },
    players: {
      description: 'Lists the players in the tab list.',
      run: () => Object.values(bot.players || {}).map(p => `${p.username} (${p.ping}ms)`).join('\n') || 'No players'
    },
    position: {
      description: 'Shows the position of the bot.',
      run: () => bot.entity ? `${bot.entity.position} in ${bot.game.dimension}` : 'Not in a world'
    },
    prometheus: {
      description: 'Shows the status of the exporter.',
      run: () => prometheus.status()
    },
    quit: {
      description: 'Disconnects the bot.',
      run: () => {
        bot.quit()
        return 'Disconnecting'
      }
    }
  }

  for (const [name, fn] of Object.entries(custom || {})) {
    commands[name] = typeof fn === 'function' ? { description: 'Custom command.', run: fn } : fn
  }

  return {
    commands,
    /**
     * @returns {Promise<string>} the output of the command.
     */
    async execute (line) {
      if (line.startsWith('/')) {
        bot.chat(line)
        return ''
      }

      const [name, ...args] = line.split(/\s+/)
      const command = commands[name] || commands[name.toLowerCase()]
      if (!command) return `Couldn't find command for '${name}', use help to list all commands.`
      const output = await command.run(args, bot)
      return output == null ? '' : String(output)
    }
  }
}

function format (value) {
  return JSON.stringify(value, (key, v) => typeof v === 'bigint' ? Number(v) : v)
}

module.exports = { createCommands }
