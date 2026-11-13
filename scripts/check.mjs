import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
let count = 0;
async function check(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", windowsHide: true });
      if (result.status !== 0) { process.stderr.write(result.stderr || String(result.error)); process.exit(1); }
      count++;
    }
  }
}
for (const folder of ["core", "desktop", "prototype", "scripts", "tests"]) await check(join(root, folder));
console.log(`已检查 ${count} 个 JavaScript 文件。`);
