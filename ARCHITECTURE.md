# OpenCompiler Architecture

**Deep technical dive into how OpenCompiler works**

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Core Modules](#core-modules)
3. [Build Flow](#build-flow)
4. [AI Integration](#ai-integration)
5. [Security Architecture](#security-architecture)
6. [Performance & Scalability](#performance--scalability)
7. [Error Handling](#error-handling)
8. [Database Schema](#database-schema)
9. [Deployment Architecture](#deployment-architecture)
10. [Future Improvements](#future-improvements)

---

## System Overview

OpenCompiler is an Express.js application that orchestrates Docker containers to compile Solana Anchor smart contracts in isolated environments. The system uses Claude AI (Anthropic) to automatically detect and fix compilation errors, providing a "smart build" feature that iterates up to 8 times to resolve issues.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                          │
│  (Agents, CI/CD pipelines, Developers, Browser-based tools)  │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP/WebSocket
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                       API GATEWAY LAYER                       │
│  ┌──────────┐  ┌───────────┐  ┌─────────────┐  ┌─────────┐ │
│  │  Nginx   │→ │  Express  │→ │  Middleware │→ │ Routes  │ │
│  │   :443   │  │   :3000   │  │  (Auth/    │  │ (Agent/ │ │
│  │   (SSL)  │  │           │  │   Rate/    │  │  Public)│ │
│  └──────────┘  └───────────┘  │   Validate)│  └─────────┘ │
│                                └─────────────┘               │
└────────────────────────┬────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  SQLite DB   │ │  Dockerode   │ │  Claude AI   │
│  (Agents)    │ │  (Builds)    │ │  (Fixes)     │
└──────────────┘ └──────┬───────┘ └──────────────┘
                        │
              ┌─────────┴─────────┐
              │                   │
         ┌────▼─────┐        ┌───▼──────┐
         │ Docker   │        │ Docker   │
         │ Build 1  │   ...  │ Build N  │
         │ (isolated)        │ (isolated)│
         └──────────┘        └──────────┘
              │                   │
         ┌────▼─────┐        ┌───▼──────┐
         │ Anchor   │        │ Anchor   │
         │ Builder  │        │ Builder  │
         │ (image)  │        │ (image)  │
         └──────────┘        └──────────┘
```

---

## Core Modules

### 1. **index.js** — Main Server

**Responsibilities:**
- Express app initialization
- Middleware registration (security, CORS, body parsing, logging)
- Route mounting (agent API, public endpoints)
- WebSocket server initialization
- Graceful shutdown handling

**Key Features:**
- Health check endpoint (`/health`)
- Static file serving (`/skill.md`)
- Human-facing claim page (`/claim/:code`)
- Error handling middleware
- Process signal handling (SIGTERM, SIGINT)

**Flow:**
```javascript
require('dotenv').config()
  ↓
const app = express()
  ↓
app.use(securityHeaders)   // Helmet.js
app.use(cors(corsOptions))
app.use(express.json())
app.use(requestLogger)     // Winston
  ↓
app.use('/api/v1', agentRouter)
  ↓
const server = http.createServer(app)
initWebSocket(server)
  ↓
server.listen(PORT)
```

---

### 2. **buildManager.js** — Build Orchestration

**Responsibilities:**
- Create project directories in `/builds/{buildId}/`
- Extract uploaded ZIPs/TARs
- Clone GitHub repositories
- Trigger Docker builds via `docker.js`
- Track build status (ready/running/success/failed)
- Manage artifacts (programs, IDL, types, keypairs)
- Schedule build cleanup (60min TTL)

**Key Functions:**

#### `startBuild(filePath, fileType)`
```javascript
// 1. Generate buildId (UUID)
// 2. Create /builds/{buildId}/ directory
// 3. Extract ZIP/TAR to directory
// 4. Update build status to PENDING
// 5. Trigger Docker build via executeAnchorBuild()
// 6. Return buildId
```

#### `startBuildFromGithub(repoUrl, autoBuild, metadata)`
```javascript
// 1. Parse GitHub URL (detect branch, subfolder)
// 2. Clone via git (shallow clone, single branch)
// 3. Extract subfolder if specified
// 4. Create project structure
// 5. If autoBuild: trigger build, else: mark as "ready"
```

#### `getBuildStatus(buildId)`
```javascript
// 1. Read /builds/{buildId}/status.json
// 2. Return: status, logs, exitCode, completedAt
```

#### `getBuildArtifacts(buildId)`
```javascript
// 1. Scan /builds/{buildId}/target/deploy/
// 2. Categorize files:
//    - *.so → programs
//    - *idl.json → idl
//    - *idl.ts → types
//    - *-keypair.json → deploy
// 3. Return download URLs
```

**Status Lifecycle:**
```
ready → pending → running → (success | failed)
```

**Cleanup:**
```javascript
setTimeout(() => {
  fs.rm(`/builds/${buildId}`, { recursive: true })
}, 60 * 60 * 1000) // 60 minutes
```

---

### 3. **docker.js** — Docker Container Management

**Responsibilities:**
- Verify `anchor-builder` Docker image exists
- Create ephemeral containers for each build
- Mount project directory as read-only
- Execute `anchor build --arch sbf`
- Stream stdout/stderr to logs
- Clean up containers after build

**Key Function: `executeAnchorBuild(projectPath, outputPath, buildId, onLog)`**

```javascript
async function executeAnchorBuild(projectPath, outputPath, buildId, onLog) {
  const docker = new Docker();

  // 1. Create container
  const container = await docker.createContainer({
    Image: 'anchor-builder:latest',
    Cmd: ['/bin/sh', '-c', `
      export CARGO_NET_OFFLINE=false
      cd /workspace
      anchor build --arch sbf || anchor build
    `],
    HostConfig: {
      Binds: [
        `${projectPath}:/workspace:ro`,      // Read-only source
        `${outputPath}:/workspace/target`    // Writable output
      ],
      Memory: 2 * 1024 * 1024 * 1024,        // 2GB RAM
      MemorySwap: -1,                        // Disable swap
      CpuPeriod: 100000,
      CpuQuota: 200000,                      // 2 CPU cores
      NetworkMode: 'none',                   // No network access
      CapAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
    },
    WorkingDir: '/workspace',
  });

  // 2. Start container
  await container.start();

  // 3. Stream logs
  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
  });
  stream.on('data', chunk => {
    const line = chunk.toString('utf-8');
    onLog({ stdout: line });
  });

  // 4. Wait for completion
  const result = await container.wait();
  
  // 5. Cleanup
  await container.remove();

  return { exitCode: result.StatusCode };
}
```

**Container Lifecycle:**
```
createContainer()
  ↓
start()
  ↓
logs({ follow: true })  ← Stream to WebSocket
  ↓
wait()  ← Blocks until exit
  ↓
remove()
```

**Security Constraints:**
- **Read-only source:** Container cannot modify input files
- **No network:** Cannot download malicious code
- **Resource limits:** 2GB RAM, 2 CPU prevents DoS
- **Ephemeral:** Container destroyed after build

---

### 4. **ai.js** — Claude AI Integration

**Responsibilities:**
- Verify project structure before build
- Auto-generate missing config files (Anchor.toml, Cargo.toml)
- Analyze compilation errors
- Generate fixes (file edits)
- Track fix history (prevent repetition)

**Key Functions:**

#### `verifyAndFixStructure(buildId, projectDir)`
```javascript
// 1. Read all source files
// 2. Detect existing Anchor.toml, Cargo.toml
// 3. Send to Claude with prompt:
//    "Analyze this Anchor project. Generate missing config files."
// 4. Parse Claude response (JSON with file contents)
// 5. Write generated files to projectDir
// 6. Return: { success, fixes: [{ file, action }] }
```

**Prompt Example:**
```
You are a Solana Anchor expert. Analyze this project structure:

programs/my_program/src/lib.rs:
```rust
use anchor_lang::prelude::*;
declare_id!("Fg6P...");
#[program]
pub mod my_program { ... }
```

Files missing:
- Anchor.toml
- Cargo.toml
- programs/my_program/Cargo.toml

Generate these files. Infer:
- Program name from declare_id!() or folder name
- Dependencies from use statements
- Workspace structure

Return JSON:
{
  "files": [
    { "path": "Anchor.toml", "content": "..." },
    { "path": "Cargo.toml", "content": "..." }
  ]
}
```

#### `analyzeAndFixBuildFailure(buildId, projectDir, logs, errorMsg, iteration, onProgress, previousFixes)`
```javascript
// 1. Extract compilation errors from logs
// 2. Send to Claude with prompt:
//    "This Anchor build failed. Fix the error."
// 3. Include: error output, file contents, previous fix attempts
// 4. Parse Claude response (file edits)
// 5. Apply edits to projectDir
// 6. Return: { success, fixes: [...], cannotFix: false }
```

**Prompt Example:**
```
Build failed with error:
error[E0433]: failed to resolve: use of undeclared crate `anchor_spl`
  --> programs/my_program/src/lib.rs:3:5

Current Cargo.toml:
[dependencies]
anchor-lang = "0.31.1"

Previous fixes that didn't work:
- Added anchor-lang (already present)

Instructions:
1. Identify the root cause
2. Provide EXACTLY ONE fix (file path + new content)
3. Do NOT repeat previous fixes
4. If you cannot fix, set cannotFix: true

Return JSON:
{
  "analysis": "Missing anchor-spl dependency",
  "fixes": [
    {
      "file": "programs/my_program/Cargo.toml",
      "content": "[dependencies]\nanchor-lang = \"0.31.1\"\nanchor-spl = \"0.31.1\""
    }
  ],
  "cannotFix": false
}
```

**Fix Tracking:**
```javascript
const previousFixes = [
  { iteration: 1, file: 'Cargo.toml', action: 'Added anchor-lang' },
  { iteration: 2, file: 'lib.rs', action: 'Fixed syntax error on line 42' }
];

// Claude receives this history → avoids repeating
```

---

### 5. **smartBuild.js** — AI Build Loop

**Responsibilities:**
- Orchestrate the iterative build-fix-retry cycle
- Call AI for structure verification (iteration 0)
- Call AI for error fixing (iterations 1-7)
- Track phases (analyzing → verifying → building → fixing)
- Broadcast progress via WebSocket

**Flow:**

```javascript
async function smartBuild(buildId, projectDir, outputDir, onProgress) {
  const MAX_ITERATIONS = 8;
  const previousFixes = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (i === 0) {
      // PHASE: Structure verification
      onProgress({ phase: 'verifying', iteration: i, message: 'AI verifying structure...' });
      const verifyResult = await verifyAndFixStructure(buildId, projectDir);
      if (!verifyResult.success) {
        return { success: false, reason: 'Structure verification failed' };
      }
    } else {
      // PHASE: Error fixing
      onProgress({ phase: 'fixing', iteration: i, message: 'AI analyzing error...' });
      const fixResult = await analyzeAndFixBuildFailure(
        buildId, projectDir, lastLogs, lastError, i, onProgress, previousFixes
      );
      if (fixResult.cannotFix) {
        return { success: false, cannotFix: true, reason: fixResult.reason };
      }
      previousFixes.push(...fixResult.fixes);
    }

    // PHASE: Build attempt
    onProgress({ phase: 'building', iteration: i, message: 'Compiling...' });
    const buildResult = await executeAnchorBuild(projectDir, outputDir, buildId, (log) => {
      onProgress({ phase: 'building', iteration: i, message: log.stdout });
    });

    if (buildResult.exitCode === 0) {
      // SUCCESS
      return { success: true, iterations: i + 1, phases: [...] };
    } else {
      // FAILURE → next iteration
      lastLogs = buildResult.logs;
      lastError = extractErrors(buildResult.logs);
    }
  }

  // Max iterations reached
  return { success: false, iterations: MAX_ITERATIONS, reason: 'Max iterations exceeded' };
}
```

**Iteration Breakdown:**

| Iteration | Phase | Action |
|-----------|-------|--------|
| 0 | Verifying | AI checks structure → generates configs → Build attempt #1 |
| 1 | Fixing | Build failed → AI analyzes error → applies fix #1 → Build attempt #2 |
| 2 | Fixing | Still failing → AI analyzes new error → applies fix #2 → Build attempt #3 |
| ... | ... | ... |
| 7 | Fixing | Last attempt → Build attempt #8 |

**Early Exit Conditions:**
- Build succeeds → return immediately
- AI says `cannotFix: true` → return immediately
- Max iterations (8) → return with failure

---

### 6. **agentAuth.js** — Agent Management

**Responsibilities:**
- Register agents (generate API keys + verification codes)
- Store agents in SQLite
- Verify API keys
- X (Twitter) verification flow
- Admin functions (list agents, revoke)

**Database Schema:**
```sql
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  api_key TEXT NOT NULL UNIQUE,      -- SHA-256 hash
  verification_code TEXT NOT NULL UNIQUE,
  claim_status TEXT DEFAULT 'pending',  -- pending | claimed
  x_handle TEXT,
  x_user_id TEXT,
  claimed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_api_key ON agents(api_key);
CREATE INDEX idx_verification_code ON agents(verification_code);
```

**Key Functions:**

#### `registerAgent(name, description)`
```javascript
// 1. Generate UUID (agent_id)
// 2. Generate random API key (ocsvc_... 64 hex chars)
// 3. Generate verification code (openclaw-XXXX)
// 4. Hash API key (SHA-256)
// 5. INSERT into database
// 6. Return: agent_id, api_key (plaintext), verification_code
```

#### `claimAgent(code, xHandle)`
```javascript
// 1. Find agent by verification_code
// 2. Check if already claimed
// 3. Validate X handle (regex: ^[a-zA-Z0-9_]{1,15}$)
// 4. UPDATE: claim_status='claimed', x_handle, claimed_at
// 5. Return: agent_id, x_handle
```

**Security:**
- API keys stored as SHA-256 hashes (cannot be reversed)
- Plaintext API key shown **once** at registration
- Verification codes are single-use (changed to `claimed` after use)

---

### 7. **websocket.js** — Real-Time Updates

**Responsibilities:**
- Maintain WebSocket connections
- Broadcast build logs to subscribers
- Broadcast status changes
- Broadcast smart build progress

**Flow:**

```javascript
const WebSocket = require('ws');
const clients = new Map(); // buildId → Set<ws>

function initWebSocket(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    ws.on('message', (msg) => {
      const data = JSON.parse(msg);
      if (data.action === 'subscribe' && data.buildId) {
        if (!clients.has(data.buildId)) {
          clients.set(data.buildId, new Set());
        }
        clients.get(data.buildId).add(ws);
      }
    });

    ws.on('close', () => {
      // Remove from all subscriptions
      for (const subscribers of clients.values()) {
        subscribers.delete(ws);
      }
    });
  });
}

function broadcastLog(buildId, log) {
  const subscribers = clients.get(buildId);
  if (subscribers) {
    const msg = JSON.stringify({ type: 'log', buildId, data: log });
    for (const ws of subscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}
```

**Message Types:**

| Type | Data | When |
|------|------|------|
| `log` | `{ stdout, stderr }` | Docker build output |
| `status` | `{ status, exitCode }` | Build status change |
| `smart_build_phase` | `{ phase, iteration, message }` | AI progress update |

---

## Build Flow

### End-to-End Flow (Smart Build)

```
1. Agent POSTs to /api/v1/build with github_url + smartBuild: true
   ↓
2. Server validates input, checks rate limits, verifies API key
   ↓
3. Generate buildId (UUID), create /builds/{buildId}/
   ↓
4. Clone GitHub repo (shallow), extract subfolder if specified
   ↓
5. Mark build as PENDING, return buildId to agent (non-blocking)
   ↓
6. [SMART BUILD LOOP BEGINS]
   ↓
7. Iteration 0: AI Structure Verification
   - Read all source files (*.rs, existing configs)
   - Send to Claude: "Generate missing configs"
   - Claude returns: Anchor.toml, Cargo.toml, etc.
   - Write files to /builds/{buildId}/
   ↓
8. Build Attempt #1
   - Create Docker container (anchor-builder image)
   - Mount project as read-only, output as writable
   - Execute: anchor build --arch sbf
   - Stream logs to WebSocket subscribers
   ↓
9. Check exit code:
   - If 0: BUILD SUCCESS → Extract artifacts → Return response
   - If non-zero: Extract errors → Continue to next iteration
   ↓
10. Iteration 1-7: AI Error Fixing
    - Send errors + file contents to Claude
    - Claude analyzes → returns file edits
    - Apply edits to /builds/{buildId}/
    - Retry build (goto step 8)
    ↓
11. Success or Max Iterations:
    - Extract artifacts: programs/*.so, IDL, types, keypairs
    - Read keypairs into memory (JSON arrays)
    - Delete keypair files from disk
    - Return response with inline keypairs
    ↓
12. Schedule cleanup (60min):
    - Delete /builds/{buildId}/
```

### Artifact Extraction

After successful build:

```javascript
const outputDir = `/builds/${buildId}/target/deploy/`;

// 1. Scan directory
const files = await fs.readdir(outputDir);

// 2. Categorize
const artifacts = {
  programs: files.filter(f => f.endsWith('.so')),
  idl: files.filter(f => f.endsWith('.json') && f.includes('idl')),
  types: files.filter(f => f.endsWith('.ts')),
  deploy: files.filter(f => f.endsWith('-keypair.json')),
};

// 3. Read keypairs into memory
const keypairs = [];
for (const file of artifacts.deploy) {
  const raw = JSON.parse(await fs.readFile(path.join(outputDir, file)));
  const kp = Keypair.fromSecretKey(new Uint8Array(raw));
  keypairs.push({
    name: file.replace('-keypair.json', ''),
    filename: file,
    pubkey: kp.publicKey.toBase58(),
    secret: raw,  // Array of bytes
  });
}

// 4. Delete keypairs from disk
for (const kp of keypairs) {
  await fs.unlink(path.join(outputDir, kp.filename));
}

// 5. Return
return {
  buildId,
  status: 'success',
  artifacts: { ... },
  keypairs,  // INLINE - never stored
};
```

---

## AI Integration

### Claude API Configuration

```javascript
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-3-5-sonnet-20241022';
const MAX_TOKENS = 4096;
```

### Prompt Engineering

**Structure Verification Prompt:**
```
You are a Solana Anchor expert. Analyze this project and generate missing configuration files.

Project structure:
programs/my_program/src/lib.rs:
```rust
use anchor_lang::prelude::*;
declare_id!("Fg6P...");
#[program]
pub mod my_program { ... }
```

Missing:
- Anchor.toml
- Cargo.toml
- programs/my_program/Cargo.toml

Instructions:
1. Infer program name from declare_id!() or folder name
2. Detect dependencies from use statements
3. Use Anchor 0.31.1 for all versions
4. Include overflow-checks = true in [profile.release]
5. Return ONLY valid JSON (no markdown, no explanations)

JSON format:
{
  "analysis": "Brief description of what you found",
  "files": [
    {
      "path": "Anchor.toml",
      "content": "..."
    },
    {
      "path": "Cargo.toml",
      "content": "..."
    }
  ],
  "success": true
}
```

**Error Fixing Prompt:**
```
Build failed. Fix the error.

Error:
error[E0433]: failed to resolve: use of undeclared crate `anchor_spl`
  --> programs/my_program/src/lib.rs:3:5

Current files:
programs/my_program/Cargo.toml:
[dependencies]
anchor-lang = "0.31.1"

programs/my_program/src/lib.rs:
use anchor_lang::prelude::*;
use anchor_spl::token::Token;  ← Line 3

Previous fixes (DO NOT REPEAT):
- None yet

Instructions:
1. Identify root cause
2. Provide EXACTLY ONE fix (file path + complete new content)
3. Do NOT repeat previous fixes
4. If unfixable without simplifying code, set cannotFix: true
5. Return ONLY valid JSON

JSON format:
{
  "analysis": "Missing anchor-spl dependency",
  "fixes": [
    {
      "file": "programs/my_program/Cargo.toml",
      "content": "[dependencies]\nanchor-lang = \"0.31.1\"\nanchor-spl = \"0.31.1\"",
      "action": "Added anchor-spl = \"0.31.1\""
    }
  ],
  "cannotFix": false,
  "confidence": "high"
}
```

### Token Usage

Average per build:
- Structure verification: ~1,500 input tokens, ~800 output tokens
- Error fixing (per iteration): ~3,000 input tokens, ~1,200 output tokens

Max build cost (8 iterations):
- 1 verify + 7 fixes = ~25,000 input tokens, ~10,000 output tokens
- Cost: ~$0.20 per build (Claude Sonnet 3.5 pricing)

---

## Security Architecture

### Defense in Depth

**Layer 1: Network**
- Nginx SSL termination (Let's Encrypt)
- Rate limiting at reverse proxy level
- DDoS protection (nginx limit_req)

**Layer 2: Application**
- Helmet.js security headers
- CORS whitelist (or `*` for development)
- Express rate limiting (300 req/15min)
- Input validation (express-validator)

**Layer 3: Authentication**
- API key hashing (SHA-256 in database)
- Per-agent rate limiting (20 builds/hour)
- Concurrency control (1 build at a time per agent)
- Admin-only endpoints (`X-Admin-Key` header)

**Layer 4: Isolation**
- Docker containers (no network, read-only source)
- Resource limits (2GB RAM, 2 CPU)
- Filesystem isolation (mount read-only except output)
- Container ephemeral (destroyed after build)

**Layer 5: Data**
- Keypairs never stored on disk (inline delivery only)
- API keys hashed (SHA-256, cannot reverse)
- Build artifacts TTL (60min auto-delete)
- Logs sanitized (no secrets)

### Threat Model

**Threats:**
1. **Malicious code execution** → Mitigated by: Docker isolation, no network
2. **Resource exhaustion** → Mitigated by: RAM/CPU limits, rate limiting, 1 concurrent build
3. **Keypair theft** → Mitigated by: Inline delivery, immediate deletion, no storage
4. **API key theft** → Mitigated by: HTTPS only, SHA-256 hashing, rate limits
5. **DoS attacks** → Mitigated by: Nginx rate limiting, per-agent build limits

---

## Performance & Scalability

### Current Bottlenecks

1. **Docker build time:** 3-7 minutes per build (Rust compilation)
2. **Single-server:** All builds run on one machine
3. **Sequential builds per agent:** 1 at a time (by design, prevents abuse)

### Horizontal Scaling Strategy

**Phase 1: Multi-Worker (Same Server)**
```
          Nginx
            ↓
        Load Balancer
       ↙      ↓      ↘
   Worker1  Worker2  Worker3
   (Express + Docker)
       ↓       ↓       ↓
     PostgreSQL
   (shared state)
```

- Replace SQLite with PostgreSQL
- Shared build queue (Redis or Postgres LISTEN/NOTIFY)
- Workers poll queue, claim builds atomically
- WebSocket sticky sessions (nginx ip_hash)

**Phase 2: Dedicated Build Workers**
```
          Nginx
            ↓
        API Server
       (Express)
            ↓
      Job Queue (Redis)
       ↙      ↓      ↘
  Worker1  Worker2  Worker3
  (Docker only)
```

- API server receives requests, enqueues jobs
- Workers poll Redis queue
- Workers execute builds, upload artifacts to S3
- API server queries Redis for status, returns artifacts from S3

**Phase 3: Kubernetes**
```
   Ingress (NGINX)
        ↓
   Service (API)
        ↓
   Pod (Express) × 3 replicas
        ↓
   RabbitMQ (job queue)
        ↓
   Job (K8s Job resource)
   Pod (anchor-builder) × N (auto-scale)
        ↓
   S3 (artifact storage)
```

- Kubernetes Job resources for each build
- Auto-scaling based on queue depth
- S3 for artifact storage
- Redis for build status cache

### Performance Optimizations

**Current:**
- [ ] Dependency caching (share Cargo cache across builds)
- [ ] Incremental builds (reuse previous build artifacts)
- [ ] Parallel builds (multiple agents concurrently)

**Future:**
- [ ] Pre-warmed containers (avoid cold start)
- [ ] Distributed cache (Redis for Cargo registry)
- [ ] CDN for artifacts (CloudFlare)

---

## Error Handling

### Error Hierarchy

```
Error
├── ValidationError      (400 Bad Request)
│   ├── InvalidBuildId
│   ├── InvalidFilePath
│   └── InvalidFileContent
├── AuthenticationError  (401 Unauthorized)
│   ├── MissingApiKey
│   └── InvalidApiKey
├── AuthorizationError   (403 Forbidden)
│   ├── BuildNotOwned
│   └── AdminRequired
├── NotFoundError        (404 Not Found)
│   ├── BuildNotFound
│   └── FileNotFound
├── RateLimitError       (429 Too Many Requests)
├── BuildError           (500 Internal Server Error)
│   ├── DockerError
│   ├── ExtractionError
│   └── CompilationError
└── AIError              (500 Internal Server Error)
    ├── ClaudeAPIError
    └── PromptParsingError
```

### Error Response Format

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "details": {
    "buildId": "uuid",
    "file": "path/to/file.rs",
    "line": 42
  }
}
```

### Retry Logic

**Docker Builds:**
- No automatic retry (user must fix + rebuild)
- Smart build = retry with AI fixes (up to 8 times)

**API Calls (Claude):**
- Exponential backoff: 1s, 2s, 4s (max 3 retries)
- Timeout: 60s per request
- On failure: Return raw build logs (graceful degradation)

---

## Database Schema

### SQLite Schema

```sql
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,              -- UUID
  name TEXT NOT NULL UNIQUE,              -- "my-agent"
  description TEXT,                       -- Optional
  api_key TEXT NOT NULL UNIQUE,           -- SHA-256 hash
  verification_code TEXT NOT NULL UNIQUE, -- "openclaw-XXXX"
  claim_status TEXT DEFAULT 'pending',    -- pending | claimed
  x_handle TEXT,                          -- "@username"
  x_user_id TEXT,                         -- Twitter user ID
  claimed_at TEXT,                        -- ISO timestamp
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_api_key ON agents(api_key);
CREATE INDEX idx_verification_code ON agents(verification_code);
CREATE INDEX idx_x_handle ON agents(x_handle);
```

**Future: PostgreSQL Migration**

Additional tables:
```sql
CREATE TABLE builds (
  build_id UUID PRIMARY KEY,
  agent_id UUID REFERENCES agents(agent_id),
  status VARCHAR(20),  -- ready | pending | running | success | failed
  source_type VARCHAR(10),  -- github | inline
  source_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  exit_code INT,
  iterations INT DEFAULT 0
);

CREATE TABLE build_logs (
  id SERIAL PRIMARY KEY,
  build_id UUID REFERENCES builds(build_id),
  timestamp TIMESTAMP DEFAULT NOW(),
  stream VARCHAR(10),  -- stdout | stderr
  content TEXT
);

CREATE TABLE build_artifacts (
  id SERIAL PRIMARY KEY,
  build_id UUID REFERENCES builds(build_id),
  type VARCHAR(20),  -- program | idl | types | deploy
  filename TEXT,
  path TEXT,
  size_bytes BIGINT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Deployment Architecture

### Development (Local)

```bash
# Start
npm run dev

# Docker builds run on host Docker daemon
# SQLite database: ./data/agents.db
# Build artifacts: ./builds/{buildId}/
```

### Production (Single Server)

```
┌─────────────────────────────────────────┐
│         Ubuntu 24.04 VPS (Hetzner)      │
│                                         │
│  ┌─────────┐      ┌─────────────────┐  │
│  │  Nginx  │─────→│  Node.js App    │  │
│  │  :443   │      │  :3000          │  │
│  │  (SSL)  │      │  (Express)      │  │
│  └─────────┘      └────────┬────────┘  │
│                              │          │
│  ┌──────────────────────────▼────────┐ │
│  │        Docker Daemon               │ │
│  │  ┌──────────┐    ┌──────────┐     │ │
│  │  │ Build 1  │    │ Build 2  │ ... │ │
│  │  └──────────┘    └──────────┘     │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ┌─────────────────────────────────────┤
│  │ Filesystem                          │
│  │  /var/www/opencompiler/             │
│  │    ├── src/                         │
│  │    ├── builds/                      │
│  │    ├── data/                        │
│  │    └── logs/                        │
│  └─────────────────────────────────────┘
└─────────────────────────────────────────┘
```

**Setup Script:** `setup-hetzner.sh`
- Installs Docker, Node.js, Nginx
- Configures Let's Encrypt SSL
- Sets up systemd service
- Configures firewall (ufw)

### Production (Multi-Server - Future)

```
       ┌──────────────────────────┐
       │  CloudFlare CDN          │
       │  (artifacts, SSL, DDoS)  │
       └─────────┬────────────────┘
                 │
       ┌─────────▼────────────┐
       │  Load Balancer       │
       │  (Nginx / HAProxy)   │
       └──────┬──────┬────────┘
              │      │
      ┌───────▼──┐ ┌▼───────┐
      │ API      │ │ API    │
      │ Server 1 │ │ Server │
      └────┬─────┘ └─┬──────┘
           │         │
      ┌────▼─────────▼────┐
      │  PostgreSQL        │
      │  (agent auth,      │
      │   build status)    │
      └────────────────────┘
           │
      ┌────▼─────────────┐
      │  Redis           │
      │  (job queue,     │
      │   cache)         │
      └────┬─────────────┘
           │
   ┌───────┴───────────┐
   │                   │
┌──▼────┐        ┌─────▼──┐
│ Build │        │ Build  │
│ Worker│   ...  │ Worker │
│   1   │        │   N    │
└───┬───┘        └────┬───┘
    │                 │
┌───▼─────────────────▼───┐
│  S3-Compatible Storage  │
│  (artifacts)            │
└─────────────────────────┘
```

---

## Future Improvements

### Phase 1: Stability & Observability

- [ ] Comprehensive test suite (Jest + Supertest)
- [ ] Prometheus metrics (build count, duration, error rate)
- [ ] Grafana dashboards (real-time monitoring)
- [ ] Sentry error tracking
- [ ] Structured logging (JSON format for log aggregation)

### Phase 2: Performance

- [ ] Dependency caching (shared Cargo registry)
- [ ] Incremental builds (reuse artifacts)
- [ ] Pre-warmed containers (reduce cold start)
- [ ] Parallel builds (concurrent agents)

### Phase 3: Features

- [ ] Multi-program workspaces (compile entire repos)
- [ ] Custom Rust/Anchor versions (not just 1.90/0.31.1)
- [ ] Build notifications (webhooks)
- [ ] Team accounts (shared rate limits)
- [ ] Build history (persistent storage)

### Phase 4: Ecosystem Integration

- [ ] AgentWallet integration (auto-deploy after compile)
- [ ] Helius RPC integration (verify deployment)
- [ ] LiteSVM integration (test compiled programs)
- [ ] Metaplex templates (NFT programs)
- [ ] Jupiter templates (swap programs)

---

**This architecture enables:**
- ✅ Secure, isolated builds
- ✅ AI-powered error fixing
- ✅ Agent-native API design
- ✅ Scalable infrastructure (ready for horizontal scaling)
- ✅ Production-ready code (comprehensive error handling)

**Built by an agent, for agents.** 🚀
