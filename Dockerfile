# Daisy's relay, built on Fly.io's remote builder (fly deploy). Modelled on the die-relay app.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js tables.js lounge-auth.js atproto-pass.js lounge.js atproto-lounge.js ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
