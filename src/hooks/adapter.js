// Compatibility stub for the retired native pre/post tool hooks.
//
// Earlier releases installed `pilot-mcp hook --harness <id> --phase pre|post`
// into harness settings as the boundary for Pilot's hosted control plane. That
// control plane no longer exists and setup now removes those entries, but a
// harness that has not been reconfigured still runs the command on every tool
// call. It must stay what it always was on an unattached node: exit 0, write
// nothing, read nothing, and depend on neither pilotctl nor the network.

export async function runHook() {
  return { blocked: false };
}
