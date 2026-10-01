// Prints only the frames where the visible state changes. Usage: node frames-diff.mjs <run dir>
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
const run = process.argv[2];
for (const step of readdirSync(run).filter((d) => existsSync(path.join(run, d, "frames.json")))) {
  const frames = JSON.parse(readFileSync(path.join(run, step, "frames.json"), "utf8"));
  console.log(`== ${step}`);
  let prev = "";
  const t0 = frames[0]?.t ?? 0;
  for (const x of frames) {
    const key = [x.path, x.h1, x.mainLen, `skel=${x.skel}`, `snaps=${x.snaps}/${x.snapLen}`, x.mainOp, x.mainTf, x.vt].join(" | ");
    if (key !== prev) console.log(String(x.t - t0).padStart(5), key);
    prev = key;
  }
}
