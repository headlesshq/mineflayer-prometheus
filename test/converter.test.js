'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { MetricsConverter } = require('../lib/exporter/converter')
const { Exposition } = require('../lib/exporter/exposition')

function convert (fn) {
  const converter = new MetricsConverter({ client: 'bot' })
  fn(converter)
  const exposition = new Exposition()
  converter.writeTo(exposition)
  return exposition.toString()
}

test('numbers and booleans become gauges', () => {
  const text = convert(c => {
    c.add('server.tps', 'TPS', 19.5)
    c.add('server.connected', 'Connected', true)
  })
  assert.match(text, /# TYPE hmc_server_tps gauge\nhmc_server_tps\{client="bot"\} 19.5\n/)
  assert.match(text, /hmc_server_connected\{client="bot"\} 1\n/)
})

test('strings become info metrics', () => {
  const text = convert(c => c.add('server.brand', 'Brand', 'Paper'))
  assert.match(text, /# TYPE hmc_server_brand_info gauge\nhmc_server_brand_info\{client="bot",value="Paper"\} 1\n/)
})

test('maps are flattened', () => {
  const text = convert(c => c.add('client.mspt', 'MSPT', { avg: 1.5, max: 3 }))
  assert.match(text, /hmc_client_mspt_avg\{client="bot"\} 1.5\n/)
  assert.match(text, /hmc_client_mspt_max\{client="bot"\} 3\n/)
})

test('lists of maps become one series per element with the strings as labels', () => {
  const text = convert(c => c.add('players.list', 'Players', [
    { name: 'Steve', uuid: 'u1', ping: 20, gamemode: 'survival' },
    { name: 'Alex', uuid: null, ping: 30, gamemode: null },
    { name: 'Steve', uuid: 'u1', ping: 99, gamemode: 'survival' } // duplicate labels are left out
  ]))
  assert.match(text, /hmc_players_list_ping\{client="bot",gamemode="survival",name="Steve",uuid="u1"\} 20\n/)
  assert.match(text, /hmc_players_list_ping\{client="bot",gamemode="",name="Alex",uuid=""\} 30\n/)
  assert.doesNotMatch(text, / 99\n/)
})

test('null values are left out', () => {
  const text = convert(c => {
    c.add('server.ping', 'Ping', null)
    c.add('client.mspt', 'MSPT', { avg: null })
  })
  assert.strictEqual(text, '')
})

test('a client label in a list element is renamed', () => {
  const text = convert(c => c.add('custom.list', 'Custom', [{ client: 'other', value: 1 }]))
  assert.match(text, /hmc_custom_list_value\{client="bot",exported_client="other"\} 1\n/)
})

test('names are sanitized and label values escaped', () => {
  const text = convert(c => c.add('my-mod.some value', 'Help\nline', 'a"b\\c'))
  assert.match(text, /# HELP hmc_my_mod_some_value_info Help\\nline\n/)
  assert.match(text, /value="a\\"b\\\\c"/)
})

test('a gauge and an info with the same name do not mix', () => {
  const text = convert(c => {
    c.add('a', 'A', 1)
    c.add('a', 'A', 'text')
  })
  assert.doesNotMatch(text, /hmc_a_info/)
})
