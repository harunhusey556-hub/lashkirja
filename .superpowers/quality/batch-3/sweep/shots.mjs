import { createRequire } from "node:module";
const require = createRequire("C:/Users/Hhusey/lashkirja/app/package.json");
const { webkit, devices } = require("playwright");
const b = await webkit.launch();
const c = await b.newContext({ ...devices["iPhone 13"] });
const p = await c.newPage();
for (const [name, path] of [["tint-preview","/zz-tint-preview"],["unohtunut-salasana","/unohtunut-salasana"]]) {
  await p.goto("http://127.0.0.1:3200"+path, { waitUntil: "networkidle", timeout: 90000 });
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${process.argv[2]}/${name}.png` });
}
await b.close();
