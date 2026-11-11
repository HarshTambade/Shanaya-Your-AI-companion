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

function ensureUsageDescriptions() {
  const filePath = resolve(clientRoot, "ios/App/App/Info.plist");
  if (!existsSync(filePath)) return;

  let source = readFileSync(filePath, "utf8");
  const additions = [];
  if (!source.includes("<key>NSMicrophoneUsageDescription</key>")) {
    additions.push("    <key>NSMicrophoneUsageDescription</key>\n    <string>Shanaya uses the microphone so you can speak with your companion.</string>");
  }
  if (!source.includes("<key>NSSpeechRecognitionUsageDescription</key>")) {
    additions.push("    <key>NSSpeechRecognitionUsageDescription</key>\n    <string>Shanaya uses speech recognition to turn your voice into a message.</string>");
  }
  if (!additions.length) return;
  const rootDictionaryEnd = source.lastIndexOf("</dict>");
  if (rootDictionaryEnd < 0) throw new Error("Could not find the Info.plist dictionary end tag.");
  source = `${source.slice(0, rootDictionaryEnd)}${additions.join("\n")}\n${source.slice(rootDictionaryEnd)}`;
  writeFileSync(filePath, source);
  console.log("Added microphone and speech recognition usage descriptions to iOS Info.plist.");
}

patchSwiftPackage("node_modules/capacitor-native-agent/Package.swift");
patchPodspec("node_modules/capacitor-native-agent/CapacitorNativeAgent.podspec");
ensureUsageDescriptions();
