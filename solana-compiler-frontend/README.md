# OpenCompiler - Frontend

Solana Anchor smart contract compiler IDE. Upload a ZIP or paste a GitHub URL and get compiled programs in minutes.

**Production:** `https://opencompiler.io`
**Backend API:** `https://api.opencompiler.io`

## Features

- Upload ZIP or import from GitHub
- Monaco editor with Rust syntax highlighting
- Real-time build logs via WebSocket
- AI-powered smart build (auto-fixes errors)
- Download compiled artifacts (.so, IDL, TypeScript types)
- Phantom/Solflare wallet integration for deployment
- Devnet and Mainnet support

## Deploy to Vercel

```bash
npx vercel --prod
```

Then add custom domain `opencompiler.io` in Vercel dashboard.

No build step required - single static HTML file served directly.

## Development

```bash
# Serve locally (any static file server works)
python3 -m http.server 8080

# Backend must be running on localhost:3000
```

The frontend auto-detects localhost and connects to `http://localhost:3000`.
In production it connects to `https://api.opencompiler.io`.

## Configuration

The backend URL can be overridden:
```javascript
window.OPENCOMPILER_API = 'https://your-custom-backend.com';
```

## Tech Stack

- Vanilla JavaScript (no build tools)
- Tailwind CSS (CDN)
- Monaco Editor (CDN)
- Solana Web3.js (CDN)

## License

MIT
