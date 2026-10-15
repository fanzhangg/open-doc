// What the human allowed an agent to do beyond the doc, at first use.
//
// An agent's profile says which risky permissions it may ask for (`webAccess`,
// `fileAccess` in src/core/agents.js), like an app's manifest; a run asks the
// human the first time it needs one, like Android's runtime permissions or VS
// Code's tool approval. The human answers Allow once (the rest of that run),
// Allow in this doc, Always, or Deny (the rest of that run). The two lasting
// answers become grants, kept in the user's settings with a revoke button.
// A grant of files may be limited to a folder.
//
// Pure, so the server and the page validate them the same way; matching a
// grant against a path is the server's (src/server/agents/permissions.js).

export const PERMISSIONS = Object.freeze(['web', 'files']);
export const PERMISSION_LABELS = Object.freeze({ web: 'Web', files: 'Your files' });
export const ANSWERS = Object.freeze(['once', 'doc', 'always', 'deny']);
export const MAX_GRANTS = 500;

/** How long a run waits for the human's answer before the request counts as denied. */
export const ASK_TIMEOUT_MS = 5 * 60 * 1000;

const path = (v) => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\0\r\n]/.test(v);
const orNull = (rule) => (v) => v === null || rule(v);

const GRANT_RULES = {
  id: (v) => typeof v === 'string' && /^g_[A-Za-z0-9_-]{4,40}$/.test(v),
  agent: (v) => typeof v === 'string' && /^a_[A-Za-z0-9_-]{4,40}$/.test(v),
  permission: (v) => PERMISSIONS.includes(v),
  doc: orNull(path),
  folder: orNull(path),
  at: (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)),
};

/**
 * One grant, as stored: `agent` is the agent's id (a rename keeps its
 * grants), `doc` the absolute path of the doc it holds in (null: every doc),
 * `folder` the folder a grant of files is limited to (null: all files but
 * secrets).
 */
export function validGrant(grant) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return false;
  if (Object.keys(grant).some((key) => !Object.hasOwn(GRANT_RULES, key))) return false;
  if (!Object.entries(GRANT_RULES).every(([key, rule]) => rule(grant[key]))) return false;
  return grant.permission === 'files' || grant.folder === null;
}

/** A whole list of grants, for a settings patch. */
export function validGrants(value) {
  return Array.isArray(value) && value.length <= MAX_GRANTS && value.every(validGrant)
    && new Set(value.map((g) => g.id)).size === value.length;
}

/** Stored grants → the valid ones, each id once, at most MAX_GRANTS (the newest). */
export function resolveGrants(stored) {
  const out = [];
  for (const grant of Array.isArray(stored) ? stored : []) {
    if (validGrant(grant) && !out.some((g) => g.id === grant.id)) out.push(grant);
  }
  return out.slice(-MAX_GRANTS);
}
