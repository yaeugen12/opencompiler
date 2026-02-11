require('dotenv').config({ override: true });

const express = require('express');
const http = require('http');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

// Configuration & Utils
const config = require('./config');
const logger = require('./logger');
const { verifyDockerImage } = require('./docker');
const { initWebSocket, broadcastLog, broadcastStatus, broadcastSmartBuildProgress } = require('./websocket');

// Middleware
const {
  apiLimiter,
  uploadLimiter,
  aiLimiter,
  securityHeaders,
  requireApiKey,
  requestLogger,
} = require('./middleware/security');

const {
  validateBuildId,
  validateGithubRepo,
  validateFilePath,
  validateFileContent,
  validateRestart,
} = require('./middleware/validators');

// Build Manager
const {
  startBuild,
  startBuildFromGithub,
  getBuildStatus,
  listBuilds,
  getBuildArtifacts,
  BuildStatus,
} = require('./buildManager');

// Agent routes
const agentRouter = require('./routes/agent');
const { getAgentByCode } = require('./agentAuth');

const app = express();
const server = http.createServer(app);

// ===== MIDDLEWARE SETUP =====

// Security headers
app.use(securityHeaders);

// CORS configuration
const corsOriginEnv = config.corsOrigin || '*';
const corsOptions = {
  origin: corsOriginEnv === '*'
    ? '*'
    : corsOriginEnv.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Agent-Key', 'X-Admin-Key'],
  credentials: corsOriginEnv !== '*',
};
app.use(cors(corsOptions));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use(requestLogger);

// File upload configuration
const upload = multer({
  dest: config.builds.uploadDir,
  limits: {
    fileSize: config.builds.maxUploadSize,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.zip', '.tar.gz', '.tgz'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.some(type => file.originalname.endsWith(type))) {
      cb(null, true);
    } else {
      cb(new Error('Only .zip and .tar.gz files are allowed'));
    }
  },
});

// ===== ERROR HANDLER =====

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ===== AGENT API =====
app.use('/api/v1', agentRouter);

// Serve skill.md for agent discovery
app.get('/skill.md', asyncHandler(async (req, res) => {
  const skillPath = path.join(__dirname, '..', 'skill.md');
  const content = await fs.readFile(skillPath, 'utf-8');
  res.type('text/markdown').send(content);
}));

// Agent claim page (human-facing)
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

app.get('/claim/:code', asyncHandler(async (req, res) => {
  const agent = await getAgentByCode(req.params.code);
  if (!agent) {
    return res.status(404).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not Found</title><style>body{font-family:system-ui;background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.c{text-align:center;padding:40px}h1{color:#fca5a5}</style></head><body><div class="c"><h1>Not Found</h1><p>This verification code is invalid or has expired.</p></div></body></html>');
  }

  const claimed = agent.claim_status === 'claimed';
  const name = escapeHtml(agent.name);
  const desc = agent.description ? escapeHtml(agent.description) : '';
  const code = escapeHtml(req.params.code);
  const handle = agent.x_handle ? escapeHtml(agent.x_handle) : '';
  const tweet = encodeURIComponent(`I'm verifying my agent "${agent.name}" on @OpenCompiler\nCode: ${req.params.code}`);

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Claim Agent - OpenCompiler</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:40px;max-width:480px;width:90%;text-align:center}h1{font-size:24px;margin-bottom:8px}.name{font-size:20px;font-weight:700;color:#10b981;margin:12px 0 4px}.desc{color:rgba(255,255,255,0.6);font-size:14px;margin-bottom:24px}.step{margin-bottom:16px;text-align:left;padding:12px;background:rgba(0,0,0,0.2);border-radius:8px}.code{background:rgba(0,0,0,0.4);border-radius:8px;padding:12px;font-family:monospace;font-size:18px;color:#fcd34d;margin-top:8px;border:1px solid rgba(252,211,77,0.2)}.btn{display:inline-block;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;border:none}.btn-tw{background:#1d9bf0;color:#fff;margin-bottom:24px}.btn-cl{background:#10b981;color:#fff;width:100%}.btn-cl:disabled{background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.3);cursor:not-allowed}input{width:100%;padding:10px 14px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e2e8f0;font-size:14px;margin-bottom:16px}input:focus{outline:none;border-color:#10b981}.res{display:none;margin-top:16px;padding:16px;border-radius:8px}.ok{background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3)}.er{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5}.cl-banner{background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);border-radius:8px;padding:16px;margin-top:16px}</style></head><body><div class="card"><h1>Claim Your Agent</h1><div class="name">${name}</div>${desc ? `<div class="desc">${desc}</div>` : ''}${claimed ? `<div class="cl-banner"><p style="font-weight:600;color:#10b981">Already Claimed</p><p style="font-size:14px;margin-top:4px">Owned by <a href="https://x.com/${handle}" target="_blank" style="color:#1d9bf0;text-decoration:none">@${handle}</a></p></div>` : `<div class="step"><strong>1. Tweet your verification code:</strong><div class="code">${code}</div></div><a href="https://twitter.com/intent/tweet?text=${tweet}" target="_blank" class="btn btn-tw">Tweet to Verify</a><div class="step"><strong>2. Enter your X handle:</strong></div><input type="text" id="h" placeholder="@your_handle"><button id="b" class="btn btn-cl" onclick="claim()">Complete Verification</button><div id="r" class="res"></div>`}</div><script>async function claim(){var h=document.getElementById('h'),v=h.value.trim().replace(/^@/,''),r=document.getElementById('r'),b=document.getElementById('b');if(!v||!/^[a-zA-Z0-9_]{1,15}$/.test(v)){r.className='res er';r.style.display='block';r.textContent='Enter a valid X handle';return}b.disabled=true;b.textContent='Verifying...';try{var res=await fetch('/api/v1/claim/${code}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x_handle:v})});var d=await res.json();if(!res.ok)throw new Error(d.error||'Failed');r.className='res ok';r.style.display='block';r.innerHTML='<strong>Claimed!</strong> Linked to <a href="https://x.com/'+d.x_handle+'" target="_blank" style="color:#1d9bf0">@'+d.x_handle+'</a>';b.style.display='none';h.style.display='none'}catch(e){r.className='res er';r.style.display='block';r.textContent=e.message;b.disabled=false;b.textContent='Complete Verification'}}</script></body></html>`);
}));

// ===== ROUTES =====

/**
 * Health check endpoint
 */
app.get('/health', asyncHandler(async (req, res) => {
  const dockerStatus = await verifyDockerImage();
  
  res.json({
    status: 'ok',
    service: 'anchor-compiler-service',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    docker: dockerStatus ? 'ready' : 'not found',
    uptime: process.uptime(),
  });
}));

/**
 * POST /compile
 * Upload and optionally compile an Anchor project
 */
app.post('/compile',
  uploadLimiter,
  requireApiKey,
  upload.single('project'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No project file uploaded' });
    }

    const fileType = req.file.originalname.endsWith('.zip') ? 'zip' : 'tar.gz';
    const autoBuild = req.query.autoBuild !== 'false';
    
    logger.info(`Upload received: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);
    
    if (autoBuild) {
      const buildId = await startBuild(req.file.path, fileType, {
        onLogUpdate: (logs) => broadcastLog(buildId, logs),
        onStatusChange: (status) => broadcastStatus(buildId, status),
      });

      res.status(202).json({
        buildId,
        status: 'accepted',
        message: 'Build started',
        statusUrl: `/compile/${buildId}/status`,
        artifactsUrl: `/compile/${buildId}/artifacts`,
        wsUrl: `/ws?buildId=${buildId}`,
      });
    } else {
      const { extractProject, generateBuildId } = require('./buildManager');
      const buildId = generateBuildId();
      
      await extractProject(buildId, req.file.path, fileType);
      
      res.status(200).json({
        buildId,
        status: 'ready',
        message: 'Project uploaded, ready for editing',
        statusUrl: `/compile/${buildId}/status`,
        filesUrl: `/compile/${buildId}/files`,
      });
    }
  })
);

/**
 * POST /compile/github?autoBuild=false
 * Clone from GitHub repository (optionally auto-build)
 */
app.post('/compile/github',
  apiLimiter,
  requireApiKey,
  validateGithubRepo,
  asyncHandler(async (req, res) => {
    const { repoUrl } = req.body;
    const autoBuild = req.query.autoBuild !== 'false';
    
    logger.info(`GitHub ${autoBuild ? 'build' : 'clone'} requested: ${repoUrl}`);
    
    const buildId = await startBuildFromGithub(repoUrl, autoBuild);

    if (autoBuild) {
      res.status(202).json({
        buildId,
        status: 'accepted',
        message: 'Build started from GitHub',
        statusUrl: `/compile/${buildId}/status`,
        artifactsUrl: `/compile/${buildId}/artifacts`,
        wsUrl: `/ws?buildId=${buildId}`,
      });
    } else {
      res.status(200).json({
        buildId,
        status: 'ready',
        message: 'Repository cloned, ready for editing',
        statusUrl: `/compile/${buildId}/status`,
        filesUrl: `/compile/${buildId}/files`,
      });
    }
  })
);

/**
 * GET /compile/:buildId/status
 * Get build status and logs
 */
app.get('/compile/:buildId/status',
  validateBuildId,
  asyncHandler(async (req, res) => {
    const build = getBuildStatus(req.params.buildId);

    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const response = {
      buildId: build.id,
      status: build.status,
      createdAt: build.createdAt,
      updatedAt: build.updatedAt,
    };

    if (build.status === BuildStatus.SUCCESS || build.status === BuildStatus.FAILED) {
      response.completedAt = build.completedAt;
      response.logs = build.logs;
      response.exitCode = build.exitCode;
      
      if (build.error) {
        response.error = build.error;
      }
    } else {
      // Return partial logs for running builds
      response.logs = build.logs;
    }

    res.json(response);
  })
);

/**
 * GET /compile/:buildId/artifacts
 * List available build artifacts
 */
app.get('/compile/:buildId/artifacts',
  validateBuildId,
  asyncHandler(async (req, res) => {
    const build = getBuildStatus(req.params.buildId);

    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    if (build.status !== BuildStatus.SUCCESS) {
      return res.status(400).json({
        error: 'Build not successful',
        status: build.status,
      });
    }

    const artifacts = await getBuildArtifacts(req.params.buildId);

    res.json({
      buildId: req.params.buildId,
      artifacts,
    });
  })
);

/**
 * GET /compile/:buildId/artifacts/download/:type/:filename
 * Download specific artifact
 */
app.get('/compile/:buildId/artifacts/download/:type/:filename',
  validateBuildId,
  asyncHandler(async (req, res) => {
    const { buildId, type, filename } = req.params;
    const build = getBuildStatus(buildId);

    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    if (build.status !== BuildStatus.SUCCESS) {
      return res.status(400).json({ error: 'Build not successful' });
    }

    const artifacts = await getBuildArtifacts(buildId);
    let artifactPath = null;
    
    const allArtifacts = [...artifacts.programs, ...artifacts.idl, ...artifacts.types, ...(artifacts.deploy || [])];
    
    for (const artifact of allArtifacts) {
      if (artifact.name === filename && artifact.type === type) {
        artifactPath = artifact.path;
        break;
      }
    }

    if (!artifactPath) {
      return res.status(404).json({ error: 'Artifact not found' });
    }

    logger.info(`Artifact download: ${filename} (${type})`);
    res.download(artifactPath, filename);
  })
);

/**
 * GET /compile/:buildId/files
 * List all project files (recursive tree)
 */
app.get('/compile/:buildId/files',
  validateBuildId,
  asyncHandler(async (req, res) => {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const projectDir = path.join(config.builds.uploadDir, req.params.buildId);
    
    async function listFilesRecursive(dir, relativePath = '') {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = [];

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(relativePath, entry.name);

        if (entry.isDirectory()) {
          const children = await listFilesRecursive(fullPath, relPath);
          files.push({
            name: entry.name,
            path: relPath,
            type: 'directory',
            children,
          });
        } else {
          const stats = await fs.stat(fullPath);
          files.push({
            name: entry.name,
            path: relPath,
            type: 'file',
            size: stats.size,
          });
        }
      }

      return files.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });
    }

    const fileTree = await listFilesRecursive(projectDir);

    res.json({
      buildId: req.params.buildId,
      files: fileTree,
    });
  })
);

/**
 * GET /compile/:buildId/file?path=...
 * Read file content
 */
app.get('/compile/:buildId/file',
  validateBuildId,
  validateFilePath,
  asyncHandler(async (req, res) => {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const filePath = req.query.path;
    const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(config.builds.uploadDir, req.params.buildId, safePath);

    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory' });
    }

    const content = await fs.readFile(fullPath, 'utf-8');

    res.json({
      buildId: req.params.buildId,
      path: safePath,
      content,
      size: stats.size,
    });
  })
);

/**
 * PUT /compile/:buildId/file
 * Save file content
 */
app.put('/compile/:buildId/file',
  validateBuildId,
  validateFileContent,
  asyncHandler(async (req, res) => {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const { path: filePath, content } = req.body;
    const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(config.builds.uploadDir, req.params.buildId, safePath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');

    logger.build(req.params.buildId, 'info', `File saved: ${safePath}`);

    res.json({
      buildId: req.params.buildId,
      path: safePath,
      success: true,
      message: 'File saved',
    });
  })
);

/**
 * DELETE /compile/:buildId/file
 * Delete a file or folder
 */
app.delete('/compile/:buildId/file',
  validateBuildId,
  asyncHandler(async (req, res) => {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const { path: filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'Missing path' });
    }

    const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const projectDir = path.join(config.builds.uploadDir, req.params.buildId);
    const fullPath = path.join(projectDir, safePath);

    if (path.resolve(fullPath) === path.resolve(projectDir)) {
      return res.status(400).json({ error: 'Cannot delete project root' });
    }

    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      await fs.rm(fullPath, { recursive: true, force: true });
    } else {
      await fs.unlink(fullPath);
    }

    res.json({ buildId: req.params.buildId, path: safePath, success: true });
  })
);

/**
 * POST /compile/:buildId/folder
 * Create a folder
 */
app.post('/compile/:buildId/folder',
  validateBuildId,
  asyncHandler(async (req, res) => {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const { path: folderPath } = req.body;
    if (!folderPath) {
      return res.status(400).json({ error: 'Missing path' });
    }

    const safePath = path.normalize(folderPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(config.builds.uploadDir, req.params.buildId, safePath);
    await fs.mkdir(fullPath, { recursive: true });

    res.json({ buildId: req.params.buildId, path: safePath, success: true });
  })
);

/**
 * POST /compile/:buildId/verify-structure
 * Use AI to verify and fix project structure
 */
app.post('/compile/:buildId/verify-structure',
  aiLimiter,
  validateBuildId,
  asyncHandler(async (req, res) => {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const projectDir = path.join(config.builds.uploadDir, req.params.buildId);
    const { verifyAndFixStructure } = require('./ai');

    logger.build(req.params.buildId, 'info', 'AI structure verification started');

    const aiResult = await verifyAndFixStructure(req.params.buildId, projectDir);

    if (!aiResult.success) {
      return res.status(500).json({
        error: 'AI structure verification failed',
        details: aiResult.error,
      });
    }

    res.json({
      buildId: req.params.buildId,
      analysis: aiResult.analysis,
      fixes: aiResult.fixes,
      filesCreated: aiResult.fixes.length,
      autoFixed: aiResult.autoFixed,
      message: aiResult.fixes.length > 0
        ? `✅ AI created ${aiResult.fixes.length} missing file(s). Ready to build!`
        : '✅ Project structure is valid. Ready to build!',
    });
  })
);

/**
 * POST /compile/:buildId/smart-build
 * AI-powered build loop: verify → build → fix → retry (max 4 iterations)
 */
app.post('/compile/:buildId/smart-build',
  aiLimiter,
  validateBuildId,
  asyncHandler(async (req, res) => {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    if (build.status === BuildStatus.RUNNING) {
      return res.status(409).json({ error: 'Build already running' });
    }

    const projectDir = path.join(config.builds.uploadDir, req.params.buildId);
    const outputDir = path.join(config.builds.buildDir, req.params.buildId, 'output');
    const { smartBuild } = require('./smartBuild');

    logger.build(req.params.buildId, 'info', 'Smart build started');

    build.status = BuildStatus.RUNNING;
    build.updatedAt = new Date();
    build.logs = { stdout: '', stderr: '' };
    build.smartBuild = true;

    // Run smart build asynchronously
    smartBuild(
      req.params.buildId,
      projectDir,
      outputDir,
      (progressEvent) => {
        // Broadcast progress via WebSocket
        broadcastSmartBuildProgress(req.params.buildId, progressEvent);

        // Forward build logs
        if (progressEvent.type === 'build_log') {
          build.logs = progressEvent.details;
          broadcastLog(req.params.buildId, progressEvent.details);
        }

        build.smartBuildPhase = progressEvent.phase;
        build.smartBuildIteration = progressEvent.iteration;
        build.updatedAt = new Date();
      }
    )
      .then(result => {
        build.status = result.success ? BuildStatus.SUCCESS : BuildStatus.FAILED;
        build.completedAt = new Date();
        build.updatedAt = new Date();
        build.smartBuildResult = result;

        if (result.finalBuild) {
          build.logs = result.finalBuild.logs || build.logs;
          build.exitCode = result.finalBuild.exitCode;
        }

        if (!result.success) {
          build.error = result.cannotFixReason || 'Smart build failed after all retries';
        }

        broadcastStatus(req.params.buildId, build.status);
      })
      .catch(error => {
        logger.build(req.params.buildId, 'error', `Smart build error: ${error.message}`);
        build.status = BuildStatus.FAILED;
        build.completedAt = new Date();
        build.updatedAt = new Date();
        build.error = error.message;
        broadcastStatus(req.params.buildId, BuildStatus.FAILED);
      });

    res.status(202).json({
      buildId: req.params.buildId,
      status: 'accepted',
      message: 'Smart build started (AI-powered verify → build → fix → retry)',
      maxIterations: config.smartBuild.maxIterations,
      wsUrl: `/ws?buildId=${req.params.buildId}`,
    });
  })
);

/**
 * POST /compile/:buildId/restart
 * Restart/trigger build
 */
app.post('/compile/:buildId/restart',
  validateBuildId,
  validateRestart,
  asyncHandler(async (req, res) => {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const { clean } = req.body;
    const projectDir = path.join(config.builds.uploadDir, req.params.buildId);

    if (clean) {
      const targetDir = path.join(projectDir, 'target');
      try {
        await fs.rm(targetDir, { recursive: true, force: true });
        logger.build(req.params.buildId, 'info', 'Cleaned target directory');
      } catch (err) {
        logger.build(req.params.buildId, 'info', 'No target directory to clean');
      }
    }

    const { executeAnchorBuild } = require('./docker');
    const outputPath = path.join(config.builds.buildDir, req.params.buildId, 'output');

    async function findAnchorToml(dir, relativePath = '') {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(relativePath, entry.name);
        
        if (entry.name === 'Anchor.toml') {
          return relativePath;
        }
        
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'target') {
          const found = await findAnchorToml(fullPath, relPath);
          if (found) return found;
        }
      }
      
      return null;
    }

    const anchorSubdir = await findAnchorToml(projectDir) || '';

    build.status = BuildStatus.RUNNING;
    build.updatedAt = new Date();
    build.logs = { stdout: '', stderr: '' };

    executeAnchorBuild(
      req.params.buildId, 
      projectDir, 
      outputPath, 
      anchorSubdir,
      (logs) => {
        build.logs = logs;
        build.updatedAt = new Date();
        broadcastLog(req.params.buildId, logs);
      }
    )
      .then(result => {
        build.status = result.success ? BuildStatus.SUCCESS : BuildStatus.FAILED;
        build.completedAt = new Date();
        build.updatedAt = new Date();
        build.logs = result.logs || build.logs;
        build.exitCode = result.exitCode;
        
        if (!result.success) {
          build.error = result.error || 'Build failed';
        }
        
        broadcastStatus(req.params.buildId, build.status);
      })
      .catch(error => {
        build.status = BuildStatus.FAILED;
        build.completedAt = new Date();
        build.updatedAt = new Date();
        build.error = error.message;
        broadcastStatus(req.params.buildId, BuildStatus.FAILED);
      });

    res.json({
      buildId: req.params.buildId,
      status: 'accepted',
      message: clean ? 'Clean build started' : 'Build restarted',
      clean,
      wsUrl: `/ws?buildId=${req.params.buildId}`,
    });
  })
);

/**
 * GET /builds
 * List all builds
 */
app.get('/builds',
  apiLimiter,
  asyncHandler(async (req, res) => {
    const builds = listBuilds();
    
    const summary = builds.map(build => ({
      buildId: build.id,
      status: build.status,
      createdAt: build.createdAt,
      updatedAt: build.updatedAt,
      completedAt: build.completedAt,
    }));

    res.json({ builds: summary });
  })
);

// ===== ERROR HANDLING =====

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error(`Error: ${err.message}`, { stack: err.stack });

  // Multer errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        maxSize: `${config.builds.maxUploadSize / 1024 / 1024} MB`,
      });
    }
    return res.status(400).json({ error: err.message });
  }

  // Default error
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// ===== SERVER STARTUP =====

async function startServer() {
  try {
    // Verify Docker image exists
    const dockerReady = await verifyDockerImage();
    if (!dockerReady) {
      logger.warn('Docker image not found. Building may fail.');
    } else {
      logger.info(`✓ Docker image found: ${config.dockerImage}`);
    }

    // Create necessary directories
    await fs.mkdir(config.builds.uploadDir, { recursive: true });
    await fs.mkdir(config.builds.buildDir, { recursive: true });

    // Initialize WebSocket server
    initWebSocket(server);

    // Start HTTP server
    const PORT = config.port || 5000;
    server.listen(PORT, () => {
      logger.info('='.repeat(60));
      logger.info('🚀 Anchor Compiler Service Started (Production Mode)');
      logger.info(`Port: ${PORT}`);
      logger.info(`Docker Image: ${config.dockerImage}`);
      logger.info(`Build Timeout: ${config.builds.timeout}s`);
      logger.info(`Max Upload Size: ${config.builds.maxUploadSize / 1024 / 1024} MB`);
      logger.info(`Memory Limit: ${config.docker.memory / 1024 / 1024 / 1024} GB`);
      logger.info(`CPU Limit: ${config.docker.cpus} cores`);
      logger.info(`WebSocket: Enabled on /ws`);
      logger.info(`API Authentication: ${process.env.API_KEY ? 'Enabled' : 'Disabled'}`);
      logger.info('');
      logger.info('Endpoints:');
      logger.info('  POST   /compile');
      logger.info('  POST   /compile/github');
      logger.info('  POST   /compile/:buildId/restart');
      logger.info('  POST   /compile/:buildId/verify-structure');
      logger.info('  POST   /compile/:buildId/smart-build');
      logger.info('  GET    /compile/:buildId/status');
      logger.info('  GET    /compile/:buildId/artifacts');
      logger.info('  GET    /compile/:buildId/artifacts/download/:type/:filename');
      logger.info('  GET    /compile/:buildId/files');
      logger.info('  GET    /compile/:buildId/file?path=...');
      logger.info('  PUT    /compile/:buildId/file');
      logger.info('  GET    /builds');
      logger.info('  GET    /health');
      logger.info('  WS     /ws');
      logger.info('='.repeat(60));
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      logger.info('\nSIGINT received, shutting down gracefully...');
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
if (require.main === module) {
  startServer();
}

module.exports = { app, server };
