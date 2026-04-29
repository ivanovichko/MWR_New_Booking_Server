// Freshdesk agent name resolution.
//
// /api/v2/agents requires admin scope (403 for non-admin keys & sessions).
// /api/_/bootstrap/agents_groups is the internal endpoint the Freshdesk web
// UI uses to populate the assignee dropdown — readable by any logged-in agent.
//
// Caching:
//  - Bulk map is cached process-wide for AGENT_MAP_TTL_MS.
//  - Per-id resolution (deactivated agents not in the bootstrap response)
//    is memoized for the lifetime of the process.

const { fdGet } = require('./freshdeskService');

const AGENT_MAP_TTL_MS = 10 * 60 * 1000;
let _agentMapCache = null;
let _agentMapCacheTime = 0;
const _agentNameCache = new Map(); // id -> name | false (false = confirmed unresolvable)

async function fetchAgentMap() {
  if (_agentMapCache && Date.now() - _agentMapCacheTime < AGENT_MAP_TTL_MS) {
    return _agentMapCache;
  }
  try {
    const data = await fdGet('/api/_/bootstrap/agents_groups');
    const agents = data?.data?.agents || [];
    const map = {};
    agents.forEach(a => {
      const name = a.contact?.name || a.contact?.email || null;
      if (name) map[a.id] = name;
    });
    _agentMapCache = map;
    _agentMapCacheTime = Date.now();
    return map;
  } catch (e) {
    console.warn(`[agentService] bootstrap fetch failed: ${e.message}`);
    return _agentMapCache || {};
  }
}

// Returns a fresh shallow copy of the cached agent map (callers may mutate it).
async function fetchAllAgents() {
  return { ...(await fetchAgentMap()) };
}

async function resolveAgentName(id) {
  if (id == null) return null;
  if (_agentNameCache.has(id)) {
    const v = _agentNameCache.get(id);
    return v === false ? null : v;
  }
  const tryGet = async (path) => {
    try { return await fdGet(path); } catch { return null; }
  };
  const a = await tryGet(`/api/v2/agents/${id}`);
  if (a) {
    const name = a.contact?.name || a.name || a.contact?.email || null;
    if (name) { _agentNameCache.set(id, name); return name; }
  }
  const c = await tryGet(`/api/v2/contacts/${id}`);
  if (c) {
    const name = c.name || c.email || null;
    if (name) { _agentNameCache.set(id, name); return name; }
  }
  _agentNameCache.set(id, false);
  return null;
}

// Fill in any candidate ids not present in baseMap via per-id lookup. Mutates
// baseMap in place and returns it for convenience.
async function fillMissingAgentNames(baseMap, ids) {
  const missing = [...new Set(ids.filter(id => id != null && baseMap[id] == null))];
  if (!missing.length) return baseMap;
  const resolved = await Promise.all(missing.map(id => resolveAgentName(id).then(name => [id, name])));
  for (const [id, name] of resolved) {
    if (name) baseMap[id] = name;
  }
  return baseMap;
}

module.exports = { fetchAgentMap, fetchAllAgents, resolveAgentName, fillMissingAgentNames };
