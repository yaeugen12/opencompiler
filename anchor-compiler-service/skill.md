---
name: OpenCompiler - Anchor Compiler
version: 1.0.0
description: AI-accessible Solana Anchor smart contract compilation, building, and deployment service
base_url: https://api.opencompiler.io
auth:
  type: api_key
  header: X-Agent-Key
  registration: POST /api/v1/agent/register
capabilities:
  - compile_solana_programs
  - build_from_github
  - ai_powered_build_fixing
  - idl_generation
  - typescript_type_generation
  - program_deployment
---

# OpenCompiler - Anchor Compiler Service

## What This Service Does

Compiles, builds, and deploys Solana Anchor smart contracts. AI agents can:

- **Send Rust source code** and receive compiled `.so` programs, IDL JSON, and TypeScript types
- **Use AI-powered "smart build"** that automatically detects and fixes build errors (up to 8 iterations)
- **Deploy compiled programs** to Solana devnet or mainnet
- **Manage project files** — create, read, update, delete individual files in a project

## Authentication

### Step 1: Register

```
POST /api/v1/agent/register
Content-Type: application/json

{
  "name": "your-agent-name",
  "description": "What your agent does"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name for your agent |
| `description` | No | Brief description of what your agent does |

Response:
```json
{
  "agent_id": "uuid",
  "api_key": "ocsvc_abc123...",
  "name": "your-agent-name",
  "claim_url": "https://api.opencompiler.io/claim/oc-a1b2",
  "verification_code": "oc-a1b2",
  "claim_status": "pending",
  "message": "Store this API key securely. Send the claim_url to your human operator."
}
```

**Save your `api_key` immediately!** It cannot be retrieved later.

### Step 2: Use the key

Include in all subsequent requests:
```
X-Agent-Key: ocsvc_abc123...
```

### Step 3: Claim (link to X account)

Send the `claim_url` to your human operator. They will:
1. Visit the claim URL
2. Tweet the verification code
3. Enter their X handle to complete ownership verification

This links your agent to an X (Twitter) account, establishing human accountability.

## Quick Start: One-Shot Build

The simplest workflow — send code, get compiled result in a single request.

### Option A: Build from inline files

```
POST /api/v1/build
X-Agent-Key: <your-key>
Content-Type: application/json

{
  "name": "my_program",
  "files": {
    "programs/my_program/src/lib.rs": "use anchor_lang::prelude::*;\n\ndeclare_id!(\"Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS\");\n\n#[program]\npub mod my_program {\n    use super::*;\n    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {\n        Ok(())\n    }\n}\n\n#[derive(Accounts)]\npub struct Initialize {}",
    "Anchor.toml": "[toolchain]\nanchor_version = \"0.31.1\"\n\n[features]\nresolution = true\nskip-lint = false\n\n[programs.localnet]\nmy_program = \"Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS\"\n\n[registry]\nurl = \"https://api.apr.dev\"\n\n[provider]\ncluster = \"Localnet\"\nwallet = \"~/.config/solana/id.json\"",
    "Cargo.toml": "[workspace]\nmembers = [\"programs/my_program\"]\nresolver = \"2\"\n\n[profile.release]\noverflow-checks = true\nlto = \"fat\"\ncodegen-units = 1",
    "programs/my_program/Cargo.toml": "[package]\nname = \"my-program\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[lib]\ncrate-type = [\"cdylib\", \"lib\"]\nname = \"my_program\"\n\n[dependencies]\nanchor-lang = \"0.31.1\"\n\n[features]\ndefault = []\nidl-build = [\"anchor-lang/idl-build\"]"
  },
  "smartBuild": true
}
```

### Option B: Build from GitHub URL

```
POST /api/v1/build
X-Agent-Key: <your-key>
Content-Type: application/json

{
  "github_url": "https://github.com/user/repo",
  "smartBuild": true
}
```

Supports branch and subfolder paths:
- `https://github.com/user/repo` — clone entire repo (default branch)
- `https://github.com/user/repo/tree/main/programs/my-program` — specific branch + subfolder

Response (after 3-7 minutes):
```json
{
  "buildId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "success",
  "iterations": 1,
  "artifacts": {
    "programs": [
      {
        "name": "my_program.so",
        "type": "program",
        "downloadUrl": "/compile/550e.../artifacts/download/program/my_program.so"
      }
    ],
    "idl": [
      {
        "name": "my_program.json",
        "type": "idl",
        "downloadUrl": "/compile/550e.../artifacts/download/idl/my_program.json"
      }
    ],
    "types": [...],
    "deploy": [...]
  },
  "logs": { "stdout": "...", "stderr": "" },
  "buildDuration": 245
}
```

## Endpoints

### Agent Management

#### `POST /api/v1/agent/register`
Register a new agent and get an API key + claim URL for X verification.

- **Body**: `{ "name": "string", "description": "string (optional)" }`
- **Response**: `{ agent_id, api_key, name, description, claim_url, verification_code, claim_status, created_at }`

#### `POST /api/v1/claim/:code`
Complete agent claim — link agent to X handle after tweeting the verification code.

- **Body**: `{ "x_handle": "string" }`
- **Response**: `{ success, agent_id, name, x_handle, x_url, claim_status }`
- **Error 409**: Agent already claimed or X handle already in use

#### `GET /api/v1/agent/status`
Check own agent's claim status.

- **Auth**: `X-Agent-Key`
- **Response**: `{ agent_id, name, claim_status, x_handle }`

#### `GET /api/v1/agent/list`
List all registered agents.

- **Auth**: `X-Admin-Key`
- **Response**: `{ agents: [...] }`

#### `POST /api/v1/agent/:agentId/revoke`
Revoke an agent's access.

- **Auth**: `X-Admin-Key`
- **Response**: `{ message: "Agent revoked successfully" }`

---

### One-Shot Build

#### `POST /api/v1/build`
Send code and receive compiled result synchronously (up to 10 minutes). Accepts either inline files or a GitHub URL.

- **Auth**: `X-Agent-Key`
- **Body** (inline files):
  ```json
  {
    "name": "program_name",
    "files": {
      "path/to/file.rs": "file contents...",
      "Anchor.toml": "...",
      "Cargo.toml": "..."
    },
    "smartBuild": true,
    "timeout": 600
  }
  ```
- **Body** (GitHub import):
  ```json
  {
    "github_url": "https://github.com/user/repo",
    "smartBuild": true,
    "timeout": 600
  }
  ```
- **Response**:
  ```json
  {
    "buildId": "uuid",
    "source": "inline | github",
    "status": "success | failed",
    "iterations": 1,
    "artifacts": { "programs": [...], "idl": [...], "types": [...], "deploy": [...] },
    "logs": { "stdout": "...", "stderr": "..." },
    "error": null,
    "buildDuration": 245
  }
  ```

| Field | Description |
|-------|-------------|
| `name` | Program name (required for inline files mode) |
| `files` | Object mapping relative file paths to string contents (use this OR `github_url`) |
| `github_url` | GitHub repository URL to clone and build (use this OR `files`) |
| `smartBuild` | `true` (default): AI fixes errors automatically. `false`: single build attempt |
| `timeout` | Max wait in seconds (default 600, max 600) |

---

### Project Management (Multi-Step Workflow)

#### `POST /api/v1/project/create`
Create a project without building it.

- **Auth**: `X-Agent-Key`
- **Body**: `{ "name": "string", "files": { "path": "content", ... } }`
- **Response**: `{ buildId, status: "ready", fileCount }`

#### `GET /api/v1/project/:buildId/files`
List all files in the project (recursive tree). Skips `node_modules`, `target`, `.anchor` dirs.

- **Auth**: `X-Agent-Key`
- **Response**:
  ```json
  {
    "buildId": "uuid",
    "files": [
      { "name": "programs", "path": "programs", "type": "directory", "children": [...] },
      { "name": "Anchor.toml", "path": "Anchor.toml", "type": "file", "size": 312 }
    ]
  }
  ```

#### `GET /api/v1/project/:buildId/file?path=<file_path>`
Read a file's content from the project.

- **Auth**: `X-Agent-Key`
- **Query**: `path` — relative path to the file (e.g. `programs/my_program/src/lib.rs`)
- **Response**: `{ buildId, path, content, size }`

#### `POST /api/v1/project/:buildId/file`
Write or update a single file in the project. Creates parent directories automatically.

- **Auth**: `X-Agent-Key`
- **Body**: `{ "path": "programs/my_program/src/lib.rs", "content": "..." }`
- **Response**: `{ buildId, path, success, message }`

#### `DELETE /api/v1/project/:buildId/file`
Delete a file or folder from the project.

- **Auth**: `X-Agent-Key`
- **Body**: `{ "path": "programs/old_module/src/unused.rs" }`
- **Response**: `{ buildId, path, success, message }`

#### `POST /api/v1/project/:buildId/build`
Trigger a build on an existing project (synchronous).

- **Auth**: `X-Agent-Key`
- **Body**: `{ "smartBuild": true }`
- **Response**: Same as `POST /api/v1/build`

## Error Recovery Workflow

When a build fails, the response includes an `errors` array and a `next_steps` object with pre-filled endpoint URLs. Follow this workflow to fix and rebuild:

```
1. BUILD FAILS
   └─ Response includes: errors[], next_steps{}

2. READ THE ERRORS
   └─ errors: ["error[E0433]: failed to resolve: use of undeclared crate or module `foo`\n  --> programs/my_program/src/lib.rs:3:5"]

3. LIST PROJECT FILES
   GET /api/v1/project/:buildId/files
   └─ See full project structure

4. READ THE BROKEN FILE
   GET /api/v1/project/:buildId/file?path=programs/my_program/src/lib.rs
   └─ Read full source to understand context

5. FIX THE FILE
   POST /api/v1/project/:buildId/file
   { "path": "programs/my_program/src/lib.rs", "content": "<fixed code>" }

6. REBUILD
   POST /api/v1/project/:buildId/build
   { "smartBuild": true }

7. REPEAT until success
```

**Failed build response example:**
```json
{
  "buildId": "550e8400-...",
  "status": "failed",
  "errors": [
    "error[E0433]: failed to resolve: use of undeclared crate...\n  --> programs/my_program/src/lib.rs:3:5"
  ],
  "next_steps": {
    "message": "Build failed. Read the errors, fix the source files, then rebuild.",
    "list_files": "GET /api/v1/project/550e8400-.../files",
    "read_file": "GET /api/v1/project/550e8400-.../file?path=<file_path>",
    "write_file": "POST /api/v1/project/550e8400-.../file",
    "delete_file": "DELETE /api/v1/project/550e8400-.../file",
    "rebuild": "POST /api/v1/project/550e8400-.../build"
  }
}
```

---

### Build Status & Artifacts

#### `GET /api/v1/build/:buildId`
Get build status and logs.

- **Auth**: `X-Agent-Key`
- **Response**:
  ```json
  {
    "buildId": "uuid",
    "status": "ready | running | success | failed",
    "createdAt": "ISO date",
    "updatedAt": "ISO date",
    "completedAt": "ISO date",
    "logs": { "stdout": "...", "stderr": "..." },
    "exitCode": 0
  }
  ```

#### `GET /api/v1/build/:buildId/artifacts`
List compiled artifacts with download URLs.

- **Auth**: `X-Agent-Key`
- **Response**:
  ```json
  {
    "buildId": "uuid",
    "artifacts": {
      "programs": [{ "name": "prog.so", "type": "program", "downloadUrl": "..." }],
      "idl": [{ "name": "prog.json", "type": "idl", "downloadUrl": "..." }],
      "types": [{ "name": "prog.ts", "type": "types", "downloadUrl": "..." }],
      "deploy": [{ "name": "prog-keypair.json", "type": "deploy", "downloadUrl": "..." }]
    }
  }
  ```

#### `GET /api/v1/build/:buildId/idl`
Get IDL JSON directly (convenience endpoint).

- **Auth**: `X-Agent-Key`
- **Response**: `{ buildId, name, idl: { ... } }`

### Artifact Downloads

#### `GET /compile/:buildId/artifacts/download/:type/:filename`
Download a specific artifact binary.

- **Params**: `type` = program | idl | types | deploy
- **Note**: Keypair downloads (`deploy` type, `*-keypair.json`) require `X-Agent-Key` + build ownership. Other artifacts are public.
- **Response**: Binary file download

---

### Deploy (via existing endpoints)

#### `POST /compile/:buildId/deploy/prepare`
Prepare deployment.

- **Body**: `{ "network": "devnet" | "mainnet", "walletAddress": "base58 (optional)", "programKeypair": [u8; 64] (optional — required if keypair was already purged from server) }`
- **Response**: `{ deployerAddress, estimatedCostSol, programAddress, network }`

#### `POST /compile/:buildId/deploy/execute`
Execute deployment.

- **Response**: `{ buildId, status: "deploying" }`

#### `GET /compile/:buildId/deploy/status`
Check deployment status.

- **Response**: `{ buildId, status, network, programId, explorerUrl }`

---

## Anchor Project Structure

An Anchor project requires these files at minimum:

```
programs/<name>/src/lib.rs      # Program source code (Rust)
programs/<name>/Cargo.toml      # Program crate config
Anchor.toml                     # Workspace config
Cargo.toml                      # Workspace Cargo config
```

If you set `smartBuild: true` and omit config files, the AI will attempt to generate them automatically.

### Minimal `lib.rs` Template

```rust
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod my_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
```

### Minimal `Anchor.toml`

```toml
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
```

## Rate Limits

| Limit | Value |
|-------|-------|
| API requests | 300 per 15 minutes |
| Builds | 20 per hour |
| Concurrent builds per agent | 1 (wait for active build to finish) |
| Max files per project | 100 |
| Max total file size | 10 MB |

## Typical Build Times

- Simple program (1 file): 3-4 minutes
- Complex program with dependencies: 5-7 minutes
- Smart build with AI fixes: 5-10 minutes (multiple iterations)

## Real-Time Build Logs (WebSocket)

The build endpoint (`POST /api/v1/build`) is synchronous — it blocks until the build completes. If you want live progress while waiting, connect to the WebSocket:

```
ws://<host>/ws
```

After starting a build, send:
```json
{"action": "subscribe", "buildId": "<buildId>"}
```

You'll receive messages like:
```json
{"type": "log", "buildId": "...", "data": {"stdout": "Compiling my_program...", "stderr": ""}}
{"type": "status", "buildId": "...", "status": "completed"}
```

**Tip for agents:** Since the build endpoint blocks and returns the full result, WebSocket is optional. It's mainly useful if you want to show progress to a human user or detect failures early.

## Keypair Security

Program keypairs (`*-keypair.json`) are sensitive — they contain the secret key that controls your program address.

**How it works:**

1. When a build succeeds, the `keypairs` array is included **inline** in the build response:
   ```json
   {
     "buildId": "...",
     "status": "success",
     "keypairs": [
       {
         "name": "my_program",
         "filename": "my_program-keypair.json",
         "pubkey": "7Wd3nK...",
         "secret": [174, 12, 55, ...]
       }
     ]
   }
   ```
2. **Keypair files are deleted from the server immediately after the response is sent.**
3. The keypair is delivered only once, through the authenticated channel. It cannot be retrieved again.

**What you must do:**
- Save the `keypairs` array from the build response locally and securely.
- If you need to deploy later, pass the keypair back in the deploy prepare request:
  ```json
  POST /compile/:buildId/deploy/prepare
  {
    "network": "devnet",
    "programKeypair": [174, 12, 55, ...]
  }
  ```

**Access controls:**
- Keypair file downloads via the artifact endpoint require `X-Agent-Key` + build ownership verification.
- The `/builds` endpoint (which lists all build IDs) requires admin authentication.
- Other artifact types (`.so`, IDL `.json`, `.ts` types) remain openly downloadable.

## Notes

- All builds are cleaned up after 60 minutes
- Build IDs are UUIDs — treat them as opaque tokens
- The `smartBuild` mode uses Claude AI to analyze and fix compilation errors
