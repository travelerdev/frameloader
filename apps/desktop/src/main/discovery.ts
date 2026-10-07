// Finding the headset on the LAN the way Valve's client does: the devkit
// service advertises _steamos-devkit._tcp over mDNS. We also resolve
// "<name>.local" ourselves, because the OS resolver's mDNS support is the
// part that most often fails (VPNs, Windows, client isolation…).
import mdns from "multicast-dns";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import type { DiscoveredFrame } from "../shared/ipc";
import { activity } from "./activity";

export const DEVKIT_SERVICE = "_steamos-devkit._tcp.local";

type Mdns = ReturnType<typeof mdns>;
type Record_ = { name: string; type: string; data: unknown };

function norm(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

function label(host: string): string {
  return norm(host).replace(/\.local$/, "");
}

function parseTxt(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    const s = Buffer.isBuffer(item) ? item.toString("utf8") : String(item ?? "");
    const i = s.indexOf("=");
    if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

function open(): Mdns | undefined {
  try {
    const m = mdns();
    m.on("error", () => undefined);
    return m;
  } catch {
    return undefined;
  }
}

// Addresses seen for .local hosts, across scans. Responders won't repeat a record they
// multicast within the last second, so a scan can see a name without its address.
const seenAddresses = new Map<string, { address: string; at: number }>();
const SEEN_TTL_MS = 10 * 60 * 1000;

function remember(host: string, address: string): void {
  if (isIP(address) === 4) seenAddresses.set(host, { address, at: Date.now() });
}

function recalled(host: string): string | undefined {
  const hit = seenAddresses.get(host);
  return hit && Date.now() - hit.at < SEEN_TTL_MS ? hit.address : undefined;
}

function records(r: { answers?: Record_[]; additionals?: Record_[] }): Record_[] {
  return [...(r.answers ?? []), ...(r.additionals ?? [])];
}

/** "<label>.local" when a service instance name is also a valid hostname (SteamOS uses the hostname). */
function hostGuess(instanceName: string): string | undefined {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(instanceName) ? `${instanceName.toLowerCase()}.local` : undefined;
}

/** Browse for headsets advertising the devkit service. Resolves after timeoutMs with whatever answered. */
export function browse(timeoutMs = 3000): Promise<DiscoveredFrame[]> {
  return new Promise((resolve) => {
    const m = open();
    if (!m) return resolve([]);
    interface Inst {
      name: string;
      host?: string;
      port?: number;
      txt: Record<string, string>;
    }
    const instances = new Map<string, Inst>();
    const addresses = new Map<string, Set<string>>();
    const asked = new Set<string>();
    const askA = (host: string) => {
      if (addresses.has(host) || asked.has(host)) return;
      asked.add(host);
      m.query({ questions: [{ name: host, type: "A" }] });
    };
    const inst = (full: string): Inst => {
      const key = norm(full);
      let i = instances.get(key);
      if (!i) {
        i = { name: key.replace("." + DEVKIT_SERVICE, ""), txt: {} };
        instances.set(key, i);
        // SteamOS's responder answers the PTR browse with just the PTR (plus an A record),
        // not the SRV/TXT it points to, so ask for them. Also ask for <name>.local, which
        // is what SteamOS uses as the target, in case the SRV answer never comes.
        m.query({ questions: [{ name: key, type: "SRV" }, { name: key, type: "TXT" }] });
        const guess = hostGuess(i.name);
        if (guess) askA(guess);
      }
      return i;
    };
    m.on("response", (r) => {
      for (const rec of records(r as { answers?: Record_[]; additionals?: Record_[] })) {
        const name = norm(rec.name);
        if (rec.type === "PTR" && name === DEVKIT_SERVICE) inst(String(rec.data));
        else if (rec.type === "SRV" && name.endsWith("." + DEVKIT_SERVICE)) {
          const d = rec.data as { target: string; port: number };
          const i = inst(name);
          i.host = norm(d.target);
          i.port = d.port;
          askA(i.host);
        } else if (rec.type === "TXT" && name.endsWith("." + DEVKIT_SERVICE)) Object.assign(inst(name).txt, parseTxt(rec.data));
        else if (rec.type === "A") {
          if (!addresses.has(name)) addresses.set(name, new Set());
          addresses.get(name)!.add(String(rec.data));
          remember(name, String(rec.data));
        }
      }
    });
    // Ask a few times: an idle headset's Wi-Fi drops or delays packets, and responders
    // skip records they multicast in the last second. Each round also re-asks for any
    // instance still missing its SRV or address.
    const round = () => {
      m.query({ questions: [{ name: DEVKIT_SERVICE, type: "PTR" }] });
      for (const [key, i] of instances) {
        if (!i.host) m.query({ questions: [{ name: key, type: "SRV" }, { name: key, type: "TXT" }] });
        const host = i.host ?? hostGuess(i.name);
        if (host && !addresses.get(host)?.size) m.query({ questions: [{ name: host, type: "A" }] });
      }
    };
    round();
    const rounds = [0.3, 0.6].map((f) => setTimeout(round, Math.round(timeoutMs * f)));
    setTimeout(() => {
      rounds.forEach(clearTimeout);
      m.destroy();
      const out: DiscoveredFrame[] = [];
      for (const i of instances.values()) {
        const host = i.host ?? hostGuess(i.name);
        if (!host) continue;
        const addrs = [...(addresses.get(host) ?? [])].filter((a) => isIP(a) === 4);
        if (!addrs.length) {
          const prior = recalled(host);
          if (prior) addrs.push(prior);
        }
        out.push({ name: i.name, host, address: addrs[0] ?? "", port: i.port ?? 32000, login: i.txt.login, addresses: addrs });
      }
      resolve(out.sort((a, b) => a.name.localeCompare(b.name)));
    }, timeoutMs);
  });
}

/** Resolve "<name>.local" (or a bare name) to an IPv4 address with our own mDNS query. */
export function resolveMdns(host: string, timeoutMs = 3000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const m = open();
    if (!m) return resolve(undefined);
    const want = label(host) + ".local";
    let done = false;
    const finish = (addr?: string) => {
      if (done) return;
      done = true;
      retries.forEach(clearTimeout);
      clearTimeout(timer);
      m.destroy();
      resolve(addr);
    };
    m.on("response", (r) => {
      for (const rec of records(r as { answers?: Record_[]; additionals?: Record_[] })) {
        if (rec.type === "A" && isIP(String(rec.data)) === 4) remember(norm(rec.name), String(rec.data));
        if (rec.type === "A" && norm(rec.name) === want && isIP(String(rec.data)) === 4) return finish(String(rec.data));
      }
    });
    const ask = () => m.query({ questions: [{ name: want, type: "A" }] });
    // Responders drop repeats of a record they multicast within the last second,
    // and an idle headset's Wi-Fi adds latency, so ask a few times.
    ask();
    const retries = [700, 1600].map((ms) => setTimeout(ask, ms));
    const timer = setTimeout(() => finish(recalled(want)), timeoutMs);
  });
}

function lookupWithTimeout(host: string, timeoutMs: number): Promise<string | undefined> {
  return Promise.race([
    dns.lookup(host, { family: 4 }).then((r) => r.address, () => undefined),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs)),
  ]);
}

export interface Resolved {
  address: string;
  via: "literal" | "mdns" | "dns" | "browse" | "remembered";
}

/**
 * Turn whatever the user typed into an address we can connect to.
 * Order: IP literal → our own mDNS A query (for .local / bare names) → OS resolver
 * → browsing for a devkit service whose host matches → a remembered address.
 */
export async function resolveHost(host: string, remembered?: string): Promise<Resolved> {
  const h = host.trim().replace(/\.$/, "");
  if (isIP(h)) return { address: h, via: "literal" };
  const local = /\.local$/i.test(h) || !h.includes(".");
  if (local) {
    const a = await resolveMdns(h);
    if (a) {
      activity.info(`${h} → ${a} (mDNS)`);
      return { address: a, via: "mdns" };
    }
  }
  const b = await lookupWithTimeout(h, local ? 2500 : 5000);
  if (b) {
    activity.info(`${h} → ${b} (DNS)`);
    return { address: b, via: "dns" };
  }
  if (local) {
    const found = await browse(2500);
    const match = found.find((f) => f.address && (label(f.host) === label(h) || f.name.toLowerCase() === label(h)));
    if (match) {
      activity.info(`${h} → ${match.address} (devkit service "${match.name}")`);
      return { address: match.address, via: "browse" };
    }
    if (found.length) activity.info(`No headset named "${label(h)}", but found: ${found.map((f) => `${f.name} (${f.address || "no address"})`).join(", ")}`);
  }
  if (remembered && isIP(remembered)) {
    activity.info(`${h} didn't resolve; trying the last known address ${remembered}`);
    return { address: remembered, via: "remembered" };
  }
  throw new Error("HOST_NOT_FOUND");
}
