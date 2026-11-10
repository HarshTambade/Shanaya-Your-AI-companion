import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const clientRoot = resolve(import.meta.dirname, "..");

function patchSwiftPackage(relativePath) {
  const filePath = resolve(clientRoot, relativePath);
  if (!existsSync(filePath)) return;

  const source = readFileSync(filePath, "utf8");
  if (source.includes(".linkedLibrary(\"z\")")) return;
  const patched = source.replace(
    "linkerSettings: [\n                .linkedLibrary(\"iconv\"),",
    "linkerSettings: [\n                .linkedLibrary(\"iconv\"),\n                .linkedLibrary(\"z\"),",
  );
  if (patched === source) throw new Error(`Could not find linker settings in ${relativePath}.`);
  writeFileSync(filePath, patched);
  console.log(`Patched iOS zlib linker setting: ${relativePath}`);
}

function patchPodspec(relativePath) {
  const filePath = resolve(clientRoot, relativePath);
  if (!existsSync(filePath)) return;

  const source = readFileSync(filePath, "utf8");
  if (source.includes("s.libraries = 'iconv', 'z'")) return;
  const patched = source.replace("s.libraries = 'iconv'", "s.libraries = 'iconv', 'z'");
  if (patched === source) throw new Error(`Could not find library settings in ${relativePath}.`);
  writeFileSync(filePath, patched);
  console.log(`Patched iOS zlib library setting: ${relativePath}`);
}

patchSwiftPackage("node_modules/capacitor-native-agent/Package.swift");
patchPodspec("node_modules/capacitor-native-agent/CapacitorNativeAgent.podspec");
