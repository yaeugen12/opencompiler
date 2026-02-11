const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');

const docker = new Docker();

// Filter and clean build logs - keep only meaningful output
function filterBuildLog(message) {
  if (!message || typeof message !== 'string') return null;

  // Strip ANSI color codes and control characters
  let line = message
    .replace(/\x1b\[[0-9;]*m/g, '')  // ANSI escape codes
    .replace(/\[0m/g, '')             // Leftover color resets
    .replace(/^\s*m\s+/g, '')         // Leading 'm ' artifacts
    .replace(/⌛/g, '')               // Stray characters
    .trim();

  if (!line) return null;

  // Skip verbose rustc commands
  if (line.includes('Running `/usr/local/rustup/')) return null;
  if (line.includes('Running `/workspace/')) return null;
  if (line.includes('--crate-name')) return null;
  if (line.includes('--error-format=json')) return null;
  if (line.includes('--emit=dep-info')) return null;
  if (line.includes('-C metadata=')) return null;
  if (line.includes('-C extra-filename=')) return null;
  if (line.includes('--check-cfg')) return null;
  if (line.includes('--cap-lints')) return null;
  if (line.includes('-Zremap-cwd-prefix=')) return null;
  if (line.includes('--extern ')) return null;
  if (line.startsWith('-L dependency=')) return null;
  if (line.startsWith('--out-dir')) return null;

  // Keep important messages
  if (line.startsWith('Compiling ')) return `📦 ${line}`;
  if (line.startsWith('Building ')) return `🔨 ${line}`;
  if (line.startsWith('Finished ')) return `✅ ${line}`;
  if (line.startsWith('Downloading ')) return `⬇️ ${line}`;

  // Real errors (not package names like "solana-program-error" or "thiserror")
  if (line.startsWith('error[') || line.startsWith('error:') || line.includes(': error:')) {
    return `❌ ${line}`;
  }

  // Real warnings (not package names)
  if (line.startsWith('warning:') || line.includes(': warning:')) {
    return `⚠️ ${line}`;
  }

  if (line.startsWith('===')) return `\n${line}`;
  if (line.includes('anchor')) return line;
  if (line.includes('INFO')) return `ℹ️ ${line.split(']').pop()?.trim() || line}`;
  if (line.includes('WARN')) return `⚠️ ${line.split(']').pop()?.trim() || line}`;

  // Skip noisy lines
  if (line.length > 200) return null; // Skip very long lines
  if (line.startsWith('drwx')) return null; // Skip ls -la output details
  if (line.startsWith('lrwx')) return null;
  if (line.startsWith('-rw')) return null;

  return line;
}

async function executeAnchorBuild(buildId, projectPath, outputPath, anchorSubdir = '', onLogUpdate = null) {
  const logs = { stdout: [], stderr: [] };
  let container = null;

  try {
    await fs.mkdir(outputPath, { recursive: true });
    
    // Determine working directory (where Anchor.toml is)
    const workDir = anchorSubdir ? `/workspace/${anchorSubdir}` : '/workspace';
    console.log(`[${buildId}] Working directory in container: ${workDir}`);

    const containerConfig = {
      Image: config.dockerImage,
      Cmd: ['sh', '-c', `
        export CARGO_TERM_VERBOSE=true
        export RUST_BACKTRACE=1
        export CARGO_INCREMENTAL=0
        export CARGO_TERM_COLOR=always
        export RUST_LOG=info

        echo "=== Anchor Compiler Service ===" &&
        anchor --version &&
        solana --version &&
        cargo-build-sbf --version 2>/dev/null || echo "cargo-build-sbf not found, using cargo-build-bpf" &&
        echo "=== Project Structure ===" &&
        ls -la &&
        echo "=== Looking for program directories ===" &&
        ls -la programs/ 2>/dev/null || echo "No programs/ dir" &&
        ls -la ml/ 2>/dev/null || echo "No ml/ dir" &&
        echo "=== Fixing structure if needed ===" &&
        if [ ! -d "programs" ] && [ -d "ml" ]; then
          echo "Creating programs/ and moving ml into it..." &&
          mkdir -p programs &&
          mv ml programs/ml &&
          ls -la programs/
        fi &&
        echo "=== Anchor.toml ===" &&
        cat Anchor.toml 2>/dev/null || echo "No Anchor.toml" &&
        echo "=== Running Anchor Build (this may take 3-7 minutes) ===" &&
        anchor build 2>&1;
        BUILD_EXIT=$?;
        echo "=== Build exited with code: $BUILD_EXIT ===" ;
        if [ $BUILD_EXIT -ne 0 ]; then
          echo "=== BUILD FAILED ===" ;
          exit $BUILD_EXIT ;
        fi ;
        echo "=== Build Complete ===" &&
        echo "=== Target Directory ===" &&
        ls -la target/ &&
        echo "=== Deploy Directory ===" &&
        ls -la target/deploy/ 2>/dev/null || echo "No deploy directory found!" &&
        echo "=== IDL Directory ===" &&
        ls -la target/idl/ 2>/dev/null || echo "No idl directory found!" &&
        if [ ! -d "target/deploy" ] || [ -z "$(ls -A target/deploy/*.so 2>/dev/null)" ]; then
          echo "=== NO .so ARTIFACTS FOUND - BUILD FAILED ===" ;
          exit 1 ;
        fi ;
        echo "=== Copying Artifacts ===" &&
        mkdir -p /output/target/deploy /output/target/idl /output/target/types &&
        cp -v target/deploy/*.so /output/target/deploy/ 2>/dev/null || true &&
        cp -v target/deploy/*-keypair.json /output/target/deploy/ 2>/dev/null || true &&
        cp -v target/idl/*.json /output/target/idl/ 2>/dev/null || true &&
        cp -v target/types/*.ts /output/target/types/ 2>/dev/null || true &&
        chmod -R a+rX /output/target/ &&
        echo "=== Artifacts Copied ==="
      `],
      WorkingDir: workDir,
      HostConfig: {
        Binds: [
          `${process.env.HOST_BUILD_DIR ? path.join(process.env.HOST_BUILD_DIR, path.basename(outputPath)) : path.resolve(outputPath)}:/output:rw`,
        ],
        Memory: config.docker.memory,
        MemorySwap: config.docker.memorySwap,
        NanoCpus: config.docker.cpus * 1e9,
        NetworkMode: config.docker.networkDisabled ? 'none' : 'default',
        AutoRemove: false,
        ReadonlyRootfs: config.docker.readonlyRootfs,
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'], // Add capabilities for file operations
      },
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    };

    console.log(`[${buildId}] Creating container...`);
    container = await docker.createContainer(containerConfig);

    // Copy project files INTO container (avoids permission issues)
    console.log(`[${buildId}] Copying project files...`);
    const tar = require('tar');
    const { Readable } = require('stream');
    
    // Create tar stream from project directory
    const tarStream = tar.create(
      {
        gzip: false,
        cwd: projectPath,
      },
      ['.']
    );
    
    // Upload tar to container
    await container.putArchive(tarStream, { path: '/workspace' });

    console.log(`[${buildId}] Starting build...`);
    
    // Attach to container for live streams BEFORE starting
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
      logs: true,
    });
    
    // Collect logs as they come
    stream.on('data', (chunk) => {
      const message = chunk.toString('utf8');
      // Remove Docker header (first 8 bytes)
      const cleanMessage = message.length > 8 ? message.slice(8) : message;

      // Store raw logs for debugging
      logs.stdout.push(cleanMessage);

      // Filter for display - process line by line
      const lines = cleanMessage.split('\n');
      const filteredLines = lines
        .map(line => filterBuildLog(line))
        .filter(line => line !== null);

      if (filteredLines.length > 0) {
        const filteredMessage = filteredLines.join('\n');
        console.log(`[${buildId}] ${filteredMessage}`);

        // Call callback with filtered logs for frontend
        if (onLogUpdate) {
          onLogUpdate({
            stdout: filteredMessage,
            stderr: ''
          });
        }
      }
    });
    
    // Start container AFTER attaching
    await container.start();

    // Wait for container to finish
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Build timeout exceeded')), config.builds.timeout * 1000);
    });

    const waitPromise = container.wait();
    const result = await Promise.race([waitPromise, timeoutPromise]);

    console.log(`[${buildId}] Build completed with status code: ${result.StatusCode}`);

    // Get final logs if any were missed
    try {
      const finalLogs = await container.logs({
        stdout: true,
        stderr: true,
        timestamps: false,
      });
      
      // Parse Docker log format (8-byte header + message)
      const logBuffer = Buffer.isBuffer(finalLogs) ? finalLogs : Buffer.from(finalLogs);
      let offset = 0;
      const stdoutLines = [];
      const stderrLines = [];
      
      while (offset < logBuffer.length) {
        // Docker log format: [stream_type, 0, 0, 0, size_bytes_1-4, message]
        const streamType = logBuffer[offset]; // 1=stdout, 2=stderr
        const size = logBuffer.readUInt32BE(offset + 4);
        const message = logBuffer.slice(offset + 8, offset + 8 + size).toString('utf8');
        
        if (streamType === 1) {
          stdoutLines.push(message);
        } else if (streamType === 2) {
          stderrLines.push(message);
        }
        
        offset += 8 + size;
      }
      
      logs.stdout.push(stdoutLines.join(''));
      logs.stderr.push(stderrLines.join(''));
      
      console.log(`[${buildId}] Captured ${logs.stdout.join('').length} bytes stdout, ${logs.stderr.join('').length} bytes stderr`);
    } catch (logErr) {
      console.error(`[${buildId}] Failed to parse logs:`, logErr.message);
      logs.stderr.push(`Log parsing error: ${logErr.message}`);
    }

    // Log what's in output directory
    try {
      const outputContents = await fs.readdir(outputPath);
      console.log(`[${buildId}] Output directory contains:`, outputContents);
    } catch (err) {
      console.log(`[${buildId}] Failed to read output directory:`, err.message);
    }

    return {
      success: result.StatusCode === 0,
      exitCode: result.StatusCode,
      logs: {
        stdout: logs.stdout.join(''),
        stderr: logs.stderr.join(''),
      },
      outputPath,
    };

  } catch (error) {
    console.error(`[${buildId}] Build error:`, error.message);
    
    // Try to get logs from failed container
    if (container) {
      try {
        const errorLogs = await container.logs({ stdout: true, stderr: true });
        const errorLogStr = errorLogs.toString('utf8');
        logs.stderr.push(errorLogStr);
      } catch (logErr) {
        console.error(`[${buildId}] Failed to get error logs:`, logErr.message);
      }
    }
    
    return {
      success: false,
      error: error.message,
      logs: {
        stdout: logs.stdout.join(''),
        stderr: logs.stderr.join('') + `\n\nFatal error: ${error.message}`,
      },
    };
  } finally {
    // Clean up container
    if (container) {
      try {
        await container.remove({ force: true });
        console.log(`[${buildId}] Container removed`);
      } catch (removeErr) {
        console.warn(`[${buildId}] Failed to remove container:`, removeErr.message);
      }
    }
  }
}

async function copyArtifacts(container, sourcePath, destPath) {
  try {
    const tarStream = await container.getArchive({ path: sourcePath });
    const tar = require('tar');
    
    await new Promise((resolve, reject) => {
      tarStream
        .pipe(tar.extract({ cwd: destPath }))
        .on('finish', resolve)
        .on('error', reject);
    });

    console.log(`Artifacts copied to ${destPath}`);
  } catch (err) {
    throw new Error(`Failed to copy artifacts: ${err.message}`);
  }
}

async function verifyDockerImage() {
  try {
    await docker.getImage(config.dockerImage).inspect();
    console.log(`✓ Docker image found: ${config.dockerImage}`);
    return true;
  } catch (err) {
    console.error(`✗ Docker image not found: ${config.dockerImage}`);
    console.error('Please build or pull the image first.');
    return false;
  }
}

module.exports = {
  executeAnchorBuild,
  verifyDockerImage,
};
