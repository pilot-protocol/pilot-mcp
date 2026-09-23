// setup/transport.js — probe whether UDP to the beacon is reachable.
//
// If UDP is blocked (corporate firewall, restrictive NAT, proxy-only agent
// sandboxes), we fall back to compat mode (WSS over TCP/443). Today this
// fallback is manual: the user has to discover UDP is blocked themselves and
// restart the daemon with `-transport=compat`. We do it automatically.
//
// The probe is the same cold-start exchange pilot-daemon uses for its own
// UDP reachability check: a beacon Discover for node 0,
//   tx: [0x01 BeaconMsgDiscover][nodeID(4)=0]
//   rx: [0x02 BeaconMsgDiscoverReply][iplen][ip][port]
// UDP counts as reachable only on positive evidence (a reply). The beacon
// silently drops any other payload, so an arbitrary probe string would make
// every network look UDP-blocked.
//
// PILOT_TRANSPORT=udp|compat skips the probe, matching the daemon's override.

import { createSocket } from 'node:dgram';
import process from 'node:process';

const BEACON_MSG_DISCOVER = 0x01;
const BEACON_MSG_DISCOVER_REPLY = 0x02;

export async function probeTransport(beacon = '34.71.57.205', port = 9001, { env = process.env, timeoutMs = 1500 } = {}) {
  const forced = String(env.PILOT_TRANSPORT ?? '').trim().toLowerCase();
  if (forced === 'udp' || forced === 'compat') return forced;
  return new Promise((resolve) => {
    let settled = false;
    const sock = createSocket('udp4');
    const finish = (mode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // Already closed after a socket error.
      }
      resolve(mode);
    };
    const timer = setTimeout(() => finish('compat'), timeoutMs);
    sock.on('message', (message) => {
      if (message.length >= 4 && message[0] === BEACON_MSG_DISCOVER_REPLY) finish('udp');
    });
    sock.on('error', () => finish('compat'));
    sock.send(Buffer.from([BEACON_MSG_DISCOVER, 0, 0, 0, 0]), port, beacon, (err) => {
      if (err) finish('compat');
    });
  });
}
