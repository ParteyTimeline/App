FROM node:22-slim

# yt-dlp reads YouTube playlists and streams audio; ffmpeg creates 30s MP3 clips.
# Prebuilt wheels for some of yt-dlp's/spotapi's dependencies (Pillow, cffi,
# pycryptodomex, brotli, pymongo's C extension) aren't published for every
# platform this image is built for (linux/amd64, linux/arm64, linux/arm/v7 —
# see docker-release.yml) — linux/arm/v7 in particular has none, so pip has to
# compile them from source there. libjpeg-dev/zlib1g-dev (Pillow) and
# libffi-dev (cffi) provide the headers that needs; they, and the runtime
# shared libraries pip's build links against, stay in the final image (small
# size cost, but removing them risks breaking an already-compiled .so at
# import time). Only gcc/python3-dev — the compiler itself, never needed once
# pip is done — are removed again in the same layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-dev gcc libjpeg-dev zlib1g-dev libffi-dev ca-certificates ffmpeg \
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
