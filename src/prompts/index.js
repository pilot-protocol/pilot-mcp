// prompts/index.js — MCP prompts (user-controlled idioms surfaced to the LLM).

import { ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const PROMPTS = [
  {
    name: 'pilot-trust-readout',
    description: 'Read your current trust state at session start — trusted peers, pending inbound handshakes, recent activity. Call this once early in a session so subsequent peer interactions have context.',
    arguments: [],
    render: () => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Read the current Pilot trust state:',
            '',
            '1. Read pilot://trust to see who you have bilateral trust with.',
            '2. Call pilot_pending to see inbound handshake requests waiting on your approval.',
            '3. If any pending requests look legitimate (you can read the justification), ask the user whether to approve before calling pilot_approve.',
            '',
            'Trust requirements you should respect for the rest of this session:',
            '- Backbone catalog specialists (list-agents, bitstamp, noaa, openalex, etc. — short hostnames on Network 0) auto-approve. pilot_search / pilot_help / pilot_query work without explicit handshake.',
            '- Any A2A action against another operator (pilot_send, pilot_send_file, pilot_publish, pilot_subscribe) REQUIRES trust. Call pilot_trust_check(target) before each such action; if state is "untrusted" call pilot_handshake first.',
            '- Trust propagates through the registry with up to ~60s delay. If pilot_trust_check returns "trusted-pending" and pilot_send fails, wait briefly and retry.',
          ].join('\n'),
        },
      },
    ],
  },
  {
    name: 'pilot-3-command-pattern',
    description: 'The canonical search → help → data pattern for querying any directory specialist.',
    arguments: [{ name: 'keyword', description: 'What you are looking for (single literal token, not a phrase).', required: true }],
    render: ({ keyword }) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Query the Pilot directory for "${keyword}" using the 3-command pattern.`,
            '',
            '1. Call pilot_send with target="list-agents" and data=`/data {"search":"' + keyword + '","limit":10}`. Inspect the matches.',
            '2. For the most relevant match, call pilot_send with target="<that-agent>" and data=`/help`. Read the returned schema.',
            '3. Call pilot_send with target="<that-agent>" and data=`/data {<the filters you learned>}`. Cite the specialist hostname in your reply.',
          ].join('\n'),
        },
      },
    ],
  },
  {
    name: 'pilot-a2a-message',
    description: 'Send a plain A2A message to a peer (not a directory specialist).',
    arguments: [
      { name: 'peer', description: 'Peer hostname or pilot address.', required: true },
      { name: 'content', description: 'Message body.', required: true },
    ],
    render: ({ peer, content }) => [
      { role: 'user', content: { type: 'text', text: `First call pilot_trust_check(target="${peer}"). If state is "trusted" or "auto-approve", call pilot_send with peer="${peer}" and message="${content}". If state is "untrusted", call pilot_handshake(target="${peer}") first, wait ~60s for registry propagation, then retry pilot_trust_check and proceed. If state is "one-way", wait — they need to approve you. Then call pilot_inbox to read the reply.` } },
    ],
  },
  {
    name: 'pilot-handshake-first-contact',
    description: 'Establish trust with a peer you have not communicated with before.',
    arguments: [
      { name: 'peer', description: 'Peer hostname or pilot address.', required: true },
      { name: 'reason', description: 'Why you want to talk to them (shown to the recipient on approval).', required: false },
    ],
    render: ({ peer, reason }) => [
      { role: 'user', content: { type: 'text', text: `Initiate a handshake with ${peer}${reason ? ` for the reason: ${reason}` : ''}. Call pilot_handshake. Most specialists auto-approve; for human-operated peers, the request will appear in their pilotctl pending queue until they accept.` } },
    ],
  },
];

export function registerPrompts(server) {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ render, ...meta }) => meta),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = PROMPTS.find((x) => x.name === req.params.name);
    if (!p) throw new Error(`unknown prompt: ${req.params.name}`);
    return { messages: p.render(req.params.arguments ?? {}) };
  });
}
