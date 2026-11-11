import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const kotlinBuildscript = `buildscript {
    ext.kotlin_version = project.hasProperty("kotlin_version") ? rootProject.ext.kotlin_version : "2.2.20"
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlin_version"
    }
}

`;

const moduleGradleFiles = [
  "node_modules/@pinecall/ionic/android/build.gradle",
  "node_modules/capacitor-lancedb/android/build.gradle",
  "node_modules/capacitor-mobile-claw/android/build.gradle",
  "node_modules/capacitor-mobilecron/android/build.gradle",
  "node_modules/capacitor-native-agent/android/build.gradle",
];

for (const relativePath of moduleGradleFiles) {
  const filePath = resolve(projectRoot, relativePath);
  if (!existsSync(filePath)) continue;

  const source = readFileSync(filePath, "utf8");
  let patchedSource = source;

  if (
    patchedSource.includes("apply plugin: 'kotlin-android'") &&
    !patchedSource.includes("buildscript {")
  ) {
    patchedSource = `${kotlinBuildscript}${patchedSource}`;
  }

  if (
    relativePath === "node_modules/@pinecall/ionic/android/build.gradle" &&
    patchedSource.includes("compileOptions {") &&
    !patchedSource.includes("jvmTarget = '17'")
  ) {
    const repositoriesMarker = "\n}\n\nrepositories";
    if (!patchedSource.includes(repositoriesMarker)) {
      throw new Error(`Could not find Android configuration boundary in ${relativePath}`);
    }
    patchedSource = patchedSource.replace(
      repositoriesMarker,
      `\n\n    kotlinOptions {\n        jvmTarget = '17'\n    }${repositoriesMarker}`,
    );
  }

  if (patchedSource !== source) {
    writeFileSync(filePath, patchedSource);
    console.log(`Patched Android Gradle compatibility: ${relativePath}`);
  }
}
