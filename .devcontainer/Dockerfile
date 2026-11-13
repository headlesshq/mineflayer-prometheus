FROM mcr.microsoft.com/devcontainers/javascript-node:26-bookworm@sha256:c801953dbbf8b631da22f62e8897e997d5f2c02f0b03e6d0b845a288b579a112

# canvas needs cairo, pango and the image libraries; node-canvas-webgl's gl needs the GL headers and an X display (Xvfb),
# and has no Node 24 prebuild, so it builds from source with a gyp step that calls `python`
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        build-essential pkg-config python3 python-is-python3 \
        libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libpixman-1-dev \
        libgl1-mesa-dev libglu1-mesa-dev libxi-dev libxext-dev mesa-utils xvfb xauth \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/node/.npm \
    && chown node:node /home/node/.npm
