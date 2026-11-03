#!/bin/sh
# Launches a rendering Fabric 1.21.4 client in Xvfb with HeadlessMc, hmc-specifics and hmc-prometheus,
# with an offline account, which HeadlessMc allows with a virtual display like Xvfb.
set -e
# hmc.xvfb.check: HeadlessMc forces headless mode for offline accounts, unless it finds Xvfb running
HMC="java -Duser.home=$HOME -Dhmc.jline.enabled=false -Dhmc.xvfb.check=true -jar /hmc/headlessmc.jar"
NAME="${HMC_CLIENT:-HmcRender}"

# an offline account with its own name, two clients called "Offline" would kick each other from the server
if ! $HMC account ls 2>/dev/null | grep -q "^$NAME "; then
  # name, then the optional uuid, token and type, the login reads them one by one
  (printf '%s\n' "$NAME"; for i in 1 2 3 4 5; do sleep 2; printf '\n'; done; sleep 5) | $HMC account -p offline login
fi
GAME_DIR="$HOME/.minecraft/fabric-1.21.4"
mkdir -p "$GAME_DIR/mods"
cp /hmc/mods/*.jar "$GAME_DIR/mods/"
[ -f "$GAME_DIR/options.txt" ] || cp /hmc/options.txt "$GAME_DIR/options.txt"

# Containers with network_mode: host share abstract unix sockets, so every Xvfb needs its own display number,
# the demo bots use :99. A restarted container still has the lock of its last Xvfb, which would make the new one exit.
DISPLAY_NUMBER="${XVFB_DISPLAY:-100}"
rm -f "/tmp/.X$DISPLAY_NUMBER-lock" "/tmp/.X11-unix/X$DISPLAY_NUMBER"
Xvfb ":$DISPLAY_NUMBER" -screen 0 1280x720x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY=":$DISPLAY_NUMBER"
for i in $(seq 1 50); do [ -S "/tmp/.X11-unix/X$DISPLAY_NUMBER" ] && break; sleep 0.1; done
[ -S "/tmp/.X11-unix/X$DISPLAY_NUMBER" ] || { echo "Xvfb did not start:"; cat /tmp/xvfb.log; exit 1; }
exec $HMC launch fabric 1.21.4 --offline --server 127.0.0.1:25565 --resolution 854x480 \
  --jvm "-Xmx2G -Dhmc.prometheus.client=$NAME -Dhmc.prometheus.lokiUrl=http://127.0.0.1:3100 -Dhmc.prometheus.console=true -Dhmc.prometheus.discoveryDir=/targets -Dhmc.prometheus.screenshotIntervalMs=${SCREENSHOT_INTERVAL_MS:-1000}"
