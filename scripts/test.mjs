import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tests = (await readdir(new URL("../tests/", import.meta.url)))
  .filter((name) => name.endsWith(".test.mjs")).sort().map((name) => `tests/${name}`);
if (!tests.length) throw new Error("未找到仓库 tests/ 下的测试，已停止执行。");
// Keep ignored artifacts and old-source fixtures outside default discovery.
const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...tests], {
  cwd: root, stdio: "inherit", windowsHide: true
});
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
