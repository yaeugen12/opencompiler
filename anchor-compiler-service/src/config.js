module.exports = {
  // Server configuration
  port: process.env.PORT || 3000,
  
  // Docker image (replace with your actual image name)
  dockerImage: process.env.DOCKER_IMAGE || 'anchor-builder:latest',
  
  // Build configuration
  builds: {
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    buildDir: process.env.BUILD_DIR || './builds',
    maxUploadSize: 100 * 1024 * 1024, // 100MB
    timeout: parseInt(process.env.BUILD_TIMEOUT || '600', 10), // 10 minutes
  },
  
  // Docker resource limits
  docker: {
    memory: 2 * 1024 * 1024 * 1024, // 2GB
    memorySwap: 2 * 1024 * 1024 * 1024, // 2GB (no swap)
    cpus: 2, // 2 CPU cores
    networkDisabled: false, // Enable network for cargo dependencies
    readonlyRootfs: false, // Anchor needs to write to /root/.cargo
    autoRemove: true, // Remove container after completion
  },
  
  // Cleanup configuration
  cleanup: {
    enableAutoCleanup: true,
    cleanupAfterMinutes: 60, // Clean up builds older than 1 hour
  },

  // Smart build (AI-powered build loop)
  smartBuild: {
    maxIterations: parseInt(process.env.SMART_BUILD_MAX_ITERATIONS || '8', 10),
    aiModel: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
    aiMaxTokens: parseInt(process.env.AI_MAX_TOKENS || '16384', 10),
  },

  // Deploy configuration
  deploy: {
    rpc: {
      devnet: process.env.DEVNET_RPC || 'https://api.devnet.solana.com',
      mainnet: process.env.MAINNET_RPC || 'https://api.mainnet-beta.solana.com',
    },
    timeout: 300, // 5 minutes for deployment
  },

  // CORS — comma-separated origins or '*' for all
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // Agent API configuration
  agent: {
    dbPath: process.env.AGENT_DB_PATH || './data/agents.db',
    adminKey: process.env.AGENT_ADMIN_KEY || null,
    maxFilesPerProject: 100,
    maxTotalFileSize: 10 * 1024 * 1024, // 10MB
    buildTimeout: 600, // 10 min max for synchronous builds
  },
};
