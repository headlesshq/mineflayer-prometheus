#!/bin/sh
# headless-gl needs an X display, Xvfb provides a virtual one
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
export DISPLAY=:99
sleep 1
exec node demo.js "$@"
