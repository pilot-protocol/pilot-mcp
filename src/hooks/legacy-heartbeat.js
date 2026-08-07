// Claude Code treats exit 0 with no stdout as "allow" for UserPromptSubmit.
// Do not print JSON or context here: this command exists only to make the
// obsolete <=0.2.5 hook harmless until setup removes it from settings.json.
export async function runLegacyHeartbeat(args) {
  if (args.length !== 1 || args[0] !== '--claude') {
    throw new Error('heartbeat is a legacy compatibility command; only --claude is supported');
  }
}
