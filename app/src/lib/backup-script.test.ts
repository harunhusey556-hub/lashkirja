import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "scripts/backup-db.sh");

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe("backup-db.sh", () => {
  it("uses a sqlite backup and does not copy the WAL beside the database", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain(".backup");
    expect(source).not.toMatch(/cp\s+.*-wal/);
    expect(source).toContain("LASHKIRJA_BACKUP_REMOTE");
    expect(source).toContain("uploads");
  });

  it("snapshots committed WAL pages, uploads, and an optional remote copy", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lashkirja-backup-"));
    const db = path.join(root, "lashkirja.db");
    const uploads = path.join(root, "uploads");
    const backups = path.join(root, "backups");
    const remote = path.join(root, "remote");
    const ready = path.join(root, "ready");

    const holder = spawn(
      "python3",
      [
        "-c",
        [
          "import sqlite3, time, sys",
          "db, ready = sys.argv[1], sys.argv[2]",
          "con = sqlite3.connect(db)",
          "con.execute('PRAGMA journal_mode=WAL')",
          "con.execute('PRAGMA wal_autocheckpoint=0')",
          "con.execute('CREATE TABLE notes(body TEXT)')",
          "con.execute(\"INSERT INTO notes VALUES ('only-wal')\")",
          "con.commit()",
          "open(ready, 'w').write('ok')",
          "time.sleep(30)",
          "con.close()",
        ].join("\n"),
        db,
        ready,
      ],
      { stdio: "ignore" }
    );

    try {
      const started = Date.now();
      while (!existsSync(ready)) {
        if (Date.now() - started > 5000) throw new Error("SQLite holder did not start");
        sleep(50);
      }

      execFileSync("mkdir", ["-p", uploads]);
      writeFileSync(path.join(uploads, "kuitti.txt"), "kuitti-bytes");

      const naive = path.join(root, "naive.db");
      execFileSync("cp", [db, naive]);
      let naiveSeesRow = true;
      try {
        const naiveOut = execFileSync("sqlite3", [naive, "SELECT body FROM notes;"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        naiveSeesRow = naiveOut.includes("only-wal");
      } catch {
        naiveSeesRow = false;
      }
      expect(naiveSeesRow).toBe(false);

      execFileSync("bash", [script], {
        env: {
          ...process.env,
          LASHKIRJA_DB_PATH: db,
          LASHKIRJA_UPLOADS_DIR: uploads,
          LASHKIRJA_BACKUP_DIR: backups,
          LASHKIRJA_BACKUP_REMOTE: remote,
          LASHKIRJA_BACKUP_KEEP: "3",
        },
      });

      const localDirs = execFileSync("find", [backups, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(localDirs).toHaveLength(1);
      const snapshot = localDirs[0];
      const snapshotDb = path.join(snapshot, "lashkirja.db");
      expect(existsSync(path.join(snapshot, "lashkirja.db-wal"))).toBe(false);
      expect(
        execFileSync("sqlite3", [snapshotDb, "PRAGMA integrity_check;"], { encoding: "utf8" }).trim()
      ).toBe("ok");
      expect(
        execFileSync("sqlite3", [snapshotDb, "SELECT body FROM notes;"], { encoding: "utf8" }).trim()
      ).toBe("only-wal");
      expect(readFileSync(path.join(snapshot, "uploads", "kuitti.txt"), "utf8")).toBe("kuitti-bytes");

      const remoteDb = path.join(remote, path.basename(snapshot), "lashkirja.db");
      expect(sha256(remoteDb)).toBe(sha256(snapshotDb));
      expect(readFileSync(path.join(remote, path.basename(snapshot), "uploads", "kuitti.txt"), "utf8")).toBe(
        "kuitti-bytes"
      );
    } finally {
      holder.kill("SIGTERM");
    }
  });

  it("restores the snapshot database and uploads into a fresh directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lashkirja-restore-"));
    const db = path.join(root, "lashkirja.db");
    const uploads = path.join(root, "uploads");
    const backups = path.join(root, "backups");
    execFileSync("mkdir", ["-p", uploads]);
    execFileSync("sqlite3", [db, "CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES ('säilyy');"]);
    writeFileSync(path.join(uploads, "kuitti.txt"), "kuitti-bytes");

    execFileSync("bash", [script], {
      env: {
        ...process.env,
        LASHKIRJA_DB_PATH: db,
        LASHKIRJA_UPLOADS_DIR: uploads,
        LASHKIRJA_BACKUP_DIR: backups,
        LASHKIRJA_BACKUP_KEEP: "2",
      },
    });
    const snapshot = execFileSync("find", [backups, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], {
      encoding: "utf8",
    }).trim();
    const output = execFileSync("bash", [path.join(process.cwd(), "scripts/restore-drill.sh"), snapshot], {
      encoding: "utf8",
      env: {
        ...process.env,
        LASHKIRJA_RESTORE_SQL: "SELECT body FROM notes;",
        LASHKIRJA_RESTORE_CLEAN: "1",
      },
    });
    expect(output).toContain("integrity=ok");
    expect(output).toContain("row=säilyy");
    expect(output).toContain("Restore drill ok.");
  });
});
