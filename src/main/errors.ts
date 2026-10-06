// Turn transport-level failures into sentences that say what to do next.
export function friendlyError(err: unknown, host: string): string {
  const m = err instanceof Error ? err.message : String(err);
  if (m === "CANCELLED") return "Cancelled.";
  if (m === "AUTH_FAILED") return "The headset rejected the login. The password is the one set under Settings → Developer → Set User Password.";
  if (m === "HOST_NOT_FOUND") return `Couldn't find ${host} on this network, by name or by browsing for headsets. Is Developer Mode on and the Frame awake on the same Wi-Fi? Otherwise use the IP address from Quick Settings.`;
  if (m === "CONNECTION_REFUSED") return `${host} refused the connection. Is Developer Mode on (Steam Settings → System)?`;
  if (m === "HOST_UNREACHABLE") return `Couldn't reach ${host}. The Frame leaves the network when it sleeps; wake it and try again.`;
  if (m === "HOST_KEY_REJECTED") return `${host}'s SSH identity changed since you last connected. If this is expected (re-imaged headset), remove the device and add it again.`;
  if (m === "PAIRING_MODE_TIMEOUT") return "The headset didn't answer. Make sure Steam is on Settings → Developer → Pair new host, then try again.";
  if (m.startsWith("PAIRING_REFUSED:")) return `The headset refused the pairing: ${m.slice("PAIRING_REFUSED:".length)}`;
  if (m.startsWith("DEVKIT_UNREACHABLE:")) return `Couldn't reach the pairing service on ${host} (port 32000). Developer Mode must be on, and the Frame must be awake and on this network.`;
  if (m === "NEEDS_PASSWORD") return "Key login didn't work. Pair again or enter the Developer Mode password.";
  if (/Steam client is not running/i.test(m)) return "Steam isn't running on the headset. Wake it or put it on, then try again.";
  if (/timeout - Steam client did not respond/i.test(m)) return "Steam on the headset didn't answer the registration in time. Make sure it's awake and try again.";
  return m;
}
