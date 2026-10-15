// What the dispatcher runs for one agent of a doc, from the user's roster
// (src/core/agents.js) or from `serve` flags: the runtime's adapter, limits,
// persona, and a warning when the doc's project has Claude Code hooks that
// every run would execute.
//
// Runtimes are the only place that knows a specific agent program. Each turns
// an agent's settings into an adapter (adapters.js) the dispatcher drives; the
// dispatcher, the persona and the page know nothing about them. Supporting
// another agent (a local open model, …) is adding a runtime here and an
// adapter, plus its name to RUNTIMES in src/core/agents.js.
//
// Web and Your files are asked for at first use (permissions.js): a Claude
// Code run asks the human through a hook and waits; a custom command may ask
// the same way, by running `opendoc guard`. Codex cannot ask during a run,
// so a Codex agent searches the web only once the human allowed it in
// advance (in this doc or always), from its profile card.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeAdapter, codexAdapter, customAdapter } from './adapters.js';
import { holds } from './permissions.js';

export const RUNTIMES = {
  claude: {
    label: 'Claude Code',
    adapter: (agent, { claudeBin }) => claudeAdapter({
      bin: claudeBin ?? undefined,
      agentName: agent.name,
      model: agent.model ?? undefined,
      maxTurns: agent.maxTurns,
      maxBudgetUsd: agent.maxBudgetUsd ?? undefined,
      isolated: agent.isolated,
      asks: asksOf(agent),
    }),
  },
  codex: {
    label: 'Codex',
    adapter: (agent, { codexBin, grants = [] }, docPath) => codexAdapter({
      bin: codexBin ?? undefined,
      agentName: agent.name,
      model: agent.model ?? undefined,
      webAccess: agent.webAccess && holds(grants, { agentId: agent.id, permission: 'web', docPath }),
    }),
  },
  custom: {
    label: 'Custom command',
    adapter: (agent) => (agent.command
      ? customOrUnavailable(agent.command)
      : unavailableAdapter('custom', `No command is set for ${agent.name}; set it in Settings > Agents.`)),
  },
};

/**
 * The dispatcher options for roster agent `agent` working on `docPath`.
 * `settings` gives what all agents share (where Claude Code and Codex are).
 * The pilot answers every comment not addressed to someone else (presence
 * 'online'); a co-pilot only comments that @mention it ('dnd').
 * `asks` are the permissions its runs ask the human for at first use.
 * @returns {{ id: string, name: string, persona: string, role: string, profile: object, asks: string[], adapter: object, limits: object, editMode: 'auto' | 'approve', presence: 'online' | 'dnd', warning: string | null }}
 */
export function agentSpec(agent, settings, docPath) {
  const runtime = RUNTIMES[agent.runtime];
  const adapter = runtime
    ? runtime.adapter(agent, settings, docPath)
    : unavailableAdapter(agent.runtime, `${agent.runtime} agents are not supported by this version of OpenDoc`);
  return {
    id: agent.id,
    name: agent.name,
    persona: agent.persona,
    role: agent.role,
    profile: { tagline: agent.tagline, webAccess: agent.webAccess, fileAccess: agent.fileAccess },
    asks: agent.runtime === 'codex' ? [] : asksOf(agent),
    adapter,
    limits: { timeoutMs: agent.runTimeoutMinutes * 60 * 1000, runsPerHour: agent.runsPerHour },
    editMode: agent.editMode,
    presence: agent.role === 'pilot' ? 'online' : 'dnd',
    warning: hooksWarning(adapter, agent.isolated, docPath),
  };
}

/** The permissions agent `agent` may ask for: 'web', 'files'. */
export function asksOf(agent) {
  return [...(agent.webAccess ? ['web'] : []), ...(agent.fileAccess ? ['files'] : [])];
}

/** The hooks warning for a Claude Code agent working on `docPath`, or null. */
export function hooksWarning(adapter, isolated, docPath) {
  if (adapter.name !== 'claude' || isolated) return null;
  const hooks = projectHooks(adapter.workdir?.(docPath) ?? dirname(docPath));
  return hooks ? `${hooks} defines hooks; the agent's runs will execute them (isolated runs skip them)` : null;
}

// The nearest .claude settings file that defines hooks, if any.
export function projectHooks(dir) {
  for (let current = dir; ; current = dirname(current)) {
    for (const file of ['settings.json', 'settings.local.json']) {
      const path = join(current, '.claude', file);
      try {
        if (/"hooks"\s*:/.test(readFileSync(path, 'utf8'))) return path;
      } catch {
        // no such file
      }
    }
    if (dirname(current) === current) return null;
  }
}

function customOrUnavailable(command) {
  try {
    return customAdapter(command);
  } catch (error) {
    return unavailableAdapter('custom', error.message);
  }
}

// An agent that cannot run until its settings are fixed: the dispatcher shows
// it as unavailable with `error`.
function unavailableAdapter(name, error) {
  return {
    name,
    program: null,
    supportsSessions: false,
    async preflight() {
      return { ok: false, error };
    },
    command() {
      throw new Error(error);
    },
    parse() {
      return { ok: false, error };
    },
  };
}
