const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const extractZip = require('extract-zip');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { executeAnchorBuild } = require('./docker');
const config = require('./config');

const builds = new Map();

const BuildStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
};

// Extract project without starting build
async function extractProject(buildId, filePath, fileType = 'zip') {
  const projectDir = path.join(config.builds.uploadDir, buildId);
  const outputDir = path.join(config.builds.buildDir, buildId);

  builds.set(buildId, {
    id: buildId,
    status: 'ready', // Not running yet
    createdAt: new Date(),
    updatedAt: new Date(),
    projectDir,
    outputDir,
    logs: { stdout: '', stderr: '' },
  });

  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    
    // Make output directory writable by anyone (Docker container needs this)
    await execPromise(`chmod -R 777 "${outputDir}"`);
    
    console.log(`[${buildId}] Extracting project...`);
    if (fileType === 'zip') {
      await extractZip(filePath, { dir: path.resolve(projectDir) });
    } else {
      throw new Error(`Unsupported file type: ${fileType}`);
    }

    const anchorRoot = await findAnchorRoot(projectDir);
    if (!anchorRoot) {
      console.log(`[${buildId}] Warning: Anchor.toml not found (might need AI to fix structure)`);
    } else {
      console.log(`[${buildId}] Found Anchor project at: ${anchorRoot}`);
    }

    // Clean up uploaded file
    try {
      await fs.unlink(filePath);
    } catch (err) {
      console.warn(`[${buildId}] Failed to delete uploaded file:`, err.message);
    }

    return buildId;
  } catch (error) {
    console.error(`[${buildId}] Extraction failed:`, error.message);
    updateBuildStatus(buildId, BuildStatus.FAILED, {
      error: error.message,
      logs: { stdout: '', stderr: error.message },
    });
    throw error;
  }
}

// Generate a unique build ID
function generateBuildId() {
  return uuidv4();
}

async function startBuild(filePath, fileType = 'zip') {
  const buildId = uuidv4();
  const projectDir = path.join(config.builds.uploadDir, buildId);
  const outputDir = path.join(config.builds.buildDir, buildId);

  builds.set(buildId, {
    id: buildId,
    status: BuildStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
    projectDir,
    outputDir,
  });

  (async () => {
    try {
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      
      // Make output directory writable by anyone (Docker container needs this)
      await execPromise(`chmod -R 777 "${outputDir}"`);
      
      console.log(`[${buildId}] Extracting project...`);
      if (fileType === 'zip') {
        await extractZip(filePath, { dir: path.resolve(projectDir) });
      } else {
        throw new Error(`Unsupported file type: ${fileType}`);
      }

      const anchorRoot = await findAnchorRoot(projectDir);
      if (!anchorRoot) {
        throw new Error('Anchor.toml not found in uploaded project');
      }

      console.log(`[${buildId}] Found Anchor project at: ${anchorRoot}`);
      updateBuildStatus(buildId, BuildStatus.RUNNING);

      // Calculate relative path from projectDir to anchorRoot
      const anchorSubdir = path.relative(projectDir, anchorRoot);
      console.log(`[${buildId}] Anchor subdirectory: '${anchorSubdir}'`);

      // Execute build (pass full projectDir, not anchorRoot, so we copy everything)
      const result = await executeAnchorBuild(buildId, projectDir, outputDir, anchorSubdir);

      updateBuildStatus(buildId, result.success ? BuildStatus.SUCCESS : BuildStatus.FAILED, {
        logs: result.logs,
        exitCode: result.exitCode,
        error: result.error,
        completedAt: new Date(),
      });

    } catch (error) {
      console.error(`[${buildId}] Build setup failed:`, error.message);
      updateBuildStatus(buildId, BuildStatus.FAILED, {
        error: error.message,
        logs: { stdout: '', stderr: error.message },
        completedAt: new Date(),
      });
    } finally {
      try {
        await fs.unlink(filePath);
      } catch (err) {
        console.warn(`Failed to delete upload: ${err.message}`);
      }
    }
  })();

  return buildId;
}

async function findAnchorRoot(dir) {
  try {
    const anchorToml = path.join(dir, 'Anchor.toml');
    await fs.access(anchorToml);
    return dir;
  } catch {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = path.join(dir, entry.name, 'Anchor.toml');
        try {
          await fs.access(subPath);
          return path.join(dir, entry.name);
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

function updateBuildStatus(buildId, status, additionalData = {}) {
  const build = builds.get(buildId);
  if (build) {
    builds.set(buildId, {
      ...build,
      status,
      updatedAt: new Date(),
      ...additionalData,
    });
  }
}

function getBuildStatus(buildId) {
  return builds.get(buildId) || null;
}

function listBuilds() {
  return Array.from(builds.values());
}

async function getBuildArtifacts(buildId) {
  const build = builds.get(buildId);
  if (!build) {
    throw new Error('Build not found');
  }

  if (build.status !== BuildStatus.SUCCESS) {
    throw new Error(`Build not successful. Status: ${build.status}`);
  }

  const artifacts = await scanArtifacts(build.outputDir);
  return artifacts;
}

async function scanArtifacts(outputDir) {
  const artifacts = {
    programs: [],
    idl: [],
    types: [],
    deploy: [],
  };

  try {
    // Artifacts are copied to /output/target/ inside Docker.
    // Docker mounts outputDir as /output, so artifacts land at <outputDir>/target/.
    const targetDir = path.join(outputDir, 'target');

    const deployDir = path.join(targetDir, 'deploy');
    try {
      const files = await fs.readdir(deployDir);
      for (const file of files) {
        if (file.endsWith('.so')) {
          artifacts.programs.push({
            name: file,
            path: path.join(deployDir, file),
            type: 'program',
          });
        } else if (file.endsWith('.json')) {
          artifacts.deploy.push({
            name: file,
            path: path.join(deployDir, file),
            type: 'deploy',
          });
        }
      }
    } catch (err) {
      console.warn('No deploy directory found');
    }

    const idlDir = path.join(targetDir, 'idl');
    try {
      const files = await fs.readdir(idlDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          artifacts.idl.push({
            name: file,
            path: path.join(idlDir, file),
            type: 'idl',
          });
        }
      }
    } catch (err) {
      console.warn('No IDL directory found');
    }

    const typesDir = path.join(targetDir, 'types');
    try {
      const files = await fs.readdir(typesDir);
      for (const file of files) {
        if (file.endsWith('.ts')) {
          artifacts.types.push({
            name: file,
            path: path.join(typesDir, file),
            type: 'types',
          });
        }
      }
    } catch (err) {
      console.warn('No types directory found');
    }

  } catch (err) {
    console.error('Error scanning artifacts:', err.message);
  }

  return artifacts;
}

async function cleanupOldBuilds() {
  if (!config.cleanup.enableAutoCleanup) return;

  const cutoffTime = Date.now() - config.cleanup.cleanupAfterMinutes * 60 * 1000;

  for (const [buildId, build] of builds.entries()) {
    if (build.updatedAt.getTime() < cutoffTime) {
      console.log(`Cleaning up old build: ${buildId}`);
      
      try {
        await fs.rm(build.projectDir, { recursive: true, force: true });
        await fs.rm(build.outputDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`Failed to delete build directories: ${err.message}`);
      }

      builds.delete(buildId);
    }
  }
}

if (config.cleanup.enableAutoCleanup) {
  setInterval(cleanupOldBuilds, 10 * 60 * 1000);
}

/**
 * Parse GitHub URL to extract repo, branch, and subfolder
 * Supports: https://github.com/user/repo/tree/branch/subfolder
 */
function parseGithubUrl(url) {
  // Match: github.com/owner/repo/tree/branch/optional-path
  const treeMatch = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/tree\/([\w.-]+)(?:\/(.+))?/);
  if (treeMatch) {
    return {
      cloneUrl: `https://github.com/${treeMatch[1]}/${treeMatch[2]}`,
      branch: treeMatch[3],
      subfolder: treeMatch[4] || '',
    };
  }
  // Plain repo URL: github.com/owner/repo
  const repoMatch = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (repoMatch) {
    return {
      cloneUrl: `https://github.com/${repoMatch[1]}/${repoMatch[2]}`,
      branch: null,
      subfolder: '',
    };
  }
  return { cloneUrl: url, branch: null, subfolder: '' };
}

/**
 * Start a build from GitHub repository
 * @param {string} repoUrl - GitHub repository URL
 * @returns {Promise<string>} Build ID
 */
async function startBuildFromGithub(repoUrl, autoBuild = false, metadata = {}) {
  const buildId = uuidv4();
  const cloneDir = path.join(config.builds.uploadDir, `${buildId}-clone`);
  const projectDir = path.join(config.builds.uploadDir, buildId);
  const outputDir = path.join(config.builds.buildDir, buildId);

  // Parse GitHub URL for branch/subfolder support
  const { cloneUrl, branch, subfolder } = parseGithubUrl(repoUrl);

  // Initialize build record
  builds.set(buildId, {
    id: buildId,
    status: autoBuild ? BuildStatus.PENDING : 'ready',
    createdAt: new Date(),
    updatedAt: new Date(),
    projectDir,
    outputDir,
    source: 'github',
    repoUrl,
    logs: { stdout: '', stderr: '' },
    ...metadata,
  });

  // Always clone synchronously (wait for clone to finish before responding)
  await fs.mkdir(cloneDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await execPromise(`chmod -R 777 "${outputDir}"`);

  console.log(`[${buildId}] Cloning from GitHub: ${cloneUrl} (branch: ${branch || 'default'}, subfolder: ${subfolder || 'root'})`);

  try {
    const branchFlag = branch ? `--branch "${branch}"` : '';
    await execPromise(`git clone --depth 1 ${branchFlag} "${cloneUrl}" "${cloneDir}"`, {
      timeout: 120000,
    });
  } catch (cloneError) {
    // Clean up
    try { await fs.rm(cloneDir, { recursive: true, force: true }); } catch {}
    updateBuildStatus(buildId, BuildStatus.FAILED, {
      error: `Failed to clone repository: ${cloneError.message}`,
      logs: { stdout: '', stderr: cloneError.message },
      completedAt: new Date(),
    });
    throw new Error(`Failed to clone repository: ${cloneError.message}`);
  }

  // If subfolder specified, copy only that folder to projectDir
  if (subfolder) {
    const subPath = path.join(cloneDir, subfolder);
    try {
      await fs.access(subPath);
      await execPromise(`cp -r "${subPath}/." "${projectDir}/"`);
      console.log(`[${buildId}] Extracted subfolder: ${subfolder}`);
    } catch (err) {
      try { await fs.rm(cloneDir, { recursive: true, force: true }); } catch {}
      const msg = `Subfolder '${subfolder}' not found in repository`;
      updateBuildStatus(buildId, BuildStatus.FAILED, {
        error: msg,
        logs: { stdout: '', stderr: msg },
        completedAt: new Date(),
      });
      throw new Error(msg);
    }
  } else {
    // No subfolder, move entire clone to projectDir
    await execPromise(`cp -r "${cloneDir}/." "${projectDir}/"`);
  }

  // Clean up clone dir
  try { await fs.rm(cloneDir, { recursive: true, force: true }); } catch {}

  console.log(`[${buildId}] Repository cloned successfully`);

  // If autoBuild is false, mark as ready and return (files are available now)
  if (!autoBuild) {
    updateBuildStatus(buildId, 'ready', {
      logs: {
        stdout: 'Repository cloned and ready for editing',
        stderr: ''
      }
    });
    return buildId;
  }

  // Auto-build path: start build asynchronously
  (async () => {
    try {
      const anchorRoot = await findAnchorRoot(projectDir);
      if (!anchorRoot) {
        throw new Error('Anchor.toml not found in repository');
      }

      console.log(`[${buildId}] Found Anchor project at: ${anchorRoot}`);
      updateBuildStatus(buildId, BuildStatus.RUNNING);

      const anchorSubdir = path.relative(projectDir, anchorRoot);
      console.log(`[${buildId}] Anchor subdirectory: '${anchorSubdir}'`);

      const result = await executeAnchorBuild(buildId, projectDir, outputDir, anchorSubdir);

      updateBuildStatus(buildId, result.success ? BuildStatus.SUCCESS : BuildStatus.FAILED, {
        logs: result.logs,
        exitCode: result.exitCode,
        error: result.error,
        completedAt: new Date(),
      });

    } catch (error) {
      console.error(`[${buildId}] GitHub build failed:`, error.message);
      updateBuildStatus(buildId, BuildStatus.FAILED, {
        error: error.message,
        logs: { stdout: '', stderr: error.message },
        completedAt: new Date(),
      });
    }
  })();

  return buildId;
}

/**
 * Create a project from a map of file paths to contents (for agent API).
 * No ZIP upload needed — agents send code as JSON.
 */
async function createProjectFromFiles(name, files, metadata = {}) {
  const buildId = uuidv4();
  const projectDir = path.join(config.builds.uploadDir, buildId);
  const outputDir = path.join(config.builds.buildDir, buildId);

  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await execPromise(`chmod -R 777 "${outputDir}"`);

  for (const [filePath, content] of Object.entries(files)) {
    const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
    if (safePath.startsWith('/') || safePath.includes('\0')) {
      throw new Error(`Invalid file path: ${filePath}`);
    }
    const fullPath = path.join(projectDir, safePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  builds.set(buildId, {
    id: buildId,
    status: 'ready',
    createdAt: new Date(),
    updatedAt: new Date(),
    projectDir,
    outputDir,
    logs: { stdout: '', stderr: '' },
    ...metadata,
  });

  console.log(`[${buildId}] Project '${name}' created from ${Object.keys(files).length} files (agent API)`);
  return buildId;
}

module.exports = {
  startBuild,
  startBuildFromGithub,
  getBuildStatus,
  listBuilds,
  getBuildArtifacts,
  extractProject,
  generateBuildId,
  updateBuildStatus,
  createProjectFromFiles,
  BuildStatus,
};
