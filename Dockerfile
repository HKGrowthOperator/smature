FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Claude Code (headless) für die KI über das Claude-Max-Abo – Abrechnung über die Nutzungslimits des Abos, nicht pro Token.
# Alpine braucht libgcc/libstdc++ und das System-ripgrep.
ARG CLAUDE_CODE_VERSION=latest
RUN apk add --no-cache libgcc libstdc++ ripgrep \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force
ENV USE_BUILTIN_RIPGREP=0 DISABLE_AUTOUPDATER=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
