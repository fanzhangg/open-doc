// What an agent says, in its own words on a comment card, when it could not
// answer: a short apology that names what went wrong, made from the error its
// run or program check reported (src/server/agents). The error itself stays
// a hover away.

const PROGRAMS = { claude: 'Claude Code', codex: 'Codex' };

/**
 * @param {string} error the run's or the program check's error
 * @param {string | null} kind the program the agent runs on: 'claude', 'codex' or 'custom'
 */
export function apology(error, kind = null) {
  const text = (error ?? '').trim();
  const e = text.toLowerCase();
  const program = PROGRAMS[kind] ?? 'my program';
  if (/not signed in/.test(e)) return `Sorry, I'm not signed in to ${program}.`;
  if (/anthropic_api_key/.test(e)) return 'Sorry, isolated runs need an ANTHROPIC_API_KEY.';
  if (/no command is set/.test(e)) return 'Sorry, no command is set for me.';
  if (/was not found|enoent|could not run|could not start the agent/.test(e)) return `Sorry, I can't find ${program}.`;
  const minutes = e.match(/timed out after (\d+) min/);
  if (minutes) return `Sorry, I timed out after ${minutes[1]} min.`;
  if (/finished without replying/.test(e)) return 'Sorry, I finished without replying.';
  if (/max_turns|max turns/.test(e)) return 'Sorry, I ran out of turns.';
  if (/budget/.test(e)) return 'Sorry, I went over my budget.';
  if (/usage limit|rate limit|credit balance|quota/.test(e)) return 'Sorry, I hit my usage limit.';
  if (/not supported by this version/.test(e)) return "Sorry, this version of OpenDoc can't run me.";
  const exit = e.match(/exited with code (-?\d+)/);
  if (exit) return `Sorry, ${program} crashed (exit code ${exit[1]}).`;
  return text ? `Sorry, my run failed: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}` : 'Sorry, my run failed.';
}
