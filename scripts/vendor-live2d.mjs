import { build } from "esbuild";
import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// No downloads or install scripts. Input must be the official, extracted SDK.
const root = fileURLToPath(new URL("../", import.meta.url));
const sdk = resolve(process.argv[2] || join(root, "artifacts/cubism-sdk-5-r5/CubismSdkForWeb-5-r.5"));
const output = join(root, "prototype/public/vendor/live2d");
await mkdir(output, { recursive: true });
const entries = {
  "live2dcubismframework": ["CubismFramework", "Option", "LogLevel"],
  "cubismmodelsettingjson": ["CubismModelSettingJson"],
  "model/cubismusermodel": ["CubismUserModel"],
  "math/cubismmatrix44": ["CubismMatrix44"],
  "effect/cubismeyeblink": ["CubismEyeBlink"],
  "effect/cubismbreath": ["CubismBreath", "BreathParameterData"],
  "motion/cubismmotion": ["CubismMotion"],
  "motion/cubismexpressionmotion": ["CubismExpressionMotion"],
  "rendering/cubismshader_webgl": ["CubismShaderManager_WebGL"]
};
await build({
  stdin: {
    contents: Object.entries(entries).map(([path, names]) => `export { ${names.join(", ")} } from "./${path}";`).join("\n"),
    resolveDir: join(sdk, "Framework/src"), loader: "ts"
  },
  outfile: join(output, "cubism-framework.js"), bundle: true, format: "esm",
  platform: "browser", target: "es2022", legalComments: "inline",
  banner: { js: "/* Copyright(c) Live2D Inc. All rights reserved.\n * Compiled from Cubism SDK for Web 5 R5. See framework-LICENSE.md.\n */" }
});
await copyFile(join(sdk, "Core/live2dcubismcore.min.js"), join(output, "live2dcubismcore.min.js"));
await copyFile(join(root, "docs/live2d-license-notice.md"), join(output, "NOTICE.md"));
for (const [source, name] of [["LICENSE.md", "sdk-LICENSE.md"], ["Core/LICENSE.md", "core-LICENSE.md"], ["Framework/LICENSE.md", "framework-LICENSE.md"]])
  await copyFile(join(sdk, source), join(output, name));
const shaderRoot = join(sdk, "Framework/Shaders");
async function shaders(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const source = join(folder, entry.name);
    if (entry.isDirectory()) await shaders(source);
    else {
      const destination = join(output, "shaders", relative(shaderRoot, source));
      await mkdir(resolve(destination, ".."), { recursive: true });
      await copyFile(source, destination);
    }
  }
}
await shaders(shaderRoot);
const files = {};
async function inventory(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else if (entry.name !== "manifest.json") {
      const bytes = await readFile(path);
      files[relative(output, path).replaceAll("\\", "/")] = {
        bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")
      };
    }
  }
}
await inventory(output);
const manifest = {
  sdk: "Cubism SDK for Web 5 R5", framework: "5-r.5",
  sdkArchive: "https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip",
  sdkArchiveSha256: "67064a7fb1812cf502f5c4a03bfe12cc638c75a621bb4acf06bb28763df06ba0",
  compiler: "esbuild 0.28.2", files
};
await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ sdk: manifest.sdk, files: Object.keys(files).length, output }));
