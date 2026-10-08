#!/usr/bin/env node
// Prepares a release: bumps every manifest, refreshes the Cargo lockfiles,
// commits and creates the tag. Pushing the tag starts .github/workflows/release.yml.
//
//   node scripts/release.mjs 0.2.0
//   git push origin main v0.2.0
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/release.mjs <major.minor.patch>");
  process.exit(2);
}
const status = execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString().trim();
if (status) {
  console.error("working tree is not clean; commit or stash first");
  process.exit(1);
}

run("node", ["scripts/set-version.mjs", version]);
// Workspace-only lockfile refresh: dependency versions stay as they are.
run("cargo", ["update", "--workspace", "--offline"]);
run("cargo", ["update", "--workspace", "--offline"], join(root, "apps/desktop/src-tauri"));
run("git", ["commit", "-am", `Release v${version}`]);
run("git", ["tag", "-a", `v${version}`, "-m", `Nexus v${version}`]);
console.log(`\nTagged v${version}. Publish with:\n  git push origin HEAD v${version}`);
