# The prover as a container, for a host that does not sleep (Fly.io).
#
# Build context is the repo root, because prover/maps/gatekeeper.mjs imports
# ../../src/vfy.js (keccak256 for the task_id field). The layout is preserved:
#   /app/prover/server.mjs   /app/prover/circuits/...   /app/src/vfy.js
#
# No cloudflared here: the host terminates TLS and gives a stable HTTPS name,
# so the Worker is pointed at https://<app>.fly.dev with PROVER_URL instead of
# a quick tunnel that renames itself on every restart.
FROM node:22-slim

ENV NODE_ENV=production \
    PROVER_HOST=0.0.0.0 \
    PROVER_PORT=8080

WORKDIR /app

# Dependencies first: a source-only change then reuses this layer.
COPY prover/package.json prover/package-lock.json ./prover/
RUN cd prover && npm ci --omit=dev

COPY prover/server.mjs ./prover/
COPY prover/maps ./prover/maps/
COPY prover/circuits ./prover/circuits/
COPY src/vfy.js ./src/vfy.js

# PROVER_TOKEN is a secret, never baked in: fly secrets set PROVER_TOKEN=...
USER node
EXPOSE 8080

CMD ["node", "prover/server.mjs"]
