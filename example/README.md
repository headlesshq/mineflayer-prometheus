# Prometheus, Loki and Grafana for mineflayer-prometheus

The same setup as the [example of hmc-prometheus](https://github.com/headlesshq/hmc-prometheus/tree/main/example),
with the same dashboards: Prometheus, Loki and Grafana with Docker Compose. Every bot (and every Minecraft client with
hmc-prometheus) is discovered automatically, and Grafana comes with two dashboards:

* **Minecraft Clients** (home dashboard): all bots in one table (status, version, player, server, dimension,
  FPS, TPS, ping, health, players, heap, main-thread latency), graphs that compare them,
  warnings and errors from all logs, and a collapsed *Screens* row with a screenshot of every bot that renders.
  Click a bot to open its dashboard.
* **Minecraft Client**: everything about one bot: a screenshot of what it sees, reloaded with every dashboard refresh
  (pick 5s at the top right), next to the log with chat colors and a console below it,
  then performance, server, network, player, world, tab list and runtime. Pick the bot at the top.

## Demo

```shell
# Create the discovery directory yourself, otherwise Docker creates it owned by root and the bots can't write to it
mkdir -p ~/.hmc-prometheus/targets
docker compose --profile demo up -d --build
```

This also starts a Minecraft 1.21.4 server in offline mode on `127.0.0.1:25565` and three bots from
[bots/demo.js](bots/demo.js) that render what they see:

* **Walker** wanders around,
* **Watcher** stands at spawn, looks at the nearest entity and chats about the time and weather,
* **Laggy** does expensive work every tick and blocks its event loop for 8 seconds every two minutes,
  which shows up as client tick time, main thread latency and stalled collections.

The first start takes a few minutes, the server downloads and generates its world. Then open <http://localhost:3000>.
You can join the server with a Minecraft 1.21.4 client in offline mode to see the bots in the game.
`docker compose --profile demo down` stops everything.

## A real client next to the bots

The `hmc` profile adds a Fabric 1.21.4 client, launched with [HeadlessMc](https://github.com/headlesshq/headlessmc)
and the mods [hmc-specifics](https://github.com/headlesshq/hmc-specifics) and
[hmc-prometheus](https://github.com/headlesshq/hmc-prometheus) from [hmc-client/mods](hmc-client/mods),
which joins the demo server as `HmcClient`, so that you can compare it with the bots in the same dashboards:

```shell
# HeadlessMc and the mods, they are not part of the repository
gh release download 3.0.0-RC8 -R headlesshq/headlessmc -p headlessmc.jar -D hmc-client
gh release download 0.1.0 -R headlesshq/hmc-prometheus -p '*.jar' -D hmc-client/mods
gh release download 1.21.4-3.0.1 -R headlesshq/hmc-specifics -p '*fabric*.jar' -D hmc-client/mods
docker compose --profile demo --profile hmc up -d
```

The first start downloads Java 21, Minecraft and its assets (about 500 MB) into the volume `hmc-client-data`.
This client runs headless (`--headless`), so it does not render and its screen panel says so.

The `hmc-render` profile adds `HmcRender`, the same client, but rendering in Xvfb with Mesa's software OpenGL
(about 20 FPS), so its screen panel shows the game:

```shell
docker compose --profile demo --profile hmc-render up -d
```

See [hmc-client/start-render.sh](hmc-client/start-render.sh): it creates an offline account named `HmcRender`
(two clients with the default offline account `Offline` would kick each other from the server),
sets `hmc.xvfb.check=true`, without which HeadlessMc forces headless mode for offline accounts,
and starts Xvfb on display `:100`. Containers with `network_mode: host` share abstract unix sockets,
so every Xvfb needs its own display number, the demo bots use `:99`.

## Your own bots

```shell
mkdir -p ~/.hmc-prometheus/targets
docker compose up -d
```

Load the plugin with `lokiUrl: 'http://127.0.0.1:3100'` to see the logs, `console: true` for the console and
`render: true` for the screenshots, see the [README](../README.md).
Grafana is started with `GF_PANELS_DISABLE_SANITIZE_HTML`, because it would otherwise sandbox the console's iframe.
Screenshots are loaded by your browser directly from the bots, e.g. `http://127.0.0.1:9400/screenshot.png`,
so they only show up in a browser on the same machine, or one that can reach the bots.
For a live view at about one frame per second, open `http://127.0.0.1:<port>/live` of a bot in a browser tab.
Anonymous users can view the dashboards; to edit, log in as `admin` / `admin`
(or set `GRAFANA_ADMIN_PASSWORD` before the first start).

## How it works

```
prometheus/prometheus.yml          scrape every 5s, targets from /targets/*.json (honor_labels: true)
loki/loki.yml                      a single Loki process, stores the logs for 30 days on the filesystem
grafana/provisioning/datasources   Prometheus and Loki datasources with the uids "prometheus" and "loki"
grafana/provisioning/dashboards    loads the dashboards from grafana/dashboards into the folder "Minecraft"
grafana/dashboards                 the dashboards of hmc-prometheus as JSON, unchanged
bots/                              the demo bots, a Node.js 22 image with Xvfb for rendering
```

Each bot writes `~/.hmc-prometheus/targets/mineflayer-prometheus-<port>.json` when its exporter starts and deletes it
when it stops or the process exits. Prometheus watches that directory, so bots appear and disappear without
restarting anything. A bot that crashed keeps its file, so it is shown as `DOWN` until another bot starts and cleans up.

Prometheus, Loki and Grafana use the host network, because the bots only listen on `127.0.0.1` by default.
They only listen on `127.0.0.1` too, so they aren't reachable from other machines.

## Rootless Docker

With rootless Docker, `network_mode: host` is the network namespace of rootlesskit, not the one of your machine:
Grafana, Prometheus and bots in containers can reach each other, but your browser can't reach them, and Prometheus
can't reach bots that run directly on your machine. Forward the ports you need to `127.0.0.1` of your machine with
the API of rootlesskit (the forwards are gone when the Docker daemon restarts):

```shell
for port in 3000 9090 9400 9401 9402 9403 9404; do
  curl -s --unix-socket "$XDG_RUNTIME_DIR/dockerd-rootless/api.sock" -X POST http://rootlesskit/v1/ports \
    -H 'Content-Type: application/json' \
    -d "{\"proto\":\"tcp4\",\"parentIP\":\"127.0.0.1\",\"parentPort\":$port,\"childIP\":\"127.0.0.1\",\"childPort\":$port}"
done
```

## Docker Desktop (macOS, Windows) or Prometheus on another machine

Without host networking, Prometheus can't reach `127.0.0.1` of the host. Let the bots listen on all interfaces
and write an address that Prometheus can reach into the discovery file:

```js
bot.loadPlugin(prometheus({ host: '0.0.0.0', discoveryAddress: 'host.docker.internal' }))
```

Then replace `network_mode: host` in `docker-compose.yml` with port mappings (`9090:9090`, `3100:3100`, `3000:3000`),
remove `--web.listen-address` and `GF_SERVER_HTTP_ADDR`, let Loki listen on `0.0.0.0` in `loki/loki.yml`,
change the datasource URLs to `http://prometheus:9090` and `http://loki:3100`,
and set `lokiUrl` in the bots to `http://localhost:3100`.
With `host: '0.0.0.0'` the metrics are reachable from your network, so only do this on networks you trust.
For bots on other machines, use the `minecraft-static` job in `prometheus/prometheus.yml`
or share the discovery directory.

## Changing the dashboards

The dashboards are copied from hmc-prometheus. They can be edited in Grafana. To keep a change, export the dashboard
as JSON (Share, Export, without "Export for sharing externally") and replace the file in `grafana/dashboards`.
