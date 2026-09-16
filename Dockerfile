FROM node:22-slim

# yt-dlp reads YouTube playlists and streams audio; ffmpeg creates 30s MP3 clips.
# gcc/python3-dev are only needed transiently: prebuilt wheels for some of
# yt-dlp's/spotapi's dependencies (e.g. pycryptodomex) aren't always published
# for every platform this image is built for (linux/amd64, linux/arm64,
# linux/arm/v7 — see docker-release.yml), so pip may need to compile one from
# source; removed again in the same layer once pip is done so the final image
# doesn't carry a whole compiler toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-dev gcc ca-certificates ffmpeg \
 && pip3 install --no-cache-dir --break-system-packages 'yt-dlp[default]' 'spotapi==1.2.8' pymongo redis \
 && apt-get purge -y --auto-remove python3-dev gcc \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server.js"]
