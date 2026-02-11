FROM node:18-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl git

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application source
COPY src ./src
COPY skill.md ./skill.md

# Create necessary directories and set ownership before switching user
RUN mkdir -p uploads builds logs data && \
    chown -R node:node uploads builds logs data

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5000/health || exit 1

# Run as non-root user
USER node

# Start application
CMD ["node", "src/index.js"]
