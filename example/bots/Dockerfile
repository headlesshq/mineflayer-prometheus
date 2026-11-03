# Demo bots with rendering. Node 22, because the native gl and canvas modules of the renderer have prebuilt binaries for it.
# Built from the root of the repository: docker compose --profile demo up -d --build
FROM node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd

RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb xauth libgl1 libegl1 libglx-mesa0 libgl1-mesa-dri \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/example/bots && chown -R node:node /app

COPY --chown=node:node package.json index.js index.d.ts LICENSE /app/
COPY --chown=node:node lib /app/lib
COPY --chown=node:node example/bots/package.json /app/example/bots/
USER node
WORKDIR /app/example/bots
# --install-links copies mineflayer-prometheus instead of linking it, so that it finds the renderer in this node_modules
RUN npm install --install-links --no-audit --no-fund
COPY --chown=node:node example/bots/demo.js example/bots/entrypoint.sh /app/example/bots/

ENTRYPOINT ["sh", "/app/example/bots/entrypoint.sh"]
