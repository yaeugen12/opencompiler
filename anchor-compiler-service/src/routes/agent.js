const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const config = require('../config');
const { registerAgent, claimAgent, getAgentByCode, listAgents, revokeAgent } = require('../agentAuth');
const { requireAgentKey, requireAdminKey, agentApiLimiter, agentBuildLimiter } = require('../middleware/agentAuth');
const {
  getBuildStatus,
  getBuildArtifacts,
  createProjectFromFiles,
  startBuildFromGithub,
  updateBuildStatus,
  BuildStatus,
} = require('../buildManager');

const router = express.Router();

// ============================================================
// PER-AGENT BUILD CONCURRENCY (max 1 active build at a time)
// ============================================================
const activeAgentBuilds = new Map(); // agentId → { buildId, startedAt }

function getActiveAgentBuild(agentId) {
  return activeAgentBuilds.get(agentId) || null;
}

function setActiveAgentBuild(agentId, buildId) {
  activeAgentBuilds.set(agentId, { buildId, startedAt: Date.now() });
}

function clearActiveAgentBuild(agentId) {
  activeAgentBuilds.delete(agentId);
}

// ============================================================
// ERROR EXTRACTION — surface compilation errors clearly
// ============================================================

/**
 * Extract meaningful compilation errors from raw Docker build logs.
 * Returns an array of error strings, max 20.
 */
function extractCompilationErrors(logs) {
  if (!logs) return [];
  const stdout = typeof logs === 'object' ? (logs.stdout || '') : String(logs);
  const stderr = typeof logs === 'object' ? (logs.stderr || '') : '';
  const combined = stdout + '\n' + stderr;
  const lines = combined.split('\n');
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Rust compiler errors: error[E0123]: message
    if (/^error\[E\d+\]/.test(line) || /^error:/.test(line)) {
      // Collect the error + next few lines of context (file location, hint)
      let block = line;
      for (let j = 1; j <= 4 && i + j < lines.length; j++) {
        const next = lines[i + j].trim();
        if (next.startsWith('-->') || next.startsWith('|') || next.startsWith('=')) {
          block += '\n' + next;
        } else {
          break;
        }
      }
      errors.push(block);
    }
    // Anchor-specific errors
    if (line.includes('Failed to obtain package metadata')) errors.push(line);
    if (line.includes("can't find library")) errors.push(line);
  }

  // Deduplicate and cap at 20
  return [...new Set(errors)].slice(0, 20);
}

// ============================================================
// KEYPAIR EXTRACTION — inline in response, then delete from disk
// ============================================================

/**
 * Read keypair files from build output and parse public keys.
 * Returns array of { name, filename, pubkey, secret }.
 */
async function extractKeypairs(outputDir) {
  const keypairs = [];
  const deployDir = path.join(outputDir, 'target', 'deploy');
  try {
    const files = await fs.readdir(deployDir);
    const { Keypair } = require('@solana/web3.js');
    for (const file of files) {
      if (file.endsWith('-keypair.json')) {
        try {
          const raw = JSON.parse(await fs.readFile(path.join(deployDir, file), 'utf-8'));
          const kp = Keypair.fromSecretKey(new Uint8Array(raw));
          keypairs.push({
            name: file.replace('-keypair.json', ''),
            filename: file,
            pubkey: kp.publicKey.toBase58(),
            secret: raw,
          });
        } catch (e) {
          console.warn(`Failed to parse keypair ${file}:`, e.message);
        }
      }
    }
  } catch (e) { /* no deploy dir = no keypairs */ }
  return keypairs;
}

/**
 * Delete keypair files from disk after they've been sent to the agent.
 */
async function deleteKeypairFiles(outputDir, keypairs) {
  const deployDir = path.join(outputDir, 'target', 'deploy');
  for (const kp of keypairs) {
    try {
      await fs.unlink(path.join(deployDir, kp.filename));
      console.log(`[security] Deleted keypair file: ${kp.filename}`);
    } catch (e) { /* already gone */ }
  }
}

// ============================================================
// AGENT MANAGEMENT
// ============================================================

/**
 * POST /api/v1/agent/register
 * Register a new agent — returns API key + claim URL for X verification
 */
router.post('/agent/register', async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required (non-empty string)' });
    }

    const agent = await registerAgent(name.trim(), description ? description.trim() : null);

    // Build claim URL from request
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const claimUrl = `${protocol}://${host}/claim/${agent.verification_code}`;

    // Build skill URL for agent discovery
    const baseUrl = `${protocol}://${host}`;
    const skillUrl = `${baseUrl}/skill.md`;

    // Read skill.md to include in response
    let skillContent = null;
    try {
      const skillPath = path.join(__dirname, '..', '..', 'skill.md');
      skillContent = await fs.readFile(skillPath, 'utf-8');
    } catch (e) { /* skill.md not found — non-fatal */ }

    res.status(201).json({
      agent_id: agent.agent_id,
      api_key: agent.api_key,
      name: agent.name,
      description: agent.description,
      claim_url: claimUrl,
      verification_code: agent.verification_code,
      claim_status: agent.claim_status,
      created_at: agent.created_at,
      message: 'Store this API key securely. It cannot be retrieved later. Send the claim_url to your human operator to verify ownership via X.',
      skill_url: skillUrl,
      skill: skillContent,
      quick_reference: {
        auth_header: 'X-Agent-Key: ' + agent.api_key,
        build_endpoint: 'POST ' + baseUrl + '/api/v1/build',
        build_from_files: {
          method: 'POST',
          url: baseUrl + '/api/v1/build',
          headers: { 'X-Agent-Key': agent.api_key, 'Content-Type': 'application/json' },
          body: '{ "name": "program_name", "files": { "programs/<name>/src/lib.rs": "...", "Anchor.toml": "...", "Cargo.toml": "..." }, "smartBuild": true }',
        },
        build_from_github: {
          method: 'POST',
          url: baseUrl + '/api/v1/build',
          headers: { 'X-Agent-Key': agent.api_key, 'Content-Type': 'application/json' },
          body: '{ "github_url": "https://github.com/user/repo", "smartBuild": true }',
        },
        check_status: 'GET ' + baseUrl + '/api/v1/build/:buildId',
        get_artifacts: 'GET ' + baseUrl + '/api/v1/build/:buildId/artifacts',
        get_idl: 'GET ' + baseUrl + '/api/v1/build/:buildId/idl',
        fix_errors: {
          list_files: 'GET ' + baseUrl + '/api/v1/project/:buildId/files',
          read_file: 'GET ' + baseUrl + '/api/v1/project/:buildId/file?path=<file_path>',
          write_file: 'POST ' + baseUrl + '/api/v1/project/:buildId/file  body: { path, content }',
          delete_file: 'DELETE ' + baseUrl + '/api/v1/project/:buildId/file  body: { path }',
          rebuild: 'POST ' + baseUrl + '/api/v1/project/:buildId/build',
        },
        websocket: 'ws://' + host + '/ws — send {"action":"subscribe","buildId":"<id>"}',
        important: 'Only 1 concurrent build per agent. Builds take 3-7 minutes. Max 20 builds/hour. If build fails, read the errors, fix files, and rebuild.',
      },
    });
  } catch (error) {
    console.error('Agent register error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/v1/claim/:code
 * Complete agent claim — link agent to X handle after tweeting
 */
router.post('/claim/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { x_handle } = req.body;

    if (!x_handle || typeof x_handle !== 'string' || x_handle.trim().length === 0) {
      return res.status(400).json({ error: 'x_handle is required' });
    }

    const result = await claimAgent(code, x_handle);

    res.json({
      success: true,
      agent_id: result.agent_id,
      name: result.name,
      x_handle: result.x_handle,
      x_url: `https://x.com/${result.x_handle}`,
      claim_status: result.claim_status,
      message: `Agent "${result.name}" has been claimed by @${result.x_handle}`,
    });
  } catch (error) {
    console.error('Claim error:', error);
    const status = error.message.includes('Invalid') || error.message.includes('expired') ? 404
      : error.message.includes('already') ? 409
      : 400;
    res.status(status).json({ error: error.message });
  }
});

/**
 * GET /api/v1/agent/status
 * Check own agent's claim status (requires API key)
 */
router.get('/agent/status', requireAgentKey, async (req, res) => {
  res.json({
    agent_id: req.agent.agent_id,
    name: req.agent.name,
    claim_status: req.agent.claim_status || 'pending',
    x_handle: req.agent.x_handle || null,
  });
});

/**
 * GET /api/v1/agent/list
 * List all registered agents (admin only)
 */
router.get('/agent/list', requireAdminKey, async (req, res) => {
  try {
    const agents = await listAgents();
    res.json({ agents });
  } catch (error) {
    console.error('Agent list error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/v1/agent/:agentId/revoke
 * Revoke an agent's API key (admin only)
 */
router.post('/agent/:agentId/revoke', requireAdminKey, async (req, res) => {
  try {
    const success = await revokeAgent(req.params.agentId);
    if (!success) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json({ message: 'Agent revoked successfully' });
  } catch (error) {
    console.error('Agent revoke error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// PROJECT CREATION
// ============================================================

/**
 * POST /api/v1/project/create
 * Create a project from a JSON file map (no ZIP upload)
 */
router.post('/project/create', agentApiLimiter, requireAgentKey, async (req, res) => {
  try {
    const { name, files } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
      return res.status(400).json({ error: 'files is required (non-empty object mapping paths to contents)' });
    }

    const fileKeys = Object.keys(files);
    if (fileKeys.length > config.agent.maxFilesPerProject) {
      return res.status(400).json({ error: `Too many files. Maximum: ${config.agent.maxFilesPerProject}` });
    }

    let totalSize = 0;
    for (const content of Object.values(files)) {
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'All file contents must be strings' });
      }
      totalSize += Buffer.byteLength(content, 'utf-8');
    }
    if (totalSize > config.agent.maxTotalFileSize) {
      return res.status(400).json({
        error: `Total file size exceeds limit. Maximum: ${config.agent.maxTotalFileSize / 1024 / 1024}MB`,
      });
    }

    const buildId = await createProjectFromFiles(name, files, {
      source: 'agent',
      agentId: req.agent.agent_id,
    });

    res.status(201).json({
      buildId,
      status: 'ready',
      fileCount: fileKeys.length,
      message: 'Project created. Use POST /api/v1/project/:buildId/build to compile.',
    });
  } catch (error) {
    console.error('Project create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ONE-SHOT BUILD
// ============================================================

/**
 * POST /api/v1/build
 * Send code + get compiled result (synchronous, up to 10 min)
 */
router.post('/build', agentBuildLimiter, requireAgentKey, async (req, res) => {
  try {
    const { name, files, github_url, smartBuild: useSmartBuild = true, timeout = 600 } = req.body;

    // ── Per-agent concurrency check ──
    const agentId = req.agent.agent_id;
    const activeBuild = getActiveAgentBuild(agentId);
    if (activeBuild) {
      return res.status(409).json({
        error: 'You already have an active build running. Wait for it to complete or check its status.',
        activeBuildId: activeBuild.buildId,
        statusUrl: `/api/v1/build/${activeBuild.buildId}`,
        startedAt: new Date(activeBuild.startedAt).toISOString(),
      });
    }

    // Must provide either files or github_url
    const isGithubBuild = !!github_url;

    if (!isGithubBuild) {
      // ── Inline files mode ──
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'name is required' });
      }
      if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
        return res.status(400).json({ error: 'files is required (non-empty object mapping paths to contents). Or use github_url to build from a GitHub repo.' });
      }

      const fileKeys = Object.keys(files);
      if (fileKeys.length > config.agent.maxFilesPerProject) {
        return res.status(400).json({ error: `Too many files. Maximum: ${config.agent.maxFilesPerProject}` });
      }

      let totalSize = 0;
      for (const content of Object.values(files)) {
        if (typeof content !== 'string') {
          return res.status(400).json({ error: 'All file contents must be strings' });
        }
        totalSize += Buffer.byteLength(content, 'utf-8');
      }
      if (totalSize > config.agent.maxTotalFileSize) {
        return res.status(400).json({
          error: `Total file size exceeds limit. Maximum: ${config.agent.maxTotalFileSize / 1024 / 1024}MB`,
        });
      }
    } else {
      // ── GitHub URL mode ──
      const githubRegex = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+/;
      if (!githubRegex.test(github_url)) {
        return res.status(400).json({ error: 'Invalid github_url. Must be a GitHub repository URL (https://github.com/owner/repo).' });
      }
    }

    // Set long timeout for this request
    const effectiveTimeout = Math.min(timeout, config.agent.buildTimeout) * 1000;
    req.setTimeout(effectiveTimeout + 10000);
    res.setTimeout(effectiveTimeout + 10000);

    const startTime = Date.now();

    let buildId;
    if (isGithubBuild) {
      // Clone repo (autoBuild=false so we control the build ourselves)
      buildId = await startBuildFromGithub(github_url, false, { agentId: req.agent.agent_id });
    } else {
      buildId = await createProjectFromFiles(name, files, {
        source: 'agent',
        agentId: req.agent.agent_id,
      });
    }

    // ── Lock: mark this agent as having an active build ──
    setActiveAgentBuild(agentId, buildId);

    const projectDir = path.join(config.builds.uploadDir, buildId);
    const outputDir = path.join(config.builds.buildDir, buildId);

    let result;
    try {
      if (useSmartBuild) {
        const { smartBuild } = require('../smartBuild');
        result = await smartBuild(buildId, projectDir, outputDir, null);
      } else {
        const { executeAnchorBuild } = require('../docker');
        const { findAnchorTomlSubdir } = require('../smartBuild');
        const anchorSubdir = await findAnchorTomlSubdir(projectDir) || '';
        result = await executeAnchorBuild(buildId, projectDir, outputDir, anchorSubdir);
      }
    } finally {
      // ── Unlock: always clear active build, even on error ──
      clearActiveAgentBuild(agentId);
    }

    // Update build status in the map
    const build = getBuildStatus(buildId);
    if (build) {
      const finalLogs = result.finalBuild?.logs || result.logs || build.logs;
      const finalExitCode = result.finalBuild?.exitCode ?? result.exitCode;
      updateBuildStatus(buildId, result.success ? BuildStatus.SUCCESS : BuildStatus.FAILED, {
        logs: finalLogs,
        exitCode: finalExitCode,
        completedAt: new Date(),
        error: result.success ? undefined : (result.cannotFixReason || result.error || 'Build failed'),
      });
    }

    // Gather artifacts if successful
    let artifacts = null;
    if (result.success) {
      try {
        const rawArtifacts = await getBuildArtifacts(buildId);
        artifacts = {
          programs: rawArtifacts.programs.map(a => ({
            name: a.name,
            type: a.type,
            downloadUrl: `/compile/${buildId}/artifacts/download/${a.type}/${a.name}`,
          })),
          idl: rawArtifacts.idl.map(a => ({
            name: a.name,
            type: a.type,
            downloadUrl: `/compile/${buildId}/artifacts/download/${a.type}/${a.name}`,
          })),
          types: rawArtifacts.types.map(a => ({
            name: a.name,
            type: a.type,
            downloadUrl: `/compile/${buildId}/artifacts/download/${a.type}/${a.name}`,
          })),
          deploy: (rawArtifacts.deploy || []).map(a => ({
            name: a.name,
            type: a.type,
            downloadUrl: `/compile/${buildId}/artifacts/download/${a.type}/${a.name}`,
          })),
        };
      } catch (e) {
        console.warn(`[${buildId}] Could not gather artifacts:`, e.message);
      }
    }

    const finalBuildLogs = result.finalBuild?.logs || result.logs || null;
    const compilationErrors = result.success ? [] : extractCompilationErrors(finalBuildLogs);

    // Extract keypairs from build output (will be inlined in response, then deleted)
    let keypairs = [];
    if (result.success) {
      keypairs = await extractKeypairs(outputDir);
    }

    const response = {
      buildId,
      source: isGithubBuild ? 'github' : 'inline',
      status: result.success ? 'success' : 'failed',
      iterations: result.iterations || 1,
      artifacts,
      keypairs: keypairs.length > 0 ? keypairs : undefined,
      logs: finalBuildLogs,
      errors: compilationErrors,
      error: result.success ? null : (result.cannotFixReason || result.error || 'Build failed'),
      buildDuration: Math.round((Date.now() - startTime) / 1000),
    };

    // If build failed, give the agent clear next steps for fixing
    if (!result.success) {
      response.next_steps = {
        message: 'Build failed. Read the errors, fix the source files, then rebuild.',
        list_files: `GET /api/v1/project/${buildId}/files`,
        read_file: `GET /api/v1/project/${buildId}/file?path=<file_path>`,
        write_file: `POST /api/v1/project/${buildId}/file`,
        delete_file: `DELETE /api/v1/project/${buildId}/file`,
        rebuild: `POST /api/v1/project/${buildId}/build`,
      };
    }

    res.json(response);

    // Security: delete keypair files from disk after responding
    if (keypairs.length > 0) {
      await deleteKeypairFiles(outputDir, keypairs);
    }
  } catch (error) {
    // Ensure we clear the lock on unexpected errors
    if (req.agent) clearActiveAgentBuild(req.agent.agent_id);
    console.error('Agent build error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// BUILD ON EXISTING PROJECT
// ============================================================

/**
 * POST /api/v1/project/:buildId/build
 * Trigger build on an existing project (synchronous)
 */
router.post('/project/:buildId/build', agentBuildLimiter, requireAgentKey, async (req, res) => {
  try {
    const { buildId } = req.params;
    const { smartBuild: useSmartBuild = true, timeout = 600 } = req.body || {};

    // ── Per-agent concurrency check ──
    const agentId = req.agent.agent_id;
    const activeBuild = getActiveAgentBuild(agentId);
    if (activeBuild) {
      return res.status(409).json({
        error: 'You already have an active build running. Wait for it to complete or check its status.',
        activeBuildId: activeBuild.buildId,
        statusUrl: `/api/v1/build/${activeBuild.buildId}`,
        startedAt: new Date(activeBuild.startedAt).toISOString(),
      });
    }

    const build = getBuildStatus(buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build/project not found' });
    }

    if (build.status === BuildStatus.RUNNING) {
      return res.status(409).json({ error: 'Build already running' });
    }

    const effectiveTimeout = Math.min(timeout, config.agent.buildTimeout) * 1000;
    req.setTimeout(effectiveTimeout + 10000);
    res.setTimeout(effectiveTimeout + 10000);

    const startTime = Date.now();
    const projectDir = path.join(config.builds.uploadDir, buildId);
    const outputDir = path.join(config.builds.buildDir, buildId);

    // ── Lock: mark this agent as having an active build ──
    setActiveAgentBuild(agentId, buildId);

    let result;
    try {
      if (useSmartBuild) {
        const { smartBuild } = require('../smartBuild');
        result = await smartBuild(buildId, projectDir, outputDir, null);
      } else {
        const { executeAnchorBuild } = require('../docker');
        const { findAnchorTomlSubdir } = require('../smartBuild');
        const anchorSubdir = await findAnchorTomlSubdir(projectDir) || '';
        result = await executeAnchorBuild(buildId, projectDir, outputDir, anchorSubdir);
      }
    } finally {
      // ── Unlock: always clear active build, even on error ──
      clearActiveAgentBuild(agentId);
    }

    // Update status
    const finalLogs = result.finalBuild?.logs || result.logs || build.logs;
    const finalExitCode = result.finalBuild?.exitCode ?? result.exitCode;
    updateBuildStatus(buildId, result.success ? BuildStatus.SUCCESS : BuildStatus.FAILED, {
      logs: finalLogs,
      exitCode: finalExitCode,
      completedAt: new Date(),
      error: result.success ? undefined : (result.cannotFixReason || result.error || 'Build failed'),
    });

    // Gather artifacts
    let artifacts = null;
    if (result.success) {
      try {
        const rawArtifacts = await getBuildArtifacts(buildId);
        artifacts = {
          programs: rawArtifacts.programs.map(a => ({
            name: a.name, type: a.type,
            downloadUrl: `/compile/${buildId}/artifacts/download/${a.type}/${a.name}`,
          })),
          idl: rawArtifacts.idl.map(a => ({
            name: a.name, type: a.type,
            downloadUrl: `/compile/${buildId}/artifacts/download/${a.type}/${a.name}`,
          })),
          types: rawArtifacts.types.map(a => ({
            name: a.name, type: a.type,
            downloadUrl: `/compile/${buildId}/artifacts/download/${a.type}/${a.name}`,
          })),
          deploy: (rawArtifacts.deploy || []).map(a => ({
            name: a.name, type: a.type,
            downloadUrl: `/compile/${buildId}/artifacts/download/${a.type}/${a.name}`,
          })),
        };
      } catch (e) { /* ignore */ }
    }

    const compilationErrors = result.success ? [] : extractCompilationErrors(finalLogs);

    // Extract keypairs from build output (will be inlined in response, then deleted)
    let keypairs = [];
    if (result.success) {
      keypairs = await extractKeypairs(outputDir);
    }

    const response = {
      buildId,
      status: result.success ? 'success' : 'failed',
      iterations: result.iterations || 1,
      artifacts,
      keypairs: keypairs.length > 0 ? keypairs : undefined,
      logs: finalLogs,
      errors: compilationErrors,
      error: result.success ? null : (result.cannotFixReason || result.error || 'Build failed'),
      buildDuration: Math.round((Date.now() - startTime) / 1000),
    };

    // If build failed, give the agent clear next steps for fixing
    if (!result.success) {
      response.next_steps = {
        message: 'Build failed. Read the errors, fix the source files, then rebuild.',
        list_files: `GET /api/v1/project/${buildId}/files`,
        read_file: `GET /api/v1/project/${buildId}/file?path=<file_path>`,
        write_file: `POST /api/v1/project/${buildId}/file`,
        delete_file: `DELETE /api/v1/project/${buildId}/file`,
        rebuild: `POST /api/v1/project/${buildId}/build`,
      };
    }

    res.json(response);

    // Security: delete keypair files from disk after responding
    if (keypairs.length > 0) {
      await deleteKeypairFiles(outputDir, keypairs);
    }
  } catch (error) {
    // Ensure we clear the lock on unexpected errors
    if (req.agent) clearActiveAgentBuild(req.agent.agent_id);
    console.error('Agent project build error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// FILE MANAGEMENT
// ============================================================

/**
 * GET /api/v1/project/:buildId/files
 * List all files in the project (recursive tree)
 */
router.get('/project/:buildId/files', agentApiLimiter, requireAgentKey, async (req, res) => {
  try {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build/project not found' });
    }

    const projectDir = path.join(config.builds.uploadDir, req.params.buildId);

    async function listFilesRecursive(dir, relativePath = '') {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = [];

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

        // Skip node_modules and target directories
        if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === 'target' || entry.name === '.anchor')) {
          continue;
        }

        if (entry.isDirectory()) {
          const children = await listFilesRecursive(fullPath, relPath);
          files.push({ name: entry.name, path: relPath, type: 'directory', children });
        } else {
          const stats = await fs.stat(fullPath);
          files.push({ name: entry.name, path: relPath, type: 'file', size: stats.size });
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
  } catch (error) {
    console.error('Agent list files error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/v1/project/:buildId/file?path=src/lib.rs
 * Read a file's content from the project
 */
router.get('/project/:buildId/file', agentApiLimiter, requireAgentKey, async (req, res) => {
  try {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build/project not found' });
    }

    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Missing ?path= query parameter' });
    }

    // Security: prevent path traversal
    const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(config.builds.uploadDir, req.params.buildId, safePath);

    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory, not a file' });
    }

    const content = await fs.readFile(fullPath, 'utf-8');

    res.json({
      buildId: req.params.buildId,
      path: safePath,
      content,
      size: stats.size,
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Agent read file error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/v1/project/:buildId/file
 * Delete a file or folder from the project
 */
router.delete('/project/:buildId/file', agentApiLimiter, requireAgentKey, async (req, res) => {
  try {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build/project not found' });
    }

    const { path: filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'path is required in request body' });
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

    res.json({
      buildId: req.params.buildId,
      path: safePath,
      success: true,
      message: stats.isDirectory() ? 'Folder deleted' : 'File deleted',
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Path not found' });
    }
    console.error('Agent delete file error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/v1/project/:buildId/file
 * Write/update a file in existing project
 */
router.post('/project/:buildId/file', agentApiLimiter, requireAgentKey, async (req, res) => {
  try {
    const build = getBuildStatus(req.params.buildId);
    if (!build) {
      return res.status(404).json({ error: 'Build/project not found' });
    }

    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'path and content are required' });
    }

    const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(config.builds.uploadDir, req.params.buildId, safePath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');

    res.json({
      buildId: req.params.buildId,
      path: safePath,
      success: true,
      message: 'File saved',
    });
  } catch (error) {
    console.error('Agent file write error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// BUILD STATUS & ARTIFACTS
// ============================================================

/**
 * GET /api/v1/build/:buildId
 * Get build status and logs
 */
router.get('/build/:buildId', agentApiLimiter, requireAgentKey, async (req, res) => {
  try {
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
      if (build.error) response.error = build.error;
    }

    res.json(response);
  } catch (error) {
    console.error('Agent build status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/v1/build/:buildId/artifacts
 * List build artifacts with download URLs
 */
router.get('/build/:buildId/artifacts', agentApiLimiter, requireAgentKey, async (req, res) => {
  try {
    const { buildId } = req.params;
    const rawArtifacts = await getBuildArtifacts(buildId);

    const mapArtifact = (a) => ({
      name: a.name,
      type: a.type,
      downloadUrl: `/compile/${buildId}/artifacts/download/${a.type}/${a.name}`,
    });

    res.json({
      buildId,
      artifacts: {
        programs: rawArtifacts.programs.map(mapArtifact),
        idl: rawArtifacts.idl.map(mapArtifact),
        types: rawArtifacts.types.map(mapArtifact),
        deploy: (rawArtifacts.deploy || []).map(mapArtifact),
      },
    });
  } catch (error) {
    console.error('Agent artifacts error:', error);
    const status = error.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

/**
 * GET /api/v1/build/:buildId/idl
 * Return IDL JSON directly (convenience for agents)
 */
router.get('/build/:buildId/idl', agentApiLimiter, requireAgentKey, async (req, res) => {
  try {
    const rawArtifacts = await getBuildArtifacts(req.params.buildId);

    if (!rawArtifacts.idl || rawArtifacts.idl.length === 0) {
      return res.status(404).json({ error: 'No IDL found for this build' });
    }

    const idlPath = rawArtifacts.idl[0].path;
    const idlContent = await fs.readFile(idlPath, 'utf-8');
    const idlJson = JSON.parse(idlContent);

    res.json({
      buildId: req.params.buildId,
      name: rawArtifacts.idl[0].name,
      idl: idlJson,
    });
  } catch (error) {
    console.error('Agent IDL error:', error);
    const status = error.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

// ============================================================
// DISCOVERY
// ============================================================

/**
 * GET /api/v1/skill
 * Returns the skill.md content — allows agents to discover this platform programmatically
 */
router.get('/skill', async (req, res) => {
  try {
    const skillPath = path.join(__dirname, '..', '..', 'skill.md');
    const content = await fs.readFile(skillPath, 'utf-8');
    res.type('text/markdown').send(content);
  } catch (error) {
    res.status(404).json({ error: 'skill.md not found' });
  }
});

/**
 * GET /api/v1/info
 * Machine-readable JSON summary of the platform capabilities
 */
router.get('/info', (req, res) => {
  res.json({
    name: 'OpenCompiler - Anchor Compiler',
    version: '1.0.0',
    description: 'AI-accessible Solana Anchor smart contract compilation, building, and deployment service',
    auth: {
      type: 'api_key',
      header: 'X-Agent-Key',
      registration: 'POST /api/v1/agent/register',
    },
    capabilities: [
      'compile_solana_programs',
      'build_from_github',
      'ai_powered_build_fixing',
      'idl_generation',
      'typescript_type_generation',
      'program_deployment',
    ],
    endpoints: {
      register: 'POST /api/v1/agent/register',
      claim: 'POST /api/v1/claim/:code',
      claimPage: 'GET /claim/:code',
      agentStatus: 'GET /api/v1/agent/status',
      build: 'POST /api/v1/build (accepts files OR github_url)',
      createProject: 'POST /api/v1/project/create',
      buildProject: 'POST /api/v1/project/:buildId/build',
      listFiles: 'GET /api/v1/project/:buildId/files',
      readFile: 'GET /api/v1/project/:buildId/file?path=<file_path>',
      writeFile: 'POST /api/v1/project/:buildId/file',
      deleteFile: 'DELETE /api/v1/project/:buildId/file',
      buildStatus: 'GET /api/v1/build/:buildId',
      artifacts: 'GET /api/v1/build/:buildId/artifacts',
      idl: 'GET /api/v1/build/:buildId/idl',
      skill: 'GET /api/v1/skill',
    },
    limits: {
      maxFilesPerProject: config.agent.maxFilesPerProject,
      maxTotalFileSize: `${config.agent.maxTotalFileSize / 1024 / 1024}MB`,
      buildTimeout: `${config.agent.buildTimeout}s`,
      apiRateLimit: '300 requests / 15 min',
      buildRateLimit: '20 builds / hour',
    },
    buildInfo: {
      typicalDuration: '3-7 minutes',
      smartBuildMaxIterations: 8,
      artifactTypes: ['program (.so)', 'idl (.json)', 'types (.ts)', 'keypair (.json)'],
    },
    websocket: {
      url: 'ws://<host>/ws',
      description: 'Real-time build log streaming. Subscribe after starting a build to receive live progress.',
      subscribe: '{"action":"subscribe","buildId":"<buildId>"}',
    },
  });
});

module.exports = router;
