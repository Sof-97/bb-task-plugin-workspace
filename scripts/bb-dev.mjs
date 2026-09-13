import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [action = "status", ...args] = process.argv.slice(2);
const usage = `Usage: node scripts/bb-dev.mjs <start|stop|install|watch|status|cli> [arguments]

Isolated macOS BB development profile. Start and watch run in the foreground.
Overrides: BB_TASK_DEV_APP, BB_TASK_DEV_DATA_DIR,
           BB_TASK_DEV_SERVER_PORT, BB_TASK_DEV_HOST_PORT.
Defaults: /Applications/bb.app (or ~/Applications/bb.app),
          ~/.bb-task-workspace-dev, server 48886, host 48887.
Use cli <BB arguments> to target this profile.`;
if (action === "--help" || action === "help") {
  console.log(usage);
  process.exit(0);
}
if (!["start", "stop", "install", "watch", "status", "cli"].includes(action)) {
  throw new Error(usage);
}
if (process.platform !== "darwin") {
  throw new Error(
    "This launcher supports the macOS BB app. See DEVELOPMENT.md.",
  );
}
const app = process.env.BB_TASK_DEV_APP
  ? resolve(process.env.BB_TASK_DEV_APP)
  : ["/Applications/bb.app", resolve(homedir(), "Applications/bb.app")].find(
      existsSync,
    );
if (!app)
  throw new Error("BB app not found. Set BB_TASK_DEV_APP to its .app path.");
const dataDir = resolve(
  process.env.BB_TASK_DEV_DATA_DIR ||
    resolve(homedir(), ".bb-task-workspace-dev"),
);
const within = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
if (within(root, dataDir) || within(dataDir, root)) {
  throw new Error(
    "Development data must be outside the checkout to avoid rebuild loops.",
  );
}
if (
  within(resolve(homedir(), ".bb"), dataDir) ||
  within(dataDir, resolve(homedir(), ".bb"))
) {
  throw new Error("Use a separate development data directory outside ~/.bb.");
}
const port = (key, fallback) => {
  const value = process.env[key] || fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
    throw new Error(`${key} must be a port between 1024 and 65535.`);
  }
  return String(Number(value));
};
const serverPort = port("BB_TASK_DEV_SERVER_PORT", "48886");
const hostPort = port("BB_TASK_DEV_HOST_PORT", "48887");
if (
  serverPort === hostPort ||
  [serverPort, hostPort].some((value) => ["38886", "38887"].includes(value))
) {
  throw new Error(
    "Use distinct development ports outside BB's normal 38886/38887 ports.",
  );
}
const packageDir = resolve(
  app,
  "Contents/Resources/app.asar.unpacked/node_modules/bb-app",
);
// A new thread inherits its current BB profile. Clear it before targeting dev.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("BB_")),
);
Object.assign(env, {
  npm_config_cache: resolve(dataDir, "npm-cache"),
  BB_DATA_DIR: dataDir,
  BB_SERVER_URL: `http://127.0.0.1:${serverPort}`,
  BB_SERVER_PORT: serverPort,
  BB_HOST_DAEMON_PORT: hostPort,
  BB_SERVER_BIND_HOST: "127.0.0.1",
});
let command;
let commandArgs;
if (action === "start" || action === "stop") {
  // BB's native modules require the app's bundled Electron Node ABI.
  command = resolve(app, "Contents/MacOS/bb");
  env.ELECTRON_RUN_AS_NODE = "1";
  commandArgs = [
    resolve(packageDir, "dist/bb-app.js"),
    action,
    "--data-dir",
    dataDir,
    "--server-port",
    serverPort,
    "--host-daemon-port",
    hostPort,
    "--server-bind-host",
    "127.0.0.1",
  ];
} else {
  command = resolve(packageDir, "host-daemon/dist/bb");
  commandArgs =
    action === "install"
      ? ["plugin", "install", root, ...args]
      : action === "watch"
        ? ["plugin", "dev", root]
        : action === "status"
          ? ["status", "--json"]
          : args;
}
if (!existsSync(command))
  throw new Error(`BB executable not found: ${command}`);
const result = spawnSync(command, commandArgs, {
  cwd: root,
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
