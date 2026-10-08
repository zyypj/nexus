#!/usr/bin/env node
// Sets (or checks) the app version in every manifest of the monorepo.
//
//   node scripts/set-version.mjs 0.2.0           # write
//   node scripts/set-version.mjs 0.2.0 --check   # exit 1 if any file differs (used by CI)
//
// Android's versionCode is derived as major*10000 + minor*100 + patch so every
// release installs over the previous one.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [version, flag] = process.argv.slice(2);
const check = flag === "--check";

const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
if (!m) {
  console.error("usage: node scripts/set-version.mjs <major.minor.patch> [--check]");
  process.exit(2);
}
const [major, minor, patch] = m.slice(1).map(Number);
if (minor > 99 || patch > 99) {
  console.error("minor and patch must be <= 99 (Android versionCode encoding)");
  process.exit(2);
}
const versionCode = major * 10000 + minor * 100 + patch;

/** [file, regex with one capture group for the value, replacement value] */
const targets = [
  ["services/server/Cargo.toml", /^version = "([^"]+)"/m, version],
  ["apps/desktop/src-tauri/Cargo.toml", /^version = "([^"]+)"/m, version],
  ["apps/desktop/src-tauri/tauri.conf.json", /"version": "([^"]+)"/, version],
  ["apps/desktop/package.json", /"version": "([^"]+)"/, version],
  ["apps/android/package.json", /"version": "([^"]+)"/, version],
  ["apps/android/android/app/build.gradle", /versionName "([^"]+)"/, version],
  ["apps/android/android/app/build.gradle", /versionCode (\d+)/, String(versionCode)],
];

let mismatches = 0;
for (const [file, re, value] of targets) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const found = re.exec(text);
  if (!found) {
    console.error(`pattern not found in ${file}: ${re}`);
    process.exit(2);
  }
  if (found[1] === value) continue;
  if (check) {
    console.error(`${file}: ${found[1]} (expected ${value})`);
    mismatches++;
  } else {
    const replaced = text.replace(re, (whole, old) => whole.replace(old, value));
    writeFileSync(path, replaced);
    console.log(`${file}: ${found[1]} -> ${value}`);
  }
}
if (check && mismatches) process.exit(1);
if (check) console.log(`all manifests at ${version}`);
