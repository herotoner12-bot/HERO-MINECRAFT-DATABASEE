# MCP server (HTTP mode) for cloud hosting: Render, Railway, Fly.io, Cloud Run, any Docker host.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
COPY mcp-server/package.json mcp-server/
COPY video-editor/package.json video-editor/
RUN npm install
COPY shared shared
COPY mcp-server mcp-server
RUN npx tsc -p mcp-server/tsconfig.json

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production MCP_TRANSPORT=http PORT=3000
COPY --from=build /app/mcp-server/dist mcp-server/dist
COPY mcp-server/package.json mcp-server/package.json
COPY database database
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "mcp-server/dist/mcp-server/server.js"]
