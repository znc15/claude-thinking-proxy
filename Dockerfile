FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8848

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.js ./server.js
COPY src ./src

USER node

EXPOSE 8848

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8848) + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
