# OpenCompiler - Anchor Compiler Service

REST API that compiles Solana Anchor smart contracts in isolated Docker containers.

**Production:** `https://api.opencompiler.io`

## Quick Start

```bash
# 1. Build the Anchor builder Docker image (~10-15 min)
docker build -f Dockerfile.anchor-builder -t anchor-builder:latest .

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.production.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# 4. Start
npm run dev
```

Service runs on `http://localhost:3000`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/compile` | Upload & compile (ZIP/TAR) |
| POST | `/compile/github` | Compile from GitHub URL |
| GET | `/compile/:id/status` | Build status + logs |
| GET | `/compile/:id/artifacts` | List artifacts |
| GET | `/compile/:id/artifacts/download/:type/:file` | Download artifact |
| POST | `/compile/:id/smart-build` | AI-powered build fixing |
| WS | `/ws` | Real-time build logs |

### Agent API (`/api/v1/`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/agent/register` | Register agent, get API key |
| POST | `/claim/:code` | Claim agent with X handle |
| POST | `/build` | Build from files or GitHub |
| GET | `/build/:id` | Build status |
| GET | `/build/:id/idl` | Download IDL |
| POST | `/project/create` | Create project from file map |
| POST | `/project/:id/file` | Write file |
| GET | `/project/:id/files` | List project files |

## Production Deployment (Hetzner)

```bash
# On a fresh Ubuntu 24.04 server:
./setup-hetzner.sh api.opencompiler.io your@email.com

# Configure
cp .env.production.example .env.production
nano .env.production

# Start
docker compose -f docker-compose.production.yml up -d

# Verify
curl https://api.opencompiler.io/health
```

## Architecture

- **Express.js** API with WebSocket support
- **Docker isolation** per build (2GB RAM, 2 CPU, no network)
- **Nginx** reverse proxy with SSL (Let's Encrypt)
- **SQLite** for agent management
- **Claude AI** for smart build error fixing (up to 8 iterations)

## Docker Images

| Image | Purpose |
|-------|---------|
| `Dockerfile.anchor-builder` | Rust 1.90 + Anchor 0.31.1 + Solana (builder) |
| `Dockerfile` | Node.js 18 Alpine (API server) |

## License

MIT
