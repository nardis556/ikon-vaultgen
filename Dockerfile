FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY tsconfig.json ./
COPY src/ ./src/
COPY strategies/ ./strategies/
# MODE=provision (one-shot) | animate (daemon) | list
CMD ["npx", "tsx", "src/index.ts"]
