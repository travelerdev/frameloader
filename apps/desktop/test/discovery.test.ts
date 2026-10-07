import { test } from "node:test";
import assert from "node:assert/strict";
import mdns from "multicast-dns";
import { browse, resolveHost, DEVKIT_SERVICE } from "../src/main/discovery";

// A fake Steam Frame answering on the local multicast group the way SteamOS does:
// the PTR browse gets only the PTR and an A record; SRV and TXT are answered only
// when asked for. Skips (not fails) when multicast isn't available on this machine.
function fakeFrame(name: string, host: string, address: string) {
  const m = mdns();
  m.on("error", () => undefined);
  const instance = `${name}.${DEVKIT_SERVICE}`;
  m.on("query", (q) => {
    const answers: { name: string; type: string; ttl: number; data: unknown }[] = [];
    for (const x of q.questions) {
      const qname = x.name.toLowerCase();
      if (x.type === "PTR" && qname === DEVKIT_SERVICE) {
        answers.push({ name: DEVKIT_SERVICE, type: "PTR", ttl: 120, data: instance });
        answers.push({ name: host, type: "A", ttl: 120, data: address });
      } else if (x.type === "SRV" && qname === instance) {
        answers.push({ name: instance, type: "SRV", ttl: 120, data: { target: host, port: 32000, priority: 0, weight: 0 } });
      } else if (x.type === "TXT" && qname === instance) {
        answers.push({ name: instance, type: "TXT", ttl: 120, data: [Buffer.from("login=steamos")] });
      } else if (x.type === "A" && qname === host) {
        answers.push({ name: host, type: "A", ttl: 120, data: address });
      }
    }
    if (answers.length) m.respond({ answers } as never);
  });
  return () => m.destroy();
}

test("browses for the devkit service and resolves .local names", async (t) => {
  const stop = fakeFrame("testframe", "testframe.local", "10.9.8.7");
  try {
    const found = await browse(1500);
    const mine = found.find((f) => f.name === "testframe");
    if (!mine) {
      t.skip("no multicast on this machine");
      return;
    }
    assert.equal(mine.host, "testframe.local");
    assert.equal(mine.address, "10.9.8.7");
    assert.equal(mine.login, "steamos");
    assert.equal(mine.port, 32000);
    const r = await resolveHost("testframe.local");
    assert.equal(r.address, "10.9.8.7");
    assert.equal(r.via, "mdns");
    const bare = await resolveHost("TestFrame");
    assert.equal(bare.address, "10.9.8.7");
  } finally {
    stop();
  }
});

test("passes IP literals through and falls back to a remembered address", async () => {
  assert.deepEqual(await resolveHost("192.168.1.5"), { address: "192.168.1.5", via: "literal" });
  const r = await resolveHost("definitely-not-a-frame-zz.local", "192.168.1.9");
  assert.equal(r.via, "remembered");
  await assert.rejects(resolveHost("definitely-not-a-frame-zz.local"), /HOST_NOT_FOUND/);
});
