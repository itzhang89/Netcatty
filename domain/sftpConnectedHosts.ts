import type { Host, TerminalSession } from "./models";

export type SftpConnectedHostEntry = {
  host: Host;
  sessionId: string;
  status: "connected";
};

/** Fields the SFTP Connected picker cares about from a terminal session. */
export type SftpPickerSessionFields = Pick<
  TerminalSession,
  | "id"
  | "hostId"
  | "protocol"
  | "status"
  | "moshEnabled"
  | "etEnabled"
  | "hostname"
  | "username"
  | "port"
>;

/**
 * Sessions that can actually reuse a live terminal SSH connection for SFTP.
 * Connecting sessions and Mosh/ET transports have no reusable ssh2 shell conn.
 */
const isReusableSftpSourceSession = (session: SftpPickerSessionFields): boolean => {
  if (session.status !== "connected") return false;
  if (session.moshEnabled || session.etEnabled) return false;
  const protocol = session.protocol;
  if (protocol === "serial" || protocol === "local" || protocol === "telnet") return false;
  // Missing protocol defaults to SSH (same as host picker filtering).
  return true;
};

/**
 * Overlay the live session endpoint onto the vault host so SFTP connect +
 * sourceSessionId reuse matches findReusableSession's endpoint check.
 * Vault hosts can be edited after the terminal connected; using the edited
 * host would reject reuse and open a fresh connection to a different target.
 */
const hostForLiveSession = (host: Host, session: SftpPickerSessionFields): Host => ({
  ...host,
  hostname: session.hostname,
  username: session.username,
  port: session.port ?? host.port ?? 22,
});

/**
 * Compare only picker-relevant session fields so title/cwd/font churn does not
 * invalidate side-panel memoization.
 */
export const sftpPickerSessionsEqual = (
  prev: ReadonlyArray<SftpPickerSessionFields> | null | undefined,
  next: ReadonlyArray<SftpPickerSessionFields> | null | undefined,
): boolean => {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;

  const nextById = new Map(next.map((session) => [session.id, session]));
  if (nextById.size !== next.length) return false;

  for (const session of prev) {
    const other = nextById.get(session.id);
    if (!other) return false;
    if (
      session.hostId !== other.hostId
      || session.protocol !== other.protocol
      || session.status !== other.status
      || Boolean(session.moshEnabled) !== Boolean(other.moshEnabled)
      || Boolean(session.etEnabled) !== Boolean(other.etEnabled)
      || session.hostname !== other.hostname
      || session.username !== other.username
      || (session.port ?? 22) !== (other.port ?? 22)
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Build the "currently connected" host list for the SFTP host picker.
 * One entry per hostId — keeps the most recently listed reusable session.
 */
export const listSftpConnectedHosts = (
  sessions: ReadonlyArray<SftpPickerSessionFields>,
  hostsById: ReadonlyMap<string, Host>,
): SftpConnectedHostEntry[] => {
  const bestByHostId = new Map<string, SftpConnectedHostEntry>();

  for (const session of sessions) {
    if (!isReusableSftpSourceSession(session)) continue;
    const host = hostsById.get(session.hostId);
    if (!host) continue;
    if (host.protocol === "serial") continue;
    // Use session transport flags only. Vault hosts may still have mosh/et
    // defaults while the live terminal was opened as plain SSH (e.g. ssh://).

    // Later sessions overwrite earlier ones for the same hostId.
    bestByHostId.set(host.id, {
      host: hostForLiveSession(host, session),
      sessionId: session.id,
      status: "connected",
    });
  }

  return [...bestByHostId.values()].sort((a, b) =>
    a.host.label.localeCompare(b.host.label),
  );
};
