FROM mcr.microsoft.com/devcontainers/javascript-node:26-bookworm@sha256:b47c85979be280319feb03fa4089cc8b168a13d50fc28d2f8333c15077a4989c

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
