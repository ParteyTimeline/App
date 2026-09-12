FROM node:22-slim

# yt-dlp reads YouTube playlists and streams audio; ffmpeg creates 30s MP3 clips.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages 'yt-dlp[default]'

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
