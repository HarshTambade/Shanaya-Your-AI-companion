import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const clientDir = process.cwd();
const modelPath = resolve(clientDir, "public/models/avatar.glb");
const compressedPath = resolve(clientDir, "public/models/avatar.draco.glb");
const decoderSource = resolve(clientDir, "node_modules/three/examples/jsm/libs/draco");
const decoderTarget = resolve(clientDir, "public/draco");

if (!existsSync(modelPath)) throw new Error(`Avatar model not found at ${modelPath}`);
if (!existsSync(decoderSource)) throw new Error("Install client dependencies before copying the Draco decoder.");

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this script through `npm run models:draco` so it can find npm.");
const result = spawnSync(process.execPath, [npmCli, "exec", "--yes", "--package=@gltf-transform/cli", "--", "gltf-transform", "draco", modelPath, compressedPath], {
  cwd: clientDir,
  stdio: "inherit",
});
if (result.status !== 0) throw new Error("glTF Transform failed to compress avatar.glb with Draco.");

mkdirSync(decoderTarget, { recursive: true });
cpSync(decoderSource, decoderTarget, { recursive: true });
console.log(`Created ${compressedPath} and copied the local Draco decoder to ${decoderTarget}.`);
