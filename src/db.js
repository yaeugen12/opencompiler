const sqlite3 = require('sqlite3').verbose();
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');

let db = null;

function runQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getOne(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function getAll(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function initDatabase() {
  const dbPath = config.agent.dbPath;
  const dbDir = path.dirname(dbPath);

  await fs.mkdir(dbDir, { recursive: true });

  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(dbPath, async (err) => {
      if (err) return reject(err);

      try {
        await runQuery(`
          CREATE TABLE IF NOT EXISTS agents (
            agent_id TEXT PRIMARY KEY,
            api_key TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            x_handle TEXT,
            verification_code TEXT UNIQUE,
            claim_status TEXT NOT NULL DEFAULT 'pending',
            owner TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_used_at TEXT,
            request_count INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1
          )
        `);

        await runQuery(`
          CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key)
        `);

        await runQuery(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_x_handle ON agents(x_handle)
        `);

        await runQuery(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_verification_code ON agents(verification_code)
        `);

        console.log(`Agent database initialized at ${dbPath}`);
        resolve();
      } catch (migrationErr) {
        reject(migrationErr);
      }
    });
  });
}

function getDb() {
  return db;
}

module.exports = {
  initDatabase,
  getDb,
  runQuery,
  getOne,
  getAll,
};
