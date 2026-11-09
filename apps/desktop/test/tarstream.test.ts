import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Server, utils } from "ssh2";
import { collectTarEntries, tarChunks } from "../src/main/tarStream";
import { SshSession } from "../src/main/ssh";

const LONG = "a-rather-long-directory-name-that-keeps-going/" + "and-another-long-segment-to-pass-the-ustar-limit/" + "file-with-a-long-name.txt";

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "fl-tar-src-"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "data", "empty"), { recursive: true });
  mkdirSync(join(root, posix.dirname(LONG)), { recursive: true });
  writeFileSync(join(root, "bin", "game"), "#!/bin/sh\necho hi\n");
  writeFileSync(join(root, "empty.txt"), "");
  for (const n of [1, 511, 512, 513, 300 * 1024 + 7]) writeFileSync(join(root, "data", `f${n}`), Buffer.alloc(n, n % 251));
  writeFileSync(join(root, LONG), "long path");
  writeFileSync(join(root, "data", "Ünïcødé ✓.txt"), "unicode");
  for (let i = 0; i < 200; i++) writeFileSync(join(root, "data", `small-${i}.json`), JSON.stringify({ i }));
  symlinkSync("bin/game", join(root, "link"));
  return root;
}

/** relative path → contents (files) or null (dirs), skipping links. */
function snapshot(root: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // macOS may hand back either Unicode normalization; compare names as NFC.
      const r = (rel ? `${rel}/${e.name}` : e.name).normalize("NFC");
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        out.set(r, null);
        walk(join(dir, e.name), r);
      } else out.set(r, createHash("sha256").update(readFileSync(join(dir, e.name))).digest("hex"));
    }
  };
  walk(root, "");
  return out;
}

test("tarChunks produces an archive system tar extracts exactly", async () => {
  const src = makeTree();
  const work = mkdtempSync(join(tmpdir(), "fl-tar-out-"));
  try {
    const entries = collectTarEntries(src);
    assert.ok(!entries.some((e) => e.rel === "link"), "symlinks are skipped");
    let reported = 0;
    const archive = join(work, "out.tar");
    const ws = createWriteStream(archive);
    for await (const c of tarChunks(entries, { fileMode: 0o755, onFileBytes: (n) => (reported += n) })) ws.write(c);
    ws.end();
    await once(ws, "close");
    assert.equal(reported, entries.reduce((a, e) => a + e.size, 0));
    assert.equal(statSync(archive).size % 512, 0);

    const dest = join(work, "x");
    mkdirSync(dest);
    execFileSync("tar", ["-x", "-f", archive, "-C", dest]);
    assert.deepEqual(snapshot(dest), snapshot(src));
    assert.ok(statSync(join(dest, "bin", "game")).mode & 0o100, "files are executable");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

/** A local SSH server whose exec runs commands with sh, for exercising SshSession end to end. */
async function localSshServer(): Promise<{ port: number; close: () => void }> {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const ch = acceptExec();
          const child = spawn("sh", ["-c", info.command], { stdio: ["pipe", "pipe", "pipe"] });
          ch.pipe(child.stdin);
          child.stdin.on("error", () => {});
          child.stdout.pipe(ch, { end: false });
          child.stderr.pipe(ch.stderr, { end: false });
          child.on("close", (code) => {
            ch.exit(code ?? 1);
            ch.end();
          });
        });
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as { port: number }).port, close: () => server.close() };
}

test("putDir streams a tree over SSH into tar -x", async () => {
  const src = makeTree();
  const work = mkdtempSync(join(tmpdir(), "fl-tar-ssh-"));
  const srv = await localSshServer();
  const ssh = await SshSession.connect({ host: "127.0.0.1", port: srv.port, username: "t", password: "x", verifyHost: () => true });
  try {
    const dest = join(work, "game dir");
    const seen: number[] = [];
    await ssh.putDir(src, dest, { onProgress: (sent, total) => seen.push(sent / total) });
    assert.deepEqual(snapshot(dest), snapshot(src));
    assert.equal(seen.at(-1), 1);

    // A failure on the far side is reported, not swallowed.
    const locked = join(work, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    await assert.rejects(ssh.putDir(src, join(locked, "inner")), /upload failed/);
  } finally {
    ssh.close();
    srv.close();
    rmSync(src, { recursive: true, force: true });
    chmodSync(join(work, "locked"), 0o700);
    rmSync(work, { recursive: true, force: true });
  }
});
