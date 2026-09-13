import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = mkdtempSync(join(tmpdir(), "bb-task-distribution-"));
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: staging,
    stdio: "inherit",
    env: { ...process.env, npm_config_cache: join(staging, ".npm-cache") },
  });

try {
  // Include pending source edits, but exclude ignored local files even when
  // their old paths are still tracked until the publication commit is made.
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const ignored = new Set(
    execFileSync(
      "git",
      ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean),
  );
  for (const file of new Set(files)) {
    if (ignored.has(file) || !existsSync(join(root, file))) continue;
    mkdirSync(dirname(join(staging, file)), { recursive: true });
    copyFileSync(join(root, file), join(staging, file));
  }

  // Match BB's managed Git install: no development/optional packages or scripts.
  run("npm", [
    "install",
    "--omit=dev",
    "--omit=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  run("bb", ["plugin", "build", staging]);
  const manifest = JSON.parse(
    readFileSync(join(staging, "package.json"), "utf8"),
  );
  for (const entry of ["server", "app", "host"]) {
    if (!manifest.bb[entry]) continue;
    for (const suffix of ["js", "meta.json"]) {
      if (!existsSync(join(staging, "dist", `${entry}.${suffix}`))) {
        throw new Error(`Missing ${entry}.${suffix}`);
      }
    }
  }
  console.log("Production-only distribution build passed (server, app, host).");
} finally {
  rmSync(staging, { recursive: true, force: true });
}
