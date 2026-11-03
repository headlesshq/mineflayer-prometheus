#!/bin/sh
# Launches a Fabric 1.21.4 client with HeadlessMc, hmc-specifics and hmc-prometheus, and joins the demo server.
# Offline accounts may only be used headless, so the client does not render (the dashboard shows why).
set -e
# HeadlessMc 3 gives every profile its own game directory
GAME_DIR="$HOME/.minecraft/fabric-1.21.4"
mkdir -p "$GAME_DIR/mods"
cp /hmc/mods/*.jar "$GAME_DIR/mods/"
[ -f "$GAME_DIR/options.txt" ] || cp /hmc/options.txt "$GAME_DIR/options.txt"
# Java takes the home directory from /etc/passwd, not from $HOME
exec java -Duser.home="$HOME" -Dhmc.jline.enabled=false -jar /hmc/headlessmc.jar launch fabric 1.21.4 \
  --headless --offline --server 127.0.0.1:25565 \
  --jvm "-Xmx2G -Dhmc.prometheus.client=${HMC_CLIENT:-HmcClient} -Dhmc.prometheus.lokiUrl=http://127.0.0.1:3100 -Dhmc.prometheus.console=true -Dhmc.prometheus.discoveryDir=/targets"
