// workspace.egress.denied plumbing (T08 stub — 27 §12, _DECISIONS §13).
// Parses squid access-log lines; T37 wires denials to the event pipeline
// (policy-flag input for injection detection, 34-THREAT-MODEL.md).

export interface EgressLogEntry {
  timestampMs: number;
  clientIp: string;
  denied: boolean;
  method: string;
  /** Hostname only — port and scheme stripped. */
  destination: string;
}

// Squid native format:
// "1691700000.123    10 172.30.0.5 TCP_DENIED/403 3928 CONNECT example.com:443 - HIER_NONE/- text/html"
const LINE = /^(\d+)\.(\d{3})\s+\d+\s+(\S+)\s+(\S+)\/\d+\s+\d+\s+(\S+)\s+(\S+)/;

function hostOf(target: string): string {
  if (target.includes("://")) {
    try {
      return new URL(target).hostname;
    } catch {
      return target;
    }
  }
  const withoutPort = target.replace(/:\d+$/, "");
  return withoutPort;
}

/** Returns null for lines that are not access-log entries. */
export function parseSquidAccessLine(line: string): EgressLogEntry | null {
  const match = LINE.exec(line.trim());
  if (!match) return null;
  const [, seconds, millis, clientIp, resultCode, method, target] = match;
  return {
    timestampMs: Number(seconds) * 1000 + Number(millis),
    clientIp: clientIp!,
    denied: resultCode!.startsWith("TCP_DENIED"),
    method: method!,
    destination: hostOf(target!),
  };
}
