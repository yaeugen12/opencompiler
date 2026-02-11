const WebSocket = require('ws');
const logger = require('./logger');

let wss = null;
const clients = new Map(); // buildId -> Set of WebSocket clients

/**
 * Initialize WebSocket server
 */
function initWebSocket(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    logger.info(`WebSocket client connected from ${ip}`);

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        // Subscribe to build logs
        if (data.action === 'subscribe' && data.buildId) {
          if (!clients.has(data.buildId)) {
            clients.set(data.buildId, new Set());
          }
          clients.get(data.buildId).add(ws);
          ws.buildId = data.buildId;
          
          logger.info(`Client subscribed to build: ${data.buildId}`);
          ws.send(JSON.stringify({
            type: 'subscribed',
            buildId: data.buildId,
          }));
        }
      } catch (error) {
        logger.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      // Clean up subscriptions
      if (ws.buildId) {
        const subscribers = clients.get(ws.buildId);
        if (subscribers) {
          subscribers.delete(ws);
          if (subscribers.size === 0) {
            clients.delete(ws.buildId);
          }
        }
        logger.info(`Client unsubscribed from build: ${ws.buildId}`);
      }
    });

    ws.on('error', (error) => {
      logger.error('WebSocket error:', error);
    });

    // Send initial connection confirmation
    ws.send(JSON.stringify({ type: 'connected' }));
  });

  logger.info('WebSocket server initialized on /ws');
  return wss;
}

/**
 * Broadcast log update to all clients subscribed to a build
 */
function broadcastLog(buildId, logData) {
  const subscribers = clients.get(buildId);
  if (!subscribers || subscribers.size === 0) {
    return;
  }

  const message = JSON.stringify({
    type: 'log',
    buildId,
    data: logData,
  });

  subscribers.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

/**
 * Broadcast build status update
 */
function broadcastStatus(buildId, status) {
  const subscribers = clients.get(buildId);
  if (!subscribers || subscribers.size === 0) {
    return;
  }

  const message = JSON.stringify({
    type: 'status',
    buildId,
    status,
  });

  subscribers.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

/**
 * Broadcast smart build progress events to subscribed clients
 */
function broadcastSmartBuildProgress(buildId, progressEvent) {
  const subscribers = clients.get(buildId);
  if (!subscribers || subscribers.size === 0) return;

  // Preserve inner type as subType so it doesn't override the message type
  const { type: subType, ...rest } = progressEvent;
  const message = JSON.stringify({
    type: 'smart_build_progress',
    subType: subType || 'phase',
    buildId,
    ...rest,
    timestamp: new Date().toISOString(),
  });

  subscribers.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

module.exports = {
  initWebSocket,
  broadcastLog,
  broadcastStatus,
  broadcastSmartBuildProgress,
};
