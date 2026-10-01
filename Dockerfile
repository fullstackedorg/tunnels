FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY drizzle.config.ts ./

EXPOSE 3000
CMD ["node", "src/main.ts"]
