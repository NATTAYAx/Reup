// scripts/bump-version.mjs
//
// Windows Installer decides whether to upgrade an existing install purely from
// ProductVersion. Build twice at 0.2.0 and the second MSI looks like something
// already installed, so it does nothing and you are back to uninstalling by
// hand. The version has to move on every build you intend to install.
//
// Remembering to edit two JSON files by hand before every build is not a plan,
// so this does it. Run `pnpm release` instead of `pnpm tauri build` and the
// installer will always have an upgrade to perform.
//
//   pnpm bump          patch:  0.2.0 -> 0.2.1
//   pnpm bump minor    minor:  0.2.1 -> 0.3.0
//   pnpm bump major    major:  0.3.0 -> 1.0.0
//
// Both files are written because they must never disagree: tauri.conf.json is
// what ends up in the installer, package.json is what the app displays in
// settings, and a mismatch means the number on screen is a lie.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(root, "package.json");
const CONF = join(root, "src-tauri", "tauri.conf.json");

const level = (process.argv[2] ?? "patch").toLowerCase();
if (!["patch", "minor", "major"].includes(level)) {
  console.error(`bump-version: unknown level "${level}" (use patch, minor or major)`);
  process.exit(1);
}

/** Rewrite only the version string, so formatting and comments survive. */
function bumpFile(path, next) {
  const raw = readFileSync(path, "utf8");
  const replaced = raw.replace(
    /("version"\s*:\s*")\d+\.\d+\.\d+(")/,
    (_m, a, b) => `${a}${next}${b}`,
  );
  if (replaced === raw) {
    console.error(`bump-version: no version field found in ${path}`);
    process.exit(1);
  }
  writeFileSync(path, replaced);
}

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version ?? "");
if (!match) {
  console.error(`bump-version: package.json version "${pkg.version}" is not x.y.z`);
  process.exit(1);
}

let [major, minor, patch] = match.slice(1).map(Number);
if (level === "major") { major += 1; minor = 0; patch = 0; }
else if (level === "minor") { minor += 1; patch = 0; }
else { patch += 1; }

const next = `${major}.${minor}.${patch}`;
bumpFile(PKG, next);
bumpFile(CONF, next);

console.log(`version ${pkg.version} -> ${next}`);
