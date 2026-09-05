FROM node:20-slim

# python3/pip for yt-dlp (used server-side to read YouTube playlist listings —
# no video/audio is ever downloaded, just the flat playlist metadata).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
