import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function ensurePrivacyManifest() {
  const sourcePath = resolve(clientRoot, "config/PrivacyInfo.xcprivacy");
  const destinationPath = resolve(clientRoot, "ios/App/App/PrivacyInfo.xcprivacy");
  const projectPath = resolve(clientRoot, "ios/App/App.xcodeproj/project.pbxproj");
  if (!existsSync(sourcePath) || !existsSync(projectPath)) return;

  mkdirSync(resolve(clientRoot, "ios/App/App"), { recursive: true });
  copyFileSync(sourcePath, destinationPath);

  const source = readFileSync(projectPath, "utf8");
  const buildFileId = "A2A6B20A101A4FDCB73B29D1";
  const fileReferenceId = "A2A6B20A101A4FDCB73B29D2";
  const buildFile = `\t\t${buildFileId} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${fileReferenceId} /* PrivacyInfo.xcprivacy */; };`;
  const fileReference = `\t\t${fileReferenceId} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };`;
  let project = source;

  if (!project.includes("PrivacyInfo.xcprivacy in Resources")) {
    project = project.replace("/* End PBXBuildFile section */", `${buildFile}\n/* End PBXBuildFile section */`);
  }
  if (!project.includes("/* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference")) {
    project = project.replace("/* End PBXFileReference section */", `${fileReference}\n/* End PBXFileReference section */`);
  }
  if (!project.includes(`${fileReferenceId} /* PrivacyInfo.xcprivacy */,`)) {
    project = project.replace(
      "\t\t\t\t504EC3131FED79650016851F /* Info.plist */,",
      `\t\t\t\t504EC3131FED79650016851F /* Info.plist */,\n\t\t\t\t${fileReferenceId} /* PrivacyInfo.xcprivacy */,`,
    );
  }
  if (!project.includes(`${buildFileId} /* PrivacyInfo.xcprivacy in Resources */,`)) {
    project = project.replace(
      "\t\t\t\t2FAD9763203C412B000D30F8 /* config.xml in Resources */,",
      `\t\t\t\t2FAD9763203C412B000D30F8 /* config.xml in Resources */,\n\t\t\t\t${buildFileId} /* PrivacyInfo.xcprivacy in Resources */,`,
    );
  }

  if (project !== source) {
    if (!project.includes(`${fileReferenceId} /* PrivacyInfo.xcprivacy */,`)) {
      throw new Error("Could not add PrivacyInfo.xcprivacy to the Xcode project group.");
    }
    if (!project.includes(`${buildFileId} /* PrivacyInfo.xcprivacy in Resources */,`)) {
      throw new Error("Could not add PrivacyInfo.xcprivacy to the Xcode resources phase.");
    }
    writeFileSync(projectPath, project);
    console.log("Added the privacy manifest to the iOS app target.");
  }
}

patchSwiftPackage("node_modules/capacitor-native-agent/Package.swift");
patchPodspec("node_modules/capacitor-native-agent/CapacitorNativeAgent.podspec");
ensureUsageDescriptions();
ensurePrivacyManifest();
