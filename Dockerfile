FROM node:20-slim

# Install stockfish
RUN apt-get update && apt-get install -y stockfish && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci

# Copy source
COPY . .

# Build client
RUN cd client && npx vite build

# Create data directory
RUN mkdir -p data

EXPOSE 3001

CMD ["npx", "tsx", "server/server.ts"]
