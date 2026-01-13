# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Build frontend and compile server
RUN npm run build:client
RUN npx tsc --outDir dist/server --rootDir src/server src/server/**/*.ts

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy built assets
COPY --from=builder /app/dist ./dist

# Create data directory
RUN mkdir -p /app/data

# Environment
ENV NODE_ENV=production
ENV RAPHAEL_DB_PATH=/app/data/raphael.db
ENV PORT=6274

EXPOSE 6274

CMD ["node", "dist/server/index.js"]
