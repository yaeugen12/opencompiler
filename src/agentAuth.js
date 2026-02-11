const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { runQuery, getOne, getAll } = require('./db');

function generateApiKey() {
  return 'ocsvc_' + crypto.randomBytes(32).toString('hex');
}

function generateVerificationCode() {
  const hex = crypto.randomBytes(2).toString('hex');
  return `oc-${hex}`;
}

async function registerAgent(name, description) {
  const agentId = uuidv4();
  const apiKey = generateApiKey();
  const createdAt = new Date().toISOString();

  // Generate unique verification code (retry on collision)
  let verificationCode;
  let attempts = 0;
  while (attempts < 10) {
    verificationCode = generateVerificationCode();
    const existing = await getOne(
      `SELECT agent_id FROM agents WHERE verification_code = ?`,
      [verificationCode]
    );
    if (!existing) break;
    attempts++;
  }
  if (attempts >= 10) {
    throw new Error('Failed to generate unique verification code');
  }

  await runQuery(
    `INSERT INTO agents (agent_id, api_key, name, description, verification_code, claim_status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [agentId, apiKey, name, description || null, verificationCode, createdAt]
  );

  return {
    agent_id: agentId,
    api_key: apiKey,
    name,
    description: description || null,
    verification_code: verificationCode,
    claim_status: 'pending',
    created_at: createdAt,
  };
}

async function claimAgent(verificationCode, xHandle) {
  const handle = xHandle.replace(/^@/, '').trim().toLowerCase();

  if (!/^[a-zA-Z0-9_]{1,15}$/.test(handle)) {
    throw new Error('Invalid X handle. Use 1-15 alphanumeric characters or underscores.');
  }

  const agent = await getOne(
    `SELECT * FROM agents WHERE verification_code = ? AND is_active = 1`,
    [verificationCode]
  );
  if (!agent) {
    throw new Error('Invalid or expired verification code');
  }
  if (agent.claim_status === 'claimed') {
    throw new Error('This agent has already been claimed');
  }

  // Check if X handle is already used by another claimed agent
  const handleInUse = await getOne(
    `SELECT agent_id FROM agents WHERE x_handle = ? AND claim_status = 'claimed' AND agent_id != ?`,
    [handle, agent.agent_id]
  );
  if (handleInUse) {
    throw new Error(`X handle @${handle} is already associated with another agent`);
  }

  await runQuery(
    `UPDATE agents SET x_handle = ?, claim_status = 'claimed' WHERE agent_id = ?`,
    [handle, agent.agent_id]
  );

  return {
    agent_id: agent.agent_id,
    name: agent.name,
    x_handle: handle,
    claim_status: 'claimed',
  };
}

async function getAgentByCode(verificationCode) {
  return getOne(
    `SELECT agent_id, name, description, claim_status, x_handle, created_at FROM agents WHERE verification_code = ?`,
    [verificationCode]
  );
}

async function verifyAgentKey(apiKey) {
  const agent = await getOne(`SELECT * FROM agents WHERE api_key = ? AND is_active = 1`, [apiKey]);
  if (!agent) return null;

  await runQuery(
    `UPDATE agents SET last_used_at = datetime('now'), request_count = request_count + 1 WHERE agent_id = ?`,
    [agent.agent_id]
  );

  return agent;
}

async function getAgent(agentId) {
  return getOne(`SELECT * FROM agents WHERE agent_id = ?`, [agentId]);
}

async function listAgents() {
  return getAll(
    `SELECT agent_id, name, description, x_handle, owner, verification_code, claim_status,
            created_at, last_used_at, request_count, is_active
     FROM agents ORDER BY created_at DESC`
  );
}

async function revokeAgent(agentId) {
  const result = await runQuery(`UPDATE agents SET is_active = 0 WHERE agent_id = ?`, [agentId]);
  return result.changes > 0;
}

module.exports = {
  registerAgent,
  claimAgent,
  getAgentByCode,
  verifyAgentKey,
  getAgent,
  listAgents,
  revokeAgent,
};
