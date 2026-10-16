import { hostname, platform, arch, release } from 'node:os';

/** Device details only cross the existing authenticated Host RPC boundary. */
export function createHostRoutes({ hostCompatibility, computer = { hostname, platform, arch, release } }) {
  return async endpoint => {
    const compatibility = hostCompatibility.inspect();
    if (endpoint === 'host/compatibility') return { ok: true, value: compatibility };
    return { ok: true, value: {
      name: computer.hostname(), platform: computer.platform(), arch: computer.arch(), systemVersion: computer.release(),
      localSessions: compatibility.features?.['agent-presets']?.available === true,
      cloudDelegation: false,
    } };
  };
}
