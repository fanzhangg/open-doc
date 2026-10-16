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
// Web Searcher and File Searcher are granted as they are switched on: the
// run gets the tools, or never sees them.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeAdapter, codexAdapter, customAdapter } from './adapters.js';

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
      webAccess: agent.webAccess,
      fileAccess: agent.fileAccess,
    }),
  },
  codex: {
    label: 'Codex',
    adapter: (agent, { codexBin }) => codexAdapter({
      bin: codexBin ?? undefined,
      agentName: agent.name,
      model: agent.model ?? undefined,
      webAccess: agent.webAccess,
    }),
  },
  custom: {
    label: 'Custom command',
    adapter: (agent) => (agent.command
      ? customOrUnavailable(agent.command)
      : unavailableAdapter('custom', `No command is set for ${agent.name}; set it in Agents > Advanced.`)),
  },
};

/**
 * The dispatcher options for roster agent `agent` working on `docPath`.
 * `settings` gives what all agents share (where Claude Code and Codex are).
 * An agent with Auto Commenter also looks at comments that mention no one
 * (presence 'online'); any other only at comments addressed to it ('dnd').
 * A Doc Watcher (`watch`) also looks at every change others make to the doc.
 * @returns {{ id: string, name: string, persona: string, profile: object, adapter: object, limits: object, editMode: 'auto' | 'approve' | 'none', presence: 'online' | 'dnd', watch: boolean, warning: string | null }}
 */
export function agentSpec(agent, settings, docPath) {
  const runtime = RUNTIMES[agent.runtime];
  const adapter = runtime
    ? runtime.adapter(agent, settings, docPath)
    : unavailableAdapter(agent.runtime, `${agent.runtime} agents are not supported by this version of OpenDoc`);
  return {
    id: agent.id,
    name: agent.name,
    // One block for the prompt: the persona line, then the instructions.
    persona: [agent.persona, agent.instructions].map((t) => t.trim()).filter(Boolean).join('\n\n'),
    profile: { webAccess: agent.webAccess, fileAccess: agent.fileAccess },
    adapter,
    limits: { timeoutMs: agent.runTimeoutMinutes * 60 * 1000, runsPerHour: agent.runsPerHour },
    editMode: agent.editMode,
    presence: agent.autoComment ? 'online' : 'dnd',
    watch: agent.watchDoc,
    warning: hooksWarning(adapter, agent.isolated, docPath),
  };
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
