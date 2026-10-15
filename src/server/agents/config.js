// What the dispatcher runs for a doc, from the user's agent settings
// (Settings > Agent) or from `serve` flags: the adapter, limits, and a warning
// when the doc's project has Claude Code hooks that every run would execute.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeAdapter, customAdapter } from './adapters.js';

/**
 * The agent for `docPath` from saved agent settings, or null when it is off.
 * @returns {null | { name: string, adapter: object, limits: object, mentionsOnly: boolean, warning: string | null }}
 */
export function agentFromSettings(settings, docPath) {
  if (!settings.enabled) return null;
  let adapter;
  if (settings.kind === 'custom') {
    adapter = settings.command
      ? customOrUnavailable(settings.command)
      : unavailableAdapter('custom', 'No command is set for the custom agent; set it in Settings > Agent.');
  } else {
    adapter = claudeAdapter({
      bin: settings.bin ?? undefined,
      model: settings.model ?? undefined,
      maxTurns: settings.maxTurns,
      maxBudgetUsd: settings.maxBudgetUsd ?? undefined,
      isolated: settings.isolated,
    });
  }
  return {
    name: settings.name,
    adapter,
    limits: { timeoutMs: settings.runTimeoutMinutes * 60 * 1000, runsPerHour: settings.runsPerHour },
    mentionsOnly: settings.mentionsOnly,
    warning: hooksWarning(adapter, settings.isolated, docPath),
  };
}

/** The hooks warning for a Claude Code agent working on `docPath`, or null. */
export function hooksWarning(adapter, isolated, docPath) {
  if (adapter.name !== 'claude' || isolated) return null;
  const hooks = projectHooks(dirname(docPath));
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
