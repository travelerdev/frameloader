import { test } from "node:test";
import assert from "node:assert/strict";
import mdns from "multicast-dns";
import { browse, resolveHost, DEVKIT_SERVICE } from "../src/main/discovery";

// A fake Steam Frame answering on the local multicast group. Skips (not fails)
// when multicast isn't available on this machine.
function fakeFrame(name: string, host: string, address: string) {
  const m = mdns();
  m.on("error", () => undefined);
  m.on("query", (q) => {
    const wantsPtr = q.questions.some((x) => x.type === "PTR" && x.name.toLowerCase() === DEVKIT_SERVICE);
    const wantsA = q.questions.some((x) => x.type === "A" && x.name.toLowerCase() === host);
    if (!wantsPtr && !wantsA) return;
    const instance = `${name}.${DEVKIT_SERVICE}`;
    m.respond({
      answers: wantsPtr ? [{ name: DEVKIT_SERVICE, type: "PTR", ttl: 120, data: instance }] : [],
      additionals: [
        { name: instance, type: "SRV", ttl: 120, data: { target: host, port: 32000, priority: 0, weight: 0 } },
        { name: instance, type: "TXT", ttl: 120, data: [Buffer.from("login=steamos")] },
        { name: host, type: "A", ttl: 120, data: address },
      ],
    });
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
