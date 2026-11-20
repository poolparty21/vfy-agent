# The prover as a container, for a host that does not sleep (Fly.io).
#
# Build context is the repo root, because prover/maps/gatekeeper.mjs imports
# ../../src/vfy.js (keccak256 for the task_id field). The layout is preserved:
#   /app/prover/server.mjs   /app/prover/circuits/...   /app/src/vfy.js
#
# No cloudflared here: the host terminates TLS and gives a stable HTTPS name,
# and the process REGISTERS that name itself (PROVER_PUBLIC_URL, signed POST
# /prover/register, boot + every 2 min). PROVER_URL alone is not enough: the
# Worker prefers a fresh registration, so a running PC supervisor would keep
# winning and the container would never be used.
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
