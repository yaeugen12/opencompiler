/**
 * AI Agent Tools — gives the smart build AI the ability to research
 * instead of relying only on hardcoded knowledge.
 *
 * Tools:
 *   lookup_crate        — look up crate versions/info on crates.io
 *   lookup_crate_deps   — look up dependencies of a specific crate version
 *   search_web          — web search for error solutions / documentation
 *   fetch_page          — fetch and extract text from a URL
 */

// ── Rate limiter for crates.io (1 req/sec) ──────────────────────
let lastCratesIoReq = 0;
async function rateLimitCratesIo() {
  const now = Date.now();
  const elapsed = now - lastCratesIoReq;
  if (elapsed < 1100) {
    await new Promise(r => setTimeout(r, 1100 - elapsed));
  }
  lastCratesIoReq = Date.now();
}

// ── Tool Definitions (Claude API format) ─────────────────────────
const TOOL_DEFINITIONS = [
  {
    name: 'lookup_crate',
    description:
      'Look up a Rust crate on crates.io. Returns available versions (newest first), ' +
      'yanked status, description, and repository URL. ' +
      'Use this when you need to know what versions exist, find a compatible version, ' +
      'or check if a specific version actually exists before pinning to it.',
    input_schema: {
      type: 'object',
      properties: {
        crate_name: {
          type: 'string',
          description: 'Crate name as in Cargo.toml (e.g. "switchboard-on-demand")',
        },
      },
      required: ['crate_name'],
    },
  },
  {
    name: 'lookup_crate_deps',
    description:
      'Look up the dependencies of a specific crate version on crates.io. ' +
      'Returns all direct dependencies with their version requirements. ' +
      'Use this to understand what transitive dependencies a crate pulls in ' +
      'and diagnose version conflicts.',
    input_schema: {
      type: 'object',
      properties: {
        crate_name: {
          type: 'string',
          description: 'Crate name',
        },
        version: {
          type: 'string',
          description: 'Exact version to inspect (e.g. "0.1.20")',
        },
      },
      required: ['crate_name', 'version'],
    },
  },
  {
    name: 'search_web',
    description:
      'Search the web for technical solutions, documentation, or error fixes. ' +
      'Use this when you encounter an unfamiliar error, need to find the correct ' +
      'way to use a library, or want to check if others have solved the same problem.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query (e.g. "anchor-spl 0.31 associated_token version conflict")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description:
      'Fetch a web page and extract its text content. ' +
      'Use for reading docs.rs documentation, GitHub README files, ' +
      'crate documentation, Stack Overflow answers, or GitHub issues.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
      },
      required: ['url'],
    },
  },
];

// ── Tool Execution ───────────────────────────────────────────────
async function executeTool(toolName, input) {
  try {
    switch (toolName) {
      case 'lookup_crate':
        return await lookupCrate(input.crate_name);
      case 'lookup_crate_deps':
        return await lookupCrateDeps(input.crate_name, input.version);
      case 'search_web':
        return await searchWeb(input.query);
      case 'fetch_page':
        return await fetchPage(input.url);
      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  } catch (err) {
    return JSON.stringify({ error: `Tool ${toolName} failed: ${err.message}` });
  }
}

// ── crates.io: lookup crate ─────────────────────────────────────
async function lookupCrate(crateName) {
  await rateLimitCratesIo();

  const url = `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'anchor-compiler-service/1.0 (build-error-fixer)' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    return JSON.stringify({
      error: `Crate "${crateName}" not found on crates.io (HTTP ${res.status})`,
    });
  }

  const data = await res.json();
  const crate = data.crate || {};
  const versions = (data.versions || []).slice(0, 30).map(v => ({
    version: v.num,
    yanked: v.yanked || false,
    published: v.created_at ? v.created_at.split('T')[0] : null,
  }));

  return JSON.stringify({
    name: crate.name,
    description: (crate.description || '').slice(0, 200),
    repository: crate.repository || null,
    documentation: crate.documentation || null,
    max_version: crate.max_version,
    max_stable_version: crate.max_stable_version || crate.max_version,
    versions,
    total_versions: data.versions ? data.versions.length : 0,
    hint: 'Use "=X.Y.Z" (with equals sign) in Cargo.toml to pin to an exact version. ' +
          '"X.Y.Z" without = means ^X.Y.Z which may resolve to a newer version!',
  }, null, 2);
}

// ── crates.io: lookup crate dependencies ────────────────────────
async function lookupCrateDeps(crateName, version) {
  await rateLimitCratesIo();

  const url = `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}/${encodeURIComponent(version)}/dependencies`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'anchor-compiler-service/1.0 (build-error-fixer)' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    return JSON.stringify({
      error: `Version "${version}" of "${crateName}" not found (HTTP ${res.status}). ` +
             `This version may not exist — try looking up available versions with lookup_crate first.`,
    });
  }

  const data = await res.json();
  const deps = (data.dependencies || []).map(d => ({
    name: d.crate_id,
    version_req: d.req,
    kind: d.kind, // normal, dev, build
    optional: d.optional || false,
    default_features: d.default_features !== false,
    features: d.features || [],
  }));

  // Separate by kind for clarity
  const normal = deps.filter(d => d.kind === 'normal' || !d.kind);
  const dev = deps.filter(d => d.kind === 'dev');
  const build = deps.filter(d => d.kind === 'build');

  return JSON.stringify({
    crate: crateName,
    version,
    dependencies: normal,
    dev_dependencies: dev.length > 0 ? dev : undefined,
    build_dependencies: build.length > 0 ? build : undefined,
  }, null, 2);
}

// ── Web search (DuckDuckGo HTML) ────────────────────────────────
async function searchWeb(query) {
  // Try DuckDuckGo HTML search
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    return JSON.stringify({ error: `Web search failed (HTTP ${res.status})` });
  }

  const html = await res.text();

  // Parse DuckDuckGo HTML results
  const results = [];

  // Match result links and snippets
  const linkRegex = /<a[^>]*rel="nofollow"[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const links = [];
  const snippets = [];
  let m;

  while ((m = linkRegex.exec(html)) !== null) {
    links.push({ url: m[1], title: m[2].replace(/<[^>]*>/g, '').trim() });
  }
  while ((m = snippetRegex.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]*>/g, '').trim());
  }

  for (let i = 0; i < Math.min(links.length, 8); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || '',
    });
  }

  if (results.length === 0) {
    // Fallback: extract any text from page
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return JSON.stringify({
      query,
      results: [],
      note: 'No structured results found.',
      raw_excerpt: text.slice(0, 3000),
    }, null, 2);
  }

  return JSON.stringify({ query, results }, null, 2);
}

// ── Fetch page content ──────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0',
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });

  if (!res.ok) {
    return JSON.stringify({ error: `Failed to fetch ${url} (HTTP ${res.status})` });
  }

  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('json')) {
    const json = await res.json();
    return JSON.stringify(json, null, 2).slice(0, 8000);
  }

  const html = await res.text();

  // Strip scripts, styles, then HTML tags
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, 8000);
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
};
