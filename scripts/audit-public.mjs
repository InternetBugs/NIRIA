import { execFileSync } from "node:child_process";

// Inspect the index, not the ignored local development/test state. Do not print
// matching content: a finding might itself be a secret.
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
const paths = git("ls-files", "-z").split("\0").filter(Boolean);
if (!paths.length) throw new Error("No staged source files to audit");
const forbidden = /^(?:artifacts|release|node_modules|\.niria|\.npm-cache|prototype\/public\/vendor\/live2d)\//;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/,
  /\bAKIA[0-9A-Z]{16}\b/
];
const failures = [];
for (const path of paths) {
  if (forbidden.test(path) || /(?:^|\/)\.env(?:\.|$)/.test(path) ||
      /\.(?:sqlite(?:-.*)?|db(?:-.*)?|pem|pfx|p12|key|niria|exe|zip)$/i.test(path))
    failures.push({ path, reason: "excluded/private/generated path" });
  const text = git("show", `:${path}`);
  for (let index = 0; index < secretPatterns.length; index++)
    if (secretPatterns[index].test(text)) failures.push({ path, reason: `credential signature ${index + 1}` });
}
const modes = git("ls-files", "--stage").split("\n").filter(Boolean);
if (modes.some(line => !line.startsWith("100644 ") && !line.startsWith("100755 ")))
  failures.push({ reason: "unexpected symlink or submodule" });
console.log(JSON.stringify({ passed: !failures.length, indexedFiles: paths.length, findings: failures }, null, 2));
if (failures.length) process.exitCode = 1;
