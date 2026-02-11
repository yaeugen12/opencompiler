const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const { TOOL_DEFINITIONS, executeTool } = require('./aiTools');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'your-api-key-here',
});

/**
 * Analyze build failure and suggest fixes
 * @param {string} buildId - Build identifier
 * @param {string} projectDir - Path to project directory
 * @param {object} logs - Build logs { stdout, stderr }
 * @param {string} errorMessage - Error message
 * @returns {Promise<{success: boolean, fixes: Array, analysis: string}>}
 */
async function analyzeBuildFailure(buildId, projectDir, logs, errorMessage) {
  try {
    console.log(`[${buildId}] AI analyzing build failure...`);

    // Get project structure
    const fileTree = await getFileTree(projectDir);
    
    // Read key files
    const keyFiles = await readKeyFiles(projectDir);

    // Build prompt for Claude
    const prompt = buildAnalysisPrompt(fileTree, keyFiles, logs, errorMessage);

    // Call Claude API (with rate limit retry)
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: config.smartBuild.aiModel,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        });
        break;
      } catch (err) {
        const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
        if (isRateLimit && attempt < 2) {
          const waitSec = 30 * (attempt + 1);
          console.log(`[${buildId}] Rate limited — waiting ${waitSec}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
          continue;
        }
        throw err;
      }
    }

    const analysis = response.content[0].text;
    console.log(`[${buildId}] AI analysis complete`);

    // Parse Claude's response for fixes
    const fixes = parseFixesFromAnalysis(analysis);

    return {
      success: true,
      analysis,
      fixes,
    };

  } catch (error) {
    console.error(`[${buildId}] AI analysis failed:`, error.message);
    return {
      success: false,
      error: error.message,
      analysis: '',
      fixes: [],
    };
  }
}

/**
 * Apply AI-suggested fixes to project files
 * @param {string} buildId - Build identifier
 * @param {string} projectDir - Path to project directory
 * @param {Array} fixes - Array of fix objects
 * @param {boolean} skipExisting - Skip files that already exist (default: true for structure verification)
 * @returns {Promise<{success: boolean, appliedFixes: number, skippedFiles: Array}>}
 */
async function applyFixes(buildId, projectDir, fixes, skipExisting = true) {
  let appliedCount = 0;
  const skippedFiles = [];

  try {
    for (const fix of fixes) {
      if (fix.action === 'create' || fix.action === 'update') {
        const filePath = path.join(projectDir, fix.path);
        
        // Check if file already exists (protect user's code!)
        if (skipExisting && fix.action === 'create') {
          try {
            await fs.access(filePath);
            console.log(`[${buildId}] ⚠️  Skipped (file exists): ${fix.path}`);
            skippedFiles.push(fix.path);
            continue;
          } catch (err) {
            // File doesn't exist, safe to create
          }
        }
        
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, fix.content, 'utf-8');
        console.log(`[${buildId}] ✅ Applied fix: ${fix.action} ${fix.path}`);
        appliedCount++;
      } else if (fix.action === 'delete') {
        const filePath = path.join(projectDir, fix.path);
        await fs.unlink(filePath);
        console.log(`[${buildId}] ✅ Applied fix: delete ${fix.path}`);
        appliedCount++;
      }
    }

    return {
      success: true,
      appliedFixes: appliedCount,
      skippedFiles,
    };

  } catch (error) {
    console.error(`[${buildId}] Failed to apply fixes:`, error.message);
    return {
      success: false,
      error: error.message,
      appliedFixes: appliedCount,
      skippedFiles,
    };
  }
}

// Helper functions

async function getFileTree(dir, relativePath = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const tree = [];

  for (const entry of entries) {
    const relPath = path.join(relativePath, entry.name);
    
    // Skip common ignored directories
    if (['node_modules', 'target', '.git'].includes(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      const children = await getFileTree(path.join(dir, entry.name), relPath);
      tree.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        children,
      });
    } else {
      tree.push({
        name: entry.name,
        path: relPath,
        type: 'file',
      });
    }
  }

  return tree;
}

async function readKeyFiles(projectDir) {
  const keyFiles = {};
  const filesToRead = [
    'Anchor.toml',
    'Cargo.toml',
    'package.json',
  ];

  for (const fileName of filesToRead) {
    try {
      const filePath = path.join(projectDir, fileName);
      const content = await fs.readFile(filePath, 'utf-8');
      keyFiles[fileName] = content;
    } catch (err) {
      // File doesn't exist, skip
    }
  }

  return keyFiles;
}

function buildAnalysisPrompt(fileTree, keyFiles, logs, errorMessage) {
  return `You are a senior Solana/Anchor developer. A build has failed and I need your help to fix it.

## Project Structure
${JSON.stringify(fileTree, null, 2)}

## Key Configuration Files
${Object.entries(keyFiles).map(([name, content]) => `### ${name}\n\`\`\`\n${content}\n\`\`\``).join('\n\n')}

## Build Error
${errorMessage}

## Build Logs (last 100 lines)
\`\`\`
${logs.stdout.split('\n').slice(-100).join('\n')}
\`\`\`

## Your Task
Think step-by-step:
1. Read the COMPLETE error message — what exactly is it saying?
2. Identify the root cause (config issue, dependency conflict, code error, or missing file)
3. Plan the minimal fix that addresses ALL errors
4. Self-validate: is every file you generate syntactically valid?

Respond in this JSON format:
\`\`\`json
{
  "reasoning": "Step-by-step analysis of what went wrong and why your fix will work",
  "analysis": "Brief explanation for the user",
  "fixes": [
    {
      "action": "create|update|delete",
      "path": "relative/path/to/file",
      "content": "full file content (for create/update)",
      "reason": "why this fix is needed"
    }
  ]
}
\`\`\`

Provide COMPLETE file contents, not patches. Be concise but thorough.`;
}

function parseFixesFromAnalysis(analysis) {
  try {
    // Try to extract JSON from markdown code block
    const jsonMatch = analysis.match(/```json\s*([\s\S]*?)\s*```/);
    let parsed;
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1]);
    } else {
      // Try to parse the whole response as JSON
      parsed = JSON.parse(analysis);
    }

    // Log the AI's reasoning if present (helps debug AI decision-making)
    if (parsed.reasoning) {
      console.log(`[AI Reasoning] ${parsed.reasoning.slice(0, 500)}${parsed.reasoning.length > 500 ? '...' : ''}`);
    }

    return parsed.fixes || [];

  } catch (error) {
    console.error('Failed to parse AI fixes:', error.message);
    return [];
  }
}

/**
 * Verify Anchor project structure and generate missing files
 * @param {string} buildId - Build identifier
 * @param {string} projectDir - Path to project directory
 * @returns {Promise<{success: boolean, fixes: Array, analysis: string, autoFixed: boolean}>}
 */
async function verifyAndFixStructure(buildId, projectDir) {
  try {
    console.log(`[${buildId}] AI verifying project structure...`);

    // STEP 1: Read existing files FIRST
    let existingFiles = await readAllSourceFiles(projectDir);
    
    // STEP 2: Reorganize structure if needed (move lib.rs to correct location)
    const didReorganize = await reorganizeProjectStructure(buildId, projectDir, existingFiles);
    
    // STEP 3: Re-read files AFTER reorganization to get updated paths
    if (didReorganize) {
      console.log(`[${buildId}] 🔄 Re-scanning files after reorganization...`);
      existingFiles = await readAllSourceFiles(projectDir);
    }
    
    // STEP 4: Get updated project structure
    const fileTree = await getFileTree(projectDir);

    // STEP 5: Build prompt for Claude with CURRENT structure
    const prompt = buildStructureVerificationPrompt(fileTree, existingFiles);

    // STEP 6: Call Claude API (with rate limit retry)
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: config.smartBuild.aiModel,
          max_tokens: config.smartBuild.aiMaxTokens,
          messages: [{ role: 'user', content: prompt }],
        });
        break;
      } catch (err) {
        const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
        if (isRateLimit && attempt < 2) {
          const waitSec = 30 * (attempt + 1);
          console.log(`[${buildId}] Rate limited — waiting ${waitSec}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
          continue;
        }
        throw err;
      }
    }

    const analysis = response.content[0].text;
    console.log(`[${buildId}] AI structure analysis complete`);

    // STEP 7: Parse Claude's response for fixes
    let fixes = parseFixesFromAnalysis(analysis);

    // STEP 8: SAFETY - Filter out any .rs files (AI should NEVER create these!)
    const beforeCount = fixes.length;
    fixes = fixes.filter(fix => {
      const isRsFile = fix.path && fix.path.endsWith('.rs');
      if (isRsFile) {
        console.warn(`[${buildId}] ⚠️  REJECTED AI fix: Attempted to create .rs file: ${fix.path}`);
      }
      return !isRsFile;
    });
    
    if (beforeCount !== fixes.length) {
      console.log(`[${buildId}] 🛡️  Filtered out ${beforeCount - fixes.length} invalid .rs file fixes`);
    }

    // Auto-apply fixes (since this is pre-build verification)
    let autoFixed = false;
    let skippedFiles = [];
    if (fixes.length > 0) {
      const result = await applyFixes(buildId, projectDir, fixes, true); // skipExisting = true
      autoFixed = result.success;
      skippedFiles = result.skippedFiles || [];
      console.log(`[${buildId}] Auto-applied ${result.appliedFixes} structure fixes`);
      if (skippedFiles.length > 0) {
        console.log(`[${buildId}] Skipped ${skippedFiles.length} existing files: ${skippedFiles.join(', ')}`);
      }
    }

    return {
      success: true,
      analysis,
      fixes,
      autoFixed,
    };

  } catch (error) {
    console.error(`[${buildId}] AI structure verification failed:`, error.message);
    return {
      success: false,
      error: error.message,
      analysis: '',
      fixes: [],
      autoFixed: false,
    };
  }
}

async function readAllSourceFiles(projectDir) {
  const files = {};
  
  async function readRecursive(dir, relativePath = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const relPath = path.join(relativePath, entry.name);
      const fullPath = path.join(dir, entry.name);
      
      // Skip ignored directories
      if (['node_modules', 'target', '.git'].includes(entry.name)) {
        continue;
      }
      
      if (entry.isDirectory()) {
        await readRecursive(fullPath, relPath);
      } else if (entry.isFile()) {
        // Read Rust, TOML, and JSON files
        if (entry.name.endsWith('.rs') || entry.name.endsWith('.toml') || entry.name.endsWith('.json')) {
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            files[relPath] = content;
          } catch (err) {
            // Skip files that can't be read
          }
        }
      }
    }
  }
  
  await readRecursive(projectDir);
  return files;
}

/**
 * Reorganize project structure if needed (move lib.rs to correct location)
 * @param {string} buildId - Build identifier
 * @param {string} projectDir - Path to project directory
 * @param {object} existingFiles - Map of existing files
 * @returns {Promise<boolean>} True if reorganization was performed
 */
async function reorganizeProjectStructure(buildId, projectDir, existingFiles) {
  try {
    // Check if lib.rs exists in root (wrong location)
    const rootLibRs = existingFiles['lib.rs'];
    if (!rootLibRs) {
      return false; // No lib.rs in root, structure might be correct
    }

    // Check if lib.rs is already in correct location (programs/*/src/lib.rs)
    const alreadyInCorrectLocation = Object.keys(existingFiles).some(
      p => p.match(/^programs\/[^/]+\/src\/lib\.rs$/)
    );

    if (alreadyInCorrectLocation) {
      console.log(`[${buildId}] ✅ lib.rs already in correct location, skipping reorganization`);
      return false;
    }

    // Extract program name from lib.rs content
    const programName = extractProgramName(rootLibRs) || 'program';
    
    console.log(`[${buildId}] 📦 Reorganizing: Moving lib.rs to programs/${programName}/src/lib.rs`);

    // Create target directory
    const targetDir = path.join(projectDir, 'programs', programName, 'src');
    await fs.mkdir(targetDir, { recursive: true });

    // Move lib.rs to correct location
    const sourcePath = path.join(projectDir, 'lib.rs');
    const targetPath = path.join(targetDir, 'lib.rs');
    
    await fs.rename(sourcePath, targetPath);
    
    console.log(`[${buildId}] ✅ Moved lib.rs to programs/${programName}/src/lib.rs`);

    // Move any other .rs files in root to the same location
    let movedCount = 1; // lib.rs already moved
    for (const [filePath, content] of Object.entries(existingFiles)) {
      if (filePath.endsWith('.rs') && !filePath.includes('/')) {
        const fileName = path.basename(filePath);
        if (fileName !== 'lib.rs') { // Already moved
          const srcPath = path.join(projectDir, filePath);
          const dstPath = path.join(targetDir, fileName);
          await fs.rename(srcPath, dstPath);
          console.log(`[${buildId}] ✅ Moved ${fileName} to programs/${programName}/src/`);
          movedCount++;
        }
      }
    }

    console.log(`[${buildId}] 🎯 Reorganization complete: moved ${movedCount} file(s)`);
    return true; // Reorganization was performed

  } catch (error) {
    console.error(`[${buildId}] ❌ Failed to reorganize structure:`, error.message);
    return false; // Don't throw - let AI continue with fixes
  }
}

/**
 * Extract program name from lib.rs content
 * @param {string} content - lib.rs file content
 * @returns {string} Program name or null
 */
function extractProgramName(content) {
  // Try to extract from declare_id!
  const declareIdMatch = content.match(/declare_id!\s*\(\s*["']([^"']+)["']\s*\)/);
  if (declareIdMatch) {
    // Use the program ID as a hint (not the actual name, but can help)
    // Better to extract from module name or comments
  }

  // Try to extract from #[program] module name
  const programModMatch = content.match(/#\[program\]\s+(?:pub\s+)?mod\s+(\w+)/);
  if (programModMatch) {
    return programModMatch[1].replace(/_/g, '-'); // Convert snake_case to kebab-case
  }

  // Try to extract from instructions module
  const instructionsMatch = content.match(/pub\s+mod\s+(\w+)/);
  if (instructionsMatch) {
    return instructionsMatch[1].replace(/_/g, '-');
  }

  // Default fallback
  return 'program';
}

function buildStructureVerificationPrompt(fileTree, existingFiles) {
  // List all existing .rs files with their exact paths
  const existingRsFiles = Object.keys(existingFiles).filter(p => p.endsWith('.rs'));
  const hasLibRs = existingRsFiles.some(p => p.includes('lib.rs'));

  // Determine where the main .rs file(s) actually are — critical for lib.path
  const rsLocations = existingRsFiles.map(p => `  ${p}`).join('\n');

  return `You are a senior Solana/Anchor developer. A user has uploaded a project that needs configuration files generated for compilation.

## ═══════════════════════════════════════════════════
## STEP 1: MANDATORY REASONING
## ═══════════════════════════════════════════════════

Before generating ANY file, think step-by-step:
1. **What .rs files exist and where are they?** (check exact paths below)
2. **What is the program name?** (from \`#[program] mod NAME\` or \`declare_id!\`)
3. **What dependencies does the code use?** (scan ALL \`use\` statements)
4. **What config files already exist?** (don't recreate them)
5. **What config files are missing?** (generate only those)
6. **Self-validate:** Is every generated file syntactically valid TOML? Does \`lib.path\` point to the ACTUAL file location?

## ═══════════════════════════════════════════════════
## STEP 2: PROJECT CONTEXT
## ═══════════════════════════════════════════════════

### File Tree:
${JSON.stringify(fileTree, null, 2)}

### Existing Files (DO NOT RECREATE):
${Object.keys(existingFiles).map(p => `- ${p}`).join('\n')}

### .rs File Locations:
${rsLocations}
${hasLibRs ? '\n⚠️ User already provided lib.rs file(s). DO NOT create any .rs files.\n' : ''}

### File Contents:
${Object.entries(existingFiles).map(([filePath, content]) => `#### ${filePath}\n\`\`\`\n${content.slice(0, 3000)}${content.length > 3000 ? '\n... (truncated)' : ''}\n\`\`\``).join('\n\n')}

## ═══════════════════════════════════════════════════
## STEP 3: RULES
## ═══════════════════════════════════════════════════

- ⛔ NEVER create .rs files (user provided them)
- ✅ ONLY create missing .toml files: Anchor.toml, Cargo.toml, programs/*/Cargo.toml
- ✅ \`[lib] path\` MUST point to where the .rs file ACTUALLY IS (relative to Cargo.toml's directory)
- ✅ Keep config MINIMAL — don't add optional sections you're not sure about

## ═══════════════════════════════════════════════════
## STEP 4: COMPLETE ANCHOR FORMAT REFERENCE
## ═══════════════════════════════════════════════════

### ANCHOR.TOML — MINIMAL valid config for compilation:
\`\`\`toml
[toolchain]
anchor_version = "0.31.1"

[features]
resolution = true
skip-lint = false

[programs.localnet]
my_program = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "Localnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
\`\`\`

KEY POINTS:
- \`[programs.localnet]\` key = program module name (snake_case). Value = program ID from \`declare_id!\` or placeholder.
- Do NOT add \`[test]\` or \`[[test.genesis]]\` sections — they're optional and not needed for compilation.
- If \`[[test.genesis]]\` IS needed, each entry REQUIRES BOTH \`address\` AND \`program\` fields.

### WORKSPACE CARGO.TOML:
\`\`\`toml
[workspace]
members = ["programs/my-program"]
resolver = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1

[profile.release.build-override]
opt-level = 3
incremental = false
codegen-units = 1
\`\`\`

### PROGRAM CARGO.TOML (programs/my-program/Cargo.toml):
\`\`\`toml
[package]
name = "my-program"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "my_program"
# path = "../../src/lib.rs"  # Only if .rs is NOT at programs/my-program/src/lib.rs

[dependencies]
anchor-lang = "0.31.1"
anchor-spl = { version = "0.31.1", default-features = false, features = ["token"] }

[features]
default = []
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
\`\`\`

### DEPENDENCY EXTRACTION FROM CODE:
Scan ALL \`use\` statements in .rs files:
- \`use anchor_lang::\` → \`anchor-lang = "0.31.1"\`
- \`use anchor_spl::token\` → feature \`"token"\` (SAFE)
- \`use anchor_spl::associated_token\` → feature \`"associated_token"\` + add \`solana-program = "=2.1.0"\`
- \`use anchor_spl::metadata\` → feature \`"metadata"\` (SAFE)
- \`use anchor_spl::token_interface\` → feature \`"token"\` (NOT a separate feature)
- \`use solana_program::\` → do NOT add (re-exported by anchor-lang)
- \`use spl_token::\` → do NOT add (re-exported by anchor-spl)
- \`use switchboard_on_demand::\` → \`switchboard-on-demand = "0.1"\`

### CRITICAL anchor-spl RULES:
- ALWAYS use \`default-features = false\`
- ONLY add features the code actually imports
- SAFE features: \`token\`, \`memo\`, \`metadata\`, \`governance\`
- DANGEROUS features (need \`solana-program = "=2.1.0"\` pin): \`associated_token\`, \`token_2022\`, \`mint\`
- \`token_interface\` DOES NOT EXIST as a feature — use \`"token"\`
- Keep anchor-lang and anchor-spl at SAME version (0.31.1)
- \`[features] idl-build\` is REQUIRED for Anchor 0.31.x

### LIB PATH COMPUTATION:
The \`[lib] path\` is relative to the Cargo.toml file's directory.
- .rs at \`programs/X/src/lib.rs\`, Cargo.toml at \`programs/X/Cargo.toml\` → no path needed (default)
- .rs at \`src/lib.rs\` (root), Cargo.toml at \`programs/X/Cargo.toml\` → \`path = "../../src/lib.rs"\`
- .rs at \`ml/src/lib.rs\`, Cargo.toml at \`programs/X/Cargo.toml\` → \`path = "../../ml/src/lib.rs"\`

## ═══════════════════════════════════════════════════
## STEP 5: RESPOND
## ═══════════════════════════════════════════════════

Respond in this exact JSON format:
\`\`\`json
{
  "reasoning": "Step-by-step analysis: what files exist, what's missing, what dependencies the code needs, computed lib.path",
  "analysis": "Brief summary for the user",
  "fixes": [
    {
      "action": "create",
      "path": "Anchor.toml",
      "content": "FULL FILE CONTENT",
      "reason": "Missing workspace config"
    }
  ]
}
\`\`\`

⚠️ FINAL: If you create ANY .rs file, the system will REJECT your response. ONLY .toml files!`;
}

/**
 * Enhanced build failure analysis with full code context (used by smart build loop)
 * @param {string} buildId - Build identifier
 * @param {string} projectDir - Path to project directory
 * @param {object} logs - Build logs { stdout, stderr }
 * @param {string} errorMessage - Error message
 * @param {number} iteration - Current retry iteration (1+)
 * @returns {Promise<{success: boolean, fixes: Array, analysis: string, cannotFix: boolean}>}
 */
async function analyzeAndFixBuildFailure(buildId, projectDir, logs, errorMessage, iteration, onProgress, previousFixes) {
  const MAX_RETRIES = 5;
  const MAX_TOOL_ROUNDS = 8; // Max tool call round-trips per analysis

  const allFiles = await readAllSourceFiles(projectDir);
  const prompt = buildSmartFixPrompt(allFiles, logs, errorMessage, iteration, previousFixes);

  // Log approximate token count (~4 chars per token)
  const approxTokens = Math.round(prompt.length / 4);
  console.log(`[${buildId}] Prompt size: ~${approxTokens} tokens (${prompt.length} chars)`);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`[${buildId}] AI agent analyzing (iteration ${iteration}, attempt ${attempt + 1}/${MAX_RETRIES})...`);

      // ── Agentic loop: AI can call tools to research before proposing fixes ──
      let messages = [{ role: 'user', content: prompt }];
      let totalToolCalls = 0;

      let response = await anthropic.messages.create({
        model: config.smartBuild.aiModel,
        max_tokens: config.smartBuild.aiMaxTokens,
        tools: TOOL_DEFINITIONS,
        messages,
      });

      // Handle tool calls in a loop — the AI researches, then proposes fixes
      while (response.stop_reason === 'tool_use' && totalToolCalls < MAX_TOOL_ROUNDS) {
        const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');

        const toolResults = [];
        for (const call of toolUseBlocks) {
          totalToolCalls++;
          const inputSummary = JSON.stringify(call.input).slice(0, 120);
          console.log(`[${buildId}] AI tool call #${totalToolCalls}: ${call.name}(${inputSummary})`);

          if (onProgress) {
            const label = call.input.crate_name || call.input.query || call.input.url || '';
            onProgress(`Researching: ${call.name}(${label.slice(0, 60)})...`);
          }

          const result = await executeTool(call.name, call.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }

        // Continue the conversation with tool results
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });

        // Brief pause between tool round-trips to avoid rate limits
        await new Promise(r => setTimeout(r, 2000));

        response = await anthropic.messages.create({
          model: config.smartBuild.aiModel,
          max_tokens: config.smartBuild.aiMaxTokens,
          tools: TOOL_DEFINITIONS,
          messages,
        });
      }

      // Extract the final text response
      const textBlock = response.content.find(c => c.type === 'text');
      const analysis = textBlock ? textBlock.text : '';

      console.log(`[${buildId}] AI agent analysis complete (${totalToolCalls} tool calls)`);

      const fixes = parseFixesFromAnalysis(analysis);
      const cannotFix = /"cannotFix"\s*:\s*true/i.test(analysis);

      return {
        success: true,
        analysis,
        fixes: cannotFix ? [] : fixes,
        cannotFix,
      };

    } catch (error) {
      const isRateLimit = error.status === 429 || (error.message && error.message.includes('429'));

      if (isRateLimit && attempt < MAX_RETRIES - 1) {
        // Parse Retry-After header if available, otherwise wait 65s (just over 1 minute to reset per-minute limit)
        let waitSec = 65;
        if (error.headers && error.headers['retry-after']) {
          waitSec = Math.max(parseInt(error.headers['retry-after'], 10) || 65, 65);
        }
        console.log(`[${buildId}] Rate limited — waiting ${waitSec}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        if (onProgress) {
          onProgress(`Rate limited, waiting ${waitSec}s before retry (${attempt + 1}/${MAX_RETRIES})...`);
        }
        await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
        continue;
      }

      console.error(`[${buildId}] AI agent analysis failed:`, error.message);
      return {
        success: false,
        error: error.message,
        analysis: '',
        fixes: [],
        cannotFix: false,
      };
    }
  }
}

function buildSmartFixPrompt(allFiles, logs, errorMessage, iteration, previousFixes) {
  const rsFiles = {};
  const tomlFiles = {};

  for (const [filePath, content] of Object.entries(allFiles)) {
    if (filePath.endsWith('.rs')) rsFiles[filePath] = content;
    else if (filePath.endsWith('.toml')) tomlFiles[filePath] = content;
  }

  // Get full stdout text
  const fullStdout = typeof logs === 'object' ? (logs.stdout || '') : String(logs);
  const allLines = fullStdout.split('\n');

  // Environment info: first 20 lines
  const envLines = allLines.slice(0, 20).join('\n');

  // Error context: last 80 lines (focused on actual errors)
  const errorLines = allLines.slice(-80).join('\n');

  // Truncate source files to stay under token limits
  // ~4 chars per token, budget ~6000 tokens for source = ~24000 chars total
  const MAX_RS_CHARS = 4000;   // per .rs file
  const MAX_TOTAL_RS = 16000;  // total .rs content
  const MAX_TOML_CHARS = 2000; // per .toml file

  let totalRsChars = 0;
  const truncatedRs = {};
  for (const [p, c] of Object.entries(rsFiles)) {
    const truncated = c.length > MAX_RS_CHARS ? c.slice(0, MAX_RS_CHARS) + '\n// ... [truncated]' : c;
    if (totalRsChars + truncated.length <= MAX_TOTAL_RS) {
      truncatedRs[p] = truncated;
      totalRsChars += truncated.length;
    } else {
      truncatedRs[p] = c.slice(0, 500) + '\n// ... [large file truncated — ' + c.length + ' chars total]';
    }
  }

  const truncatedToml = {};
  for (const [p, c] of Object.entries(tomlFiles)) {
    truncatedToml[p] = c.length > MAX_TOML_CHARS ? c.slice(0, MAX_TOML_CHARS) + '\n# ... [truncated]' : c;
  }

  // Build previous fixes summary
  let previousFixesSummary = '';
  if (previousFixes && previousFixes.length > 0) {
    previousFixesSummary = `\n## PREVIOUSLY TRIED (FAILED — try something DIFFERENT):
${previousFixes.map((pf, i) => `${i + 1}. ${pf.files.join(', ')}: ${pf.summary.slice(0, 200)}`).join('\n')}
`;
  }

  return `You are a Solana/Anchor developer fixing a failed \`anchor build\`. Attempt #${iteration}.

## TOOLS — USE THEM before guessing:
- **lookup_crate(crate_name)** — versions on crates.io. ALWAYS verify before pinning!
- **lookup_crate_deps(crate_name, version)** — dependencies of a crate version
- **search_web(query)** — search for error solutions
- **fetch_page(url)** — read docs/READMEs

DO NOT GUESS version numbers. Look them up first.

## REASONING (fill "reasoning" field):
1. Read error details 2. Classify: config/dependency/code 3. Research with tools 4. Root cause 5. Minimal fix 6. Self-validate

## KEY RULES:
- Cargo.toml: \`"0.1.15"\` = ^0.1.15 (resolves to newest!). Use \`"=0.1.15"\` for exact pin.
- Version conflict → use \`"=X.Y.Z"\` with equals sign. Verify version exists with lookup_crate.
- anchor-spl: MUST use \`default-features = false\`, features = ["token"]. Keep same version as anchor-lang.
- Output COMPLETE file contents (not patches). Fix ALL errors, not just first.
- Do NOT repeat previously failed fixes — try fundamentally different approach.

## SAFETY — NEVER:
- Remove functions/structs/enums, simplify logic, create new .rs files, delete files, use todo!()/stubs
- If unfixable without breaking rules → set "cannotFix": true
${previousFixesSummary}
## PROJECT:
\`\`\`
${envLines}
\`\`\`

Files: ${Object.keys(allFiles).join(', ')}

### TOML files:
${Object.entries(truncatedToml).map(([p, c]) => `**${p}:**\n\`\`\`toml\n${c}\n\`\`\``).join('\n')}

### Rust files:
${Object.entries(truncatedRs).map(([p, c]) => `**${p}:**\n\`\`\`rust\n${c}\n\`\`\``).join('\n')}

### Error: ${errorMessage}

### Build logs (last 80 lines):
\`\`\`
${errorLines}
\`\`\`

## RESPOND with JSON:
\`\`\`json
{
  "reasoning": "...",
  "analysis": "1-2 sentence summary",
  "cannotFix": false,
  "fixes": [{ "action": "create|update", "path": "relative/path", "content": "COMPLETE file", "reason": "why" }]
}
\`\`\``;
}

module.exports = {
  analyzeBuildFailure,
  analyzeAndFixBuildFailure,
  applyFixes,
  verifyAndFixStructure,
  readAllSourceFiles,
  getFileTree,
  extractProgramName,
};
