const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const logger = require('../logger');

/**
 * Rate limiting middleware
 */
const createRateLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(`Rate limit exceeded: ${req.ip} ${req.method} ${req.path}`);
      res.status(429).json({
        error: message,
        retryAfter: Math.ceil(windowMs / 1000),
      });
    },
  });
};

// General API rate limit: 100 requests per 15 minutes
const apiLimiter = createRateLimiter(
  15 * 60 * 1000,
  100,
  'Too many requests, please try again later'
);

// Upload rate limit: 5 uploads per hour
const uploadLimiter = createRateLimiter(
  60 * 60 * 1000,
  5,
  'Upload limit exceeded. Maximum 5 uploads per hour.'
);

// AI verification limit: 10 per hour
const aiLimiter = createRateLimiter(
  60 * 60 * 1000,
  10,
  'AI verification limit exceeded. Maximum 10 verifications per hour.'
);

/**
 * Helmet security headers
 */
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'http://localhost:*'],
      fontSrc: ["'self'", 'cdn.jsdelivr.net'],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
});

/**
 * API key authentication middleware (optional)
 */
const requireApiKey = (req, res, next) => {
  const apiKey = process.env.API_KEY;
  
  // If no API key configured, skip authentication
  if (!apiKey) {
    return next();
  }

  const providedKey = req.headers['x-api-key'] || req.query.apiKey;

  if (!providedKey || providedKey !== apiKey) {
    logger.warn(`Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({
      error: 'Unauthorized. Valid API key required.',
    });
  }

  next();
};

/**
 * Request logger middleware
 */
const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });

  next();
};

module.exports = {
  apiLimiter,
  uploadLimiter,
  aiLimiter,
  securityHeaders,
  requireApiKey,
  requestLogger,
};
