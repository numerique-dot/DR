# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# Le SDK Anthropic et SQLite n'ont besoin de rien d'autre que de Node.
WORKDIR /app
RUN apk add --no-cache tini && \
    addgroup -S drdu && adduser -S drdu -G drdu && \
    mkdir -p /app/data && chown -R drdu:drdu /app
COPY --from=deps --chown=drdu:drdu /app/node_modules ./node_modules
COPY --chown=drdu:drdu package.json ./
COPY --chown=drdu:drdu src ./src
COPY --chown=drdu:drdu public ./public

USER drdu
EXPOSE 3000
# La base vit dans un volume : sans cela, les comptes disparaissent à chaque déploiement.
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini transmet SIGTERM : l'arrêt propre du serveur fonctionne réellement.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
