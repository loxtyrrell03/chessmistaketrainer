FROM debian:bookworm-slim

# Install Node.js (from Debian) and Stockfish engine
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg \
       nodejs npm \
       stockfish \
    && rm -rf /var/lib/apt/lists/*

# Ensure stockfish is on PATH for Cloud Run (binary is usually in /usr/games)
ENV PATH="/usr/games:${PATH}"
RUN if [ -x /usr/games/stockfish ]; then ln -sf /usr/games/stockfish /usr/local/bin/stockfish; fi

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY server.js ./

ENV NODE_ENV=production
ENV STOCKFISH_PATH=/usr/games/stockfish
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
