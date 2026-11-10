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
  "node_modules/capacitor-lancedb/android/build.gradle",
  "node_modules/capacitor-native-agent/android/build.gradle",
];

for (const relativePath of moduleGradleFiles) {
  const filePath = resolve(projectRoot, relativePath);
  if (!existsSync(filePath)) continue;

  const source = readFileSync(filePath, "utf8");
  if (!source.includes("apply plugin: 'kotlin-android'") || source.includes("buildscript {")) continue;
  writeFileSync(filePath, `${kotlinBuildscript}${source}`);
  console.log(`Patched Kotlin Gradle plugin setup: ${relativePath}`);
}
