# status-master: Teams presence -> MQTT stack light. Node 24 runs the TypeScript directly; no dependencies.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
CMD ["node", "src/run.ts"]
