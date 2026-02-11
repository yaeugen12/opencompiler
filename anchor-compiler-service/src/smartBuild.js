const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const { verifyAndFixStructure, analyzeAndFixBuildFailure, readAllSourceFiles } = require('./ai');
const { executeAnchorBuild } = require('./docker');

/**
 * Smart build orchestrator — verify structure, build, analyze errors, fix, retry
 * @param {string} buildId
 * @param {string} projectDir - Absolute path to extracted project
 * @param {string} outputDir - Absolute path for build output
 * @param {function} onProgress - Callback: (progressEvent) => void
 * @returns {Promise<SmartBuildResult>}
 */
async function smartBuild(buildId, projectDir, outputDir, onProgress) {
  const MAX_ITERATIONS = config.smartBuild.maxIterations;
  const phases = [];
  const aiAnalyses = [];
  const previousFixes = []; // Track what was already tried so AI doesn't repeat
  let lastBuildResult = null;

  const progress = (phase, iteration, message, details = null) => {
    const event = {
      type: 'smart_build_phase',
      buildId,
      phase,
      iteration,
      maxIterations: MAX_ITERATIONS,
      message,
      details,
    };
    console.log(`[${buildId}] [smart-build] [${phase}] (${iteration + 1}/${MAX_ITERATIONS}) ${message}`);
    if (onProgress) onProgress(event);
  };

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {

    // ---- PHASE: DEEP ANALYSIS (iteration 0 only) ----
    if (iteration === 0) {
      progress('analyzing', iteration, 'Analyzing project code...');
      try {
        const codeAnalysis = await deepCodeAnalysis(buildId, projectDir);
        phases.push({ phase: 'analyzing', iteration, timestamp: new Date(), result: 'success', details: codeAnalysis });
        progress('analyzing', iteration, `Found program "${codeAnalysis.programName || 'unknown'}" with ${codeAnalysis.dependencies.length} dependencies`, codeAnalysis);
      } catch (err) {
        console.error(`[${buildId}] Deep analysis failed:`, err.message);
        phases.push({ phase: 'analyzing', iteration, timestamp: new Date(), result: 'failed', details: { error: err.message } });
      }
    }

    // ---- PHASE: VERIFY STRUCTURE (iteration 0) or FIX ERRORS (iteration 1+) ----
    if (iteration === 0) {
      progress('verifying', iteration, 'AI verifying project structure and generating config files...');
      try {
        const verifyResult = await verifyAndFixStructure(buildId, projectDir);
        const fixCount = verifyResult.fixes ? verifyResult.fixes.length : 0;
        phases.push({ phase: 'verifying', iteration, timestamp: new Date(), result: verifyResult.success ? 'fixed' : 'failed', details: verifyResult });
        progress('verifying', iteration, fixCount > 0
          ? `Created ${fixCount} config file(s). Ready to build.`
          : 'Project structure verified. Ready to build.',
          { fixesApplied: fixCount });
      } catch (err) {
        console.error(`[${buildId}] Structure verification failed:`, err.message);
        phases.push({ phase: 'verifying', iteration, timestamp: new Date(), result: 'failed', details: { error: err.message } });
        progress('verifying', iteration, `Structure verification failed: ${err.message}`);
      }
    } else {
      // Post-failure: AI analyzes build error and suggests fixes
      progress('fixing', iteration, `AI analyzing build error (attempt ${iteration + 1})...`);

      const errorMsg = lastBuildResult.error || 'Build failed';
      const fixResult = await analyzeAndFixBuildFailure(
        buildId, projectDir, lastBuildResult.logs, errorMsg, iteration,
        (msg) => progress('fixing', iteration, msg),
        previousFixes
      );

      if (!fixResult.success) {
        phases.push({ phase: 'fixing', iteration, timestamp: new Date(), result: 'failed', details: { error: fixResult.error } });
        progress('fixing', iteration, `AI analysis failed: ${fixResult.error}`);
        // Don't waste a build iteration — AI couldn't analyze, so no fixes were applied
        // Skip the build and continue to next iteration (which will retry AI)
        console.log(`[${buildId}] Skipping rebuild — no fixes applied (AI failed)`);
        continue;
      } else if (fixResult.cannotFix) {
        // AI says it cannot fix without simplifying
        const reason = extractCannotFixReason(fixResult.analysis);
        phases.push({ phase: 'fixing', iteration, timestamp: new Date(), result: 'cannot_fix', details: { reason } });
        aiAnalyses.push({ iteration, analysis: fixResult.analysis, fixes: [], cannotFix: true });

        progress('complete', iteration, `AI cannot fix this issue: ${reason}`, { cannotFix: true, reason });

        return {
          success: false,
          iterations: iteration + 1,
          phases,
          aiAnalyses,
          finalBuild: lastBuildResult,
          cannotFix: true,
          cannotFixReason: reason,
        };
      } else if (fixResult.fixes.length === 0) {
        phases.push({ phase: 'fixing', iteration, timestamp: new Date(), result: 'no_fixes', details: {} });
        aiAnalyses.push({ iteration, analysis: fixResult.analysis, fixes: [] });
        progress('fixing', iteration, 'AI found no fixes to apply');
        // Still try building — maybe the AI analysis was insufficient
      } else {
        // Apply fixes with safety enforcement
        const safeResult = await applySafeFixes(buildId, projectDir, fixResult.fixes, iteration);
        phases.push({ phase: 'fixing', iteration, timestamp: new Date(), result: 'fixed', details: safeResult });
        aiAnalyses.push({ iteration, analysis: fixResult.analysis, fixes: fixResult.fixes });

        // Record what was tried so AI doesn't repeat the same fix
        previousFixes.push({
          files: safeResult.applied.map(f => f.path),
          summary: extractShortAnalysis(fixResult.analysis) || safeResult.applied.map(f => `${f.action} ${f.path}`).join(', '),
        });

        progress('fixing', iteration,
          `Applied ${safeResult.applied.length} fix(es), rejected ${safeResult.rejected.length}`,
          { fixesApplied: safeResult.applied.length, fixesRejected: safeResult.rejected.length, analysis: extractShortAnalysis(fixResult.analysis) });
      }
    }

    // ---- PHASE: BUILD ----
    progress('building', iteration, `Building project (attempt ${iteration + 1}/${MAX_ITERATIONS})...`);

    const anchorSubdir = await findAnchorTomlSubdir(projectDir);

    try {
      await fs.mkdir(outputDir, { recursive: true });
    } catch (err) { /* ignore */ }

    lastBuildResult = await executeAnchorBuild(
      buildId,
      projectDir,
      outputDir,
      anchorSubdir,
      (logs) => {
        if (onProgress) {
          onProgress({
            type: 'build_log',
            buildId,
            phase: 'building',
            iteration,
            maxIterations: MAX_ITERATIONS,
            message: 'Build in progress...',
            details: logs,
          });
        }
      }
    );

    phases.push({
      phase: 'building',
      iteration,
      timestamp: new Date(),
      result: lastBuildResult.success ? 'success' : 'failed',
      details: { exitCode: lastBuildResult.exitCode },
    });

    // Even if exit code is 0, verify actual artifacts exist
    if (lastBuildResult.success) {
      const hasArtifacts = await verifyBuildArtifacts(outputDir);
      const hasErrorsInLogs = detectBuildErrorsInLogs(lastBuildResult.logs);

      if (!hasArtifacts || hasErrorsInLogs) {
        console.log(`[${buildId}] Build exit code was 0 but artifacts missing or errors in logs — treating as failure`);
        lastBuildResult.success = false;
        lastBuildResult.error = !hasArtifacts
          ? 'Build produced no .so artifacts — compilation likely failed'
          : 'Build logs contain errors despite exit code 0';
      }
    }

    if (lastBuildResult.success) {
      progress('complete', iteration, 'Build succeeded!', { success: true, iterations: iteration + 1 });

      return {
        success: true,
        iterations: iteration + 1,
        phases,
        aiAnalyses,
        finalBuild: lastBuildResult,
        cannotFix: false,
        cannotFixReason: null,
      };
    }

    // Build failed — will retry if iterations remain
    progress('building', iteration,
      `Build failed (attempt ${iteration + 1}/${MAX_ITERATIONS})${iteration + 1 < MAX_ITERATIONS ? ', analyzing errors...' : ''}`,
      { exitCode: lastBuildResult.exitCode });

    // Small delay between iterations to avoid hammering the API
    if (iteration + 1 < MAX_ITERATIONS) {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // Exhausted all retries
  progress('complete', MAX_ITERATIONS - 1, 'All retry attempts exhausted. Could not fix the build.', {
    success: false,
    iterations: MAX_ITERATIONS,
    cannotFix: true,
  });

  return {
    success: false,
    iterations: MAX_ITERATIONS,
    phases,
    aiAnalyses,
    finalBuild: lastBuildResult,
    cannotFix: true,
    cannotFixReason: 'Exhausted all retry attempts without successful compilation',
  };
}

/**
 * Deep static analysis of Rust source code (no AI call)
 * Extracts program metadata for better AI context
 */
async function deepCodeAnalysis(buildId, projectDir) {
  const files = await readAllSourceFiles(projectDir);

  const result = {
    programName: null,
    programId: null,
    dependencies: [],
    modules: [],
    features: [],
    fileMap: {},
  };

  const depsSet = new Set();

  for (const [filePath, content] of Object.entries(files)) {
    if (!filePath.endsWith('.rs')) continue;

    // Extract use statements → dependencies
    const useMatches = content.match(/use\s+([\w_]+)::/g) || [];
    for (const u of useMatches) {
      const crate = u.match(/use\s+([\w_]+)::/)[1];
      const crateMap = {
        anchor_lang: 'anchor-lang',
        anchor_spl: 'anchor-spl',
        solana_program: 'solana-program',
        spl_token: 'spl-token',
        spl_associated_token_account: 'spl-associated-token-account',
        mpl_token_metadata: 'mpl-token-metadata',
      };
      if (crateMap[crate]) depsSet.add(crateMap[crate]);
    }

    // Extract declare_id!
    const declareIdMatch = content.match(/declare_id!\s*\(\s*["']([^"']+)["']\s*\)/);
    if (declareIdMatch) result.programId = declareIdMatch[1];

    // Extract #[program] mod name
    const programModMatch = content.match(/#\[program\]\s+(?:pub\s+)?mod\s+(\w+)/);
    if (programModMatch) result.programName = programModMatch[1];

    // Detect mod declarations
    const modMatches = content.match(/(?:pub\s+)?mod\s+(\w+)\s*;/g) || [];
    result.modules.push(...modMatches.map(m => m.match(/mod\s+(\w+)/)[1]));

    // Detect feature flags
    const featureMatches = content.match(/#\[cfg\(feature\s*=\s*"([^"]+)"\)\]/g) || [];
    result.features.push(...featureMatches.map(f => f.match(/"([^"]+)"/)[1]));

    result.fileMap[filePath] = {
      lines: content.split('\n').length,
      declaresId: !!declareIdMatch,
      hasProgramMod: !!programModMatch,
    };
  }

  result.dependencies = Array.from(depsSet);
  return result;
}

/**
 * Apply AI fixes with strict safety rules based on iteration
 * Iteration 0: ONLY config files (.toml)
 * Iteration 1+: config + .rs syntax fixes (no simplification)
 */
async function applySafeFixes(buildId, projectDir, fixes, iteration) {
  const applied = [];
  const rejected = [];
  const safetyLog = [];

  for (const fix of fixes) {
    if (!fix.path || !fix.content) {
      rejected.push({ ...fix, reason: 'Missing path or content' });
      continue;
    }

    const ext = path.extname(fix.path);
    const isRsFile = ext === '.rs';
    const isConfigFile = ext === '.toml' || ext === '.json' || ext === '.lock';

    // ---- ITERATION 0: ONLY config files ----
    if (iteration === 0) {
      if (!isConfigFile) {
        rejected.push({ ...fix, reason: `Iteration 0: only config files allowed (got ${ext})` });
        safetyLog.push(`REJECTED: ${fix.path} — not a config file in pre-build phase`);
        continue;
      }
    }

    // ---- ITERATION 1+: config + .rs updates ----
    if (iteration > 0 && isRsFile) {
      // Cannot CREATE new .rs files
      if (fix.action === 'create') {
        const fullPath = path.join(projectDir, fix.path);
        try {
          await fs.access(fullPath);
          // File exists — treat as update
          fix.action = 'update';
        } catch {
          rejected.push({ ...fix, reason: 'Cannot create new .rs files' });
          safetyLog.push(`REJECTED: ${fix.path} — cannot create new .rs files`);
          continue;
        }
      }

      // Cannot DELETE .rs files
      if (fix.action === 'delete') {
        rejected.push({ ...fix, reason: 'Cannot delete .rs files' });
        safetyLog.push(`REJECTED: ${fix.path} — cannot delete user code`);
        continue;
      }

      // Validate no code simplification
      const validation = await validateRsFixSafety(buildId, projectDir, fix);
      if (!validation.safe) {
        rejected.push({ ...fix, reason: validation.reason });
        safetyLog.push(`REJECTED: ${fix.path} — ${validation.reason}`);
        continue;
      }
    }

    // Block .rs files entirely in iteration 0
    if (iteration === 0 && isRsFile) {
      rejected.push({ ...fix, reason: 'Iteration 0: .rs files forbidden' });
      safetyLog.push(`REJECTED: ${fix.path} — .rs files not allowed in pre-build phase`);
      continue;
    }

    // All checks passed — apply the fix
    try {
      const filePath = path.join(projectDir, fix.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, fix.content, 'utf-8');
      applied.push(fix);
      safetyLog.push(`APPLIED: ${fix.action} ${fix.path}`);
      console.log(`[${buildId}] ✅ Safe fix applied: ${fix.action} ${fix.path}`);
    } catch (err) {
      rejected.push({ ...fix, reason: `File write failed: ${err.message}` });
      safetyLog.push(`ERROR: ${fix.path} — ${err.message}`);
    }
  }

  if (rejected.length > 0) {
    console.log(`[${buildId}] 🛡️ Safety rejected ${rejected.length} fix(es):`);
    rejected.forEach(r => console.log(`  - ${r.path}: ${r.reason}`));
  }

  return { applied, rejected, safetyLog };
}

/**
 * Validate that a .rs fix does NOT simplify/remove code
 * Compares the proposed content against the existing file
 */
async function validateRsFixSafety(buildId, projectDir, fix) {
  try {
    const existingContent = await fs.readFile(path.join(projectDir, fix.path), 'utf-8');
    const newContent = fix.content;

    // Count meaningful constructs
    const countPattern = (text, pattern) => (text.match(pattern) || []).length;

    const existingFns = countPattern(existingContent, /(?:pub\s+)?(?:async\s+)?fn\s+\w+/g);
    const newFns = countPattern(newContent, /(?:pub\s+)?(?:async\s+)?fn\s+\w+/g);

    const existingStructs = countPattern(existingContent, /(?:pub\s+)?struct\s+\w+/g);
    const newStructs = countPattern(newContent, /(?:pub\s+)?struct\s+\w+/g);

    const existingEnums = countPattern(existingContent, /(?:pub\s+)?enum\s+\w+/g);
    const newEnums = countPattern(newContent, /(?:pub\s+)?enum\s+\w+/g);

    const existingImpls = countPattern(existingContent, /impl\s+/g);
    const newImpls = countPattern(newContent, /impl\s+/g);

    if (newFns < existingFns) {
      return { safe: false, reason: `Functions reduced from ${existingFns} to ${newFns} — code simplification detected` };
    }
    if (newStructs < existingStructs) {
      return { safe: false, reason: `Structs reduced from ${existingStructs} to ${newStructs} — code simplification detected` };
    }
    if (newEnums < existingEnums) {
      return { safe: false, reason: `Enums reduced from ${existingEnums} to ${newEnums} — code simplification detected` };
    }
    if (newImpls < existingImpls) {
      return { safe: false, reason: `Impl blocks reduced from ${existingImpls} to ${newImpls} — code simplification detected` };
    }

    // Check for massive reduction (>30%)
    const existingLines = existingContent.split('\n').length;
    const newLines = newContent.split('\n').length;
    if (existingLines > 10 && newLines < existingLines * 0.7) {
      const pct = Math.round((1 - newLines / existingLines) * 100);
      return { safe: false, reason: `Code reduced by ${pct}% (${existingLines} → ${newLines} lines) — likely simplification` };
    }

    return { safe: true, reason: null };
  } catch (err) {
    // File doesn't exist — shouldn't happen (checked earlier) but allow
    return { safe: true, reason: null };
  }
}

/**
 * Recursively find Anchor.toml and return its subdirectory relative to projectDir
 */
async function findAnchorTomlSubdir(projectDir) {
  async function search(dir, relativePath) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (entry.name === 'Anchor.toml') return relativePath;
      if (entry.isDirectory() && !['node_modules', 'target', '.git'].includes(entry.name)) {
        const found = await search(path.join(dir, entry.name), path.join(relativePath, entry.name));
        if (found !== null) return found;
      }
    }
    return null;
  }

  return (await search(projectDir, '')) || '';
}

/**
 * Extract the "cannot fix" reason from AI analysis text
 */
function extractCannotFixReason(analysis) {
  try {
    const jsonMatch = analysis.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.analysis) return parsed.analysis;
    }
  } catch { /* ignore */ }

  // Fallback: first 200 chars
  const clean = analysis.replace(/```[\s\S]*?```/g, '').trim();
  return clean.slice(0, 200) || 'AI determined this issue cannot be fixed without simplifying the code';
}

/**
 * Extract a short analysis string from AI response
 */
function extractShortAnalysis(analysis) {
  try {
    const jsonMatch = analysis.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      // Include both the short analysis AND the reasoning so the AI
      // knows exactly what was tried and why
      const parts = [];
      if (parsed.analysis) parts.push(parsed.analysis);
      if (parsed.reasoning) parts.push(`Reasoning: ${parsed.reasoning.slice(0, 300)}`);
      return parts.join(' | ') || '';
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Verify that actual .so artifacts were produced by the build
 */
async function verifyBuildArtifacts(outputDir) {
  try {
    const deployDir = path.join(outputDir, 'target', 'deploy');
    const files = await fs.readdir(deployDir);
    return files.some(f => f.endsWith('.so'));
  } catch {
    return false;
  }
}

/**
 * Detect build errors in logs even when exit code is 0
 */
function detectBuildErrorsInLogs(logs) {
  const stdout = typeof logs === 'object' ? (logs.stdout || '') : String(logs);
  const stderr = typeof logs === 'object' ? (logs.stderr || '') : '';
  const combined = stdout + '\n' + stderr;

  // Cargo/rustc errors
  if (/error\[E\d+\]/.test(combined)) return true;
  if (/^error:.*aborting due to/m.test(combined)) return true;
  if (/ERROR.*cargo.build/i.test(combined)) return true;
  if (/Failed to obtain package metadata/.test(combined)) return true;
  if (/can't find library/.test(combined)) return true;

  return false;
}

module.exports = {
  smartBuild,
  deepCodeAnalysis,
  applySafeFixes,
  validateRsFixSafety,
  findAnchorTomlSubdir,
};
