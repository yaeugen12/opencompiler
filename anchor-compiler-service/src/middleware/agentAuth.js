const rateLimit = require('express-rate-limit');
const { verifyAgentKey } = require('../agentAuth');
const config = require('../config');

/**
 * Middleware: require valid X-Agent-Key header
 */
async function requireAgentKey(req, res, next) {
  const key = req.headers['x-agent-key'];

  if (!key) {
    return res.status(401).json({
      error: 'Missing X-Agent-Key header',
      hint: 'Register at POST /api/v1/agent/register to obtain a key',
    });
  }

  try {
    const agent = await verifyAgentKey(key);
    if (!agent) {
      return res.status(403).json({ error: 'Invalid or revoked agent key' });
    }

    req.agent = agent;
    next();
  } catch (err) {
    console.error('Agent auth error:', err.message);
    return res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * Middleware: require X-Admin-Key for agent management endpoints.
 * If AGENT_ADMIN_KEY is not set, auth is skipped (dev mode).
 */
function requireAdminKey(req, res, next) {
  const adminKey = config.agent.adminKey;

  if (!adminKey) {
    return next();
  }

  const provided = req.headers['x-admin-key'];
  if (!provided || provided !== adminKey) {
    return res.status(401).json({ error: 'Invalid or missing X-Admin-Key' });
  }

  next();
}

/**
 * Agent-specific rate limiters (higher limits than browser users)
 */
const agentApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Agent rate limit exceeded. Max 300 requests per 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-agent-key'] || 'anonymous',
  validate: { xForwardedForHeader: false },
});

const agentBuildLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Agent build rate limit exceeded. Max 20 builds per hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-agent-key'] || 'anonymous',
  validate: { xForwardedForHeader: false },
});

module.exports = {
  requireAgentKey,
  requireAdminKey,
  agentApiLimiter,
  agentBuildLimiter,
};
