import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { releaseDaemonLock, type LockPaths } from "../../src/daemon/instanceLock.js";

function listenUnixSocket(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

describe("releaseDaemonLock", () => {
  let dir: string;
  const servers: net.Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("only unlinks the lock file when it still belongs to this process", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    const lockPath = path.join(dir, "prismd.lock");
    const socketPath = path.join(dir, "prismd.sock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() }));

    const paths: LockPaths = { lockPath, socketPath };
    releaseDaemonLock(paths, 0);

    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("unlinks the socket only when its current inode matches ownInode", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    const lockPath = path.join(dir, "prismd.lock");
    const socketPath = path.join(dir, "prismd.sock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    const server = await listenUnixSocket(socketPath);
    servers.push(server);
    const realInode = fs.lstatSync(socketPath).ino;

    releaseDaemonLock({ lockPath, socketPath }, realInode + 1);
    expect(fs.existsSync(socketPath)).toBe(true);

    releaseDaemonLock({ lockPath: path.join(dir, "already-gone.lock"), socketPath }, realInode);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("refuses to unlink a socket path that is not actually a socket, even if it somehow shares an inode number", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-"));
    const lockPath = path.join(dir, "prismd.lock");
    const socketPath = path.join(dir, "prismd.sock");
    fs.writeFileSync(socketPath, "not a socket");
    const fakeInode = fs.lstatSync(socketPath).ino;

    releaseDaemonLock({ lockPath, socketPath }, fakeInode);

    expect(fs.existsSync(socketPath)).toBe(true);
  });
});
