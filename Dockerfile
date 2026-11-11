FROM node:22-slim
# System Chromium for the stealth browser step (skip Puppeteer's own download).
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true CHROME_PATH=/usr/bin/chromium NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY bin ./bin
COPY src ./src
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "bin/antibot.js"]
CMD ["serve"]
