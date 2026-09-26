import { afterAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { hardenLocalDatabasePermissions } from "./db";

const created: string[] = [];

afterAll(() => {
  for (const target of created) fs.rmSync(target, { recursive: true, force: true });
});

describe("hardenLocalDatabasePermissions", () => {
  it("locks down a directory it owns", () => {
    const directory = path.join(os.tmpdir(), `lk-perm-${randomUUID()}`);
    created.push(directory);
    const databasePath = path.join(directory, "app.db");

    hardenLocalDatabasePermissions(`file:${databasePath}`);
    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);

    fs.writeFileSync(databasePath, "");
    fs.chmodSync(databasePath, 0o644);
    hardenLocalDatabasePermissions(`file:${databasePath}`);
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it("does not throw when the directory cannot be chmodded", () => {
    // /tmp is owned by root: the old code threw here and took every
    // database-backed request down with it.
    expect(() =>
      hardenLocalDatabasePermissions(`file:${path.join(os.tmpdir(), `lk-${randomUUID()}.db`)}`)
    ).not.toThrow();
  });

  it("ignores non-file and in-memory URLs", () => {
    expect(() => hardenLocalDatabasePermissions("libsql://example.turso.io")).not.toThrow();
    expect(() => hardenLocalDatabasePermissions("file::memory:")).not.toThrow();
  });
});
