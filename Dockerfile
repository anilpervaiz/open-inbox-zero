FROM node:22-bookworm-slim AS app
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
RUN chown node:node /app
COPY --chown=node:node . .
USER node
ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN pnpm install --frozen-lockfile
RUN pnpm build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@open-inbox-zero/web", "exec", "next", "start", "--hostname", "0.0.0.0"]
