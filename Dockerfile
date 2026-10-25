FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY drizzle.config.ts ./

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

# Hub: any HTTP answer means it serves (security hooks may answer 401/403). Edge (HUB_URL set):
# no HTTP server; it reconnects on its own.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "if (process.env.HUB_URL) process.exit(0); fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/edges?limit=1').then(() => process.exit(0), () => process.exit(1))"]

CMD ["node", "src/main.ts"]
