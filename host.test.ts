import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { ExperimentalHostWatchListener } from "@get-bb/plugin-sdk/host";
import hostEntry, {
  experimental_hostParsing,
  experimental_memoryFiles,
} from "./host";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("Wayfinder host watch forwards native invalidations and disposes on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-watch-host-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "planning"), { recursive: true });
  let listener: ExperimentalHostWatchListener | null = null;
  let disposed = 0;
  const harness = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: {
      dataDir: join(root, "data"),
      tempDir: join(root, "temp"),
    },
    experimental_watch: (_options, receive) => {
      listener = receive;
      return {
        dispose: async () => {
          disposed += 1;
        },
      };
    },
  });
  cleanups.push(() => harness.experimental_dispose());
  const watchId = randomUUID();
  await expect(
    harness.experimental_call("startWayfinderWatch", {
      watchId,
      repository: root,
      watchRoot: join(root, "planning"),
    }),
  ).resolves.toEqual({ watching: true });
  expect(listener).not.toBeNull();
  await listener!({
    kind: "changed",
    changes: [{ path: "tickets/01-one.md", type: "update" }],
  });
  await listener!({ kind: "rescan-required" });
  await listener!({ kind: "watch-error", message: "native overflow" });
  expect(harness.experimental_getSignals()).toEqual([
    {
      signal: "wayfinderChanged",
      payload: { watchId, kind: "changed", message: null },
    },
    {
      signal: "wayfinderChanged",
      payload: { watchId, kind: "rescan-required", message: null },
    },
    {
      signal: "wayfinderChanged",
      payload: { watchId, kind: "watch-error", message: "native overflow" },
    },
  ]);
  await harness.experimental_call("stopWayfinderWatch", { watchId });
  expect(disposed).toBe(1);
});

test("host parsing accepts observed success shapes and preserves stderr failures", () => {
  expect(experimental_hostParsing.parseJson("", "mutation", true)).toBeNull();
  expect(
    experimental_hostParsing.parseJson('{"branch":"task/a"}', "mutation"),
  ).toEqual({ branch: "task/a" });
  expect(
    experimental_hostParsing.parseJson(
      '{"result":{"branch":"task/a"},"status":{"stacks":[]}}',
      "mutation",
    ),
  ).toMatchObject({ result: { branch: "task/a" }, status: { stacks: [] } });
  const ambiguous = experimental_hostParsing.commandFailure("but", {
    code: 1,
    stdout: JSON.stringify({
      error: "setup_required",
      message: "unable to open database file",
      hint: "run `but setup`",
    }),
    stderr: "Error: Setup required: unable to open database file",
  });
  expect(ambiguous.message).toContain("permission or storage failure");
  expect(ambiguous.message).toContain("stderr:");
  expect(ambiguous.message).toContain("absent setup was not assumed");
  const plain = experimental_hostParsing.commandFailure("but", {
    code: 1,
    stdout: "",
    stderr: "dependency prevents this move",
  });
  expect(plain.message).toContain("dependency prevents this move");
});

test("host parsing uses GitButler integrated status and counts rename records once", () => {
  expect(
    experimental_hostParsing.branchInventory(
      {
        stacks: [
          {
            branches: [{ name: "task/merged", branchStatus: "integrated" }],
          },
        ],
      },
      {
        appliedStacks: [{ heads: [{ name: "task/merged" }] }],
        branches: [],
      },
    ),
  ).toEqual({
    appliedStacks: [["task/merged"]],
    branches: [{ name: "task/merged", merged: true }],
  });
  expect(
    experimental_hostParsing.parsePorcelain(
      "R  renamed.txt\0original.txt\0?? untracked.txt\0",
    ),
  ).toEqual({
    hasChanges: true,
    changeCount: 2,
    paths: ["renamed.txt", "untracked.txt"],
  });
});

test("real memory files preserve bytes and enforce bounded no-follow crash-safe replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-memory-host-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "host-data");
  const dataset = randomUUID();
  const taskId = randomUUID();
  const operationId = randomUUID();
  const directory = join(dataDir, "datasets", dataset, "memory");
  const canonical = join(directory, `${taskId}.md`);
  const empty = createHash("sha256").update("").digest("hex");
  await experimental_memoryFiles.initializeMemoryFile(dataDir, dataset, taskId);

  const bom = Buffer.from("\ufeff# BOM\n", "utf8");
  await writeFile(canonical, bom);
  const bomRead = await experimental_memoryFiles.readCanonical(canonical);
  expect(bomRead).toMatchObject({
    state: "present",
    hash: createHash("sha256").update(bom).digest("hex"),
  });
  if (bomRead.state !== "present") throw Error("Expected BOM memory.");
  expect(Buffer.from(bomRead.content, "utf8")).toEqual(bom);

  await writeFile(canonical, "small");
  const grew = await experimental_memoryFiles.readCanonical(canonical, {
    afterStat: () =>
      appendFile(canonical, Buffer.alloc(experimental_memoryFiles.limit + 1)),
  });
  expect(grew).toMatchObject({ state: "invalid", reason: "oversize" });

  const invalidBytes = Buffer.from([0xff, 0xfe, 0x61]);
  await writeFile(canonical, invalidBytes);
  expect(await experimental_memoryFiles.readCanonical(canonical)).toMatchObject(
    {
      state: "invalid",
      reason: "invalid-utf8",
      observedHash: createHash("sha256").update(invalidBytes).digest("hex"),
    },
  );

  await rm(canonical);
  await symlink(join(root, "outside.md"), canonical);
  expect(await experimental_memoryFiles.readCanonical(canonical)).toMatchObject(
    {
      state: "invalid",
      reason: "symlink",
    },
  );
  await rm(canonical);
  await exec("mkfifo", [canonical]);
  expect(await experimental_memoryFiles.readCanonical(canonical)).toMatchObject(
    {
      state: "invalid",
      reason: "unsafe-path",
    },
  );
  await rm(canonical);
  await writeFile(canonical, "");

  await expect(
    experimental_memoryFiles.replaceMemoryFile(
      dataDir,
      { dataset, taskId, operationId, expectedHash: empty, content: "new" },
      { afterExpectedHashCheck: () => Promise.reject(Error("before rename")) },
    ),
  ).rejects.toThrow("before rename");
  expect(await readFile(canonical, "utf8")).toBe("");

  const racedOperation = randomUUID();
  await experimental_memoryFiles.replaceMemoryFile(
    dataDir,
    {
      dataset,
      taskId,
      operationId: racedOperation,
      expectedHash: empty,
      content: "plugin wins this unsupported race",
    },
    { afterExpectedHashCheck: () => writeFile(canonical, "external racer") },
  );
  expect(await readFile(canonical, "utf8")).toBe(
    "plugin wins this unsupported race",
  );

  const currentHash = createHash("sha256")
    .update("plugin wins this unsupported race")
    .digest("hex");
  const durableContent = "renamed but sync response failed";
  const durableHash = createHash("sha256").update(durableContent).digest("hex");
  await expect(
    experimental_memoryFiles.replaceMemoryFile(
      dataDir,
      {
        dataset,
        taskId,
        operationId: randomUUID(),
        expectedHash: currentHash,
        content: durableContent,
      },
      { beforeDirectorySync: () => Promise.reject(Error("fsync failed")) },
    ),
  ).rejects.toThrow("fsync failed");
  expect(await readFile(canonical, "utf8")).toBe(durableContent);
  await expect(
    experimental_memoryFiles.confirmMemoryDurable(
      dataDir,
      dataset,
      taskId,
      durableHash,
    ),
  ).resolves.toMatchObject({ hash: durableHash });

  await expect(
    experimental_memoryFiles.replaceMemoryFile(dataDir, {
      dataset,
      taskId,
      operationId: randomUUID(),
      expectedHash: durableHash,
      content: "é".repeat(600_000),
    }),
  ).rejects.toThrow("byte limit");

  const moved = `${directory}-moved`;
  await expect(
    experimental_memoryFiles.replaceMemoryFile(
      dataDir,
      {
        dataset,
        taskId,
        operationId: randomUUID(),
        expectedHash: durableHash,
        content: "directory race",
      },
      {
        afterExpectedHashCheck: async () => {
          await rename(directory, moved);
          await mkdir(directory);
          await writeFile(canonical, "external directory replacement");
        },
      },
    ),
  ).rejects.toThrow("directory identity changed");
  expect(await readFile(canonical, "utf8")).toBe(
    "external directory replacement",
  );

  await rm(directory, { recursive: true });
  await rename(moved, directory);
  const movedForSymlink = `${directory}-symlink-moved`;
  const outsideDirectory = join(root, "outside-directory");
  const symlinkOperation = randomUUID();
  const outsideStaging = join(
    outsideDirectory,
    `.${taskId}.${symlinkOperation}.stage`,
  );
  await expect(
    experimental_memoryFiles.replaceMemoryFile(
      dataDir,
      {
        dataset,
        taskId,
        operationId: symlinkOperation,
        expectedHash: durableHash,
        content: "must not escape",
      },
      {
        afterExpectedHashCheck: async () => {
          await rename(directory, movedForSymlink);
          await mkdir(outsideDirectory);
          await writeFile(outsideStaging, "unrelated outside staging bytes");
          await symlink(outsideDirectory, directory);
        },
      },
    ),
  ).rejects.toThrow("non-directory or symlink");
  expect(await readFile(outsideStaging, "utf8")).toBe(
    "unrelated outside staging bytes",
  );
});

test("real GitButler 0.22.3 host workflow preserves dirty bytes and exact empty branch states", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-host-probe-"));
  cleanups.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  );
  const repository = join(root, "repo");
  const state = join(root, "gitbutler-state");
  const environment = {
    ...process.env,
    E2E_TEST_APP_DATA_DIR: state,
    NO_BG_TASKS: "1",
    GIT_AUTHOR_NAME: "S03 Probe",
    GIT_AUTHOR_EMAIL: "s03@example.invalid",
    GIT_COMMITTER_NAME: "S03 Probe",
    GIT_COMMITTER_EMAIL: "s03@example.invalid",
  };
  await mkdir(repository);
  await exec("but", ["-C", repository, "setup", "--init", "--json"], {
    env: environment,
  });
  const previousState = process.env.E2E_TEST_APP_DATA_DIR;
  const previousBackground = process.env.NO_BG_TASKS;
  process.env.E2E_TEST_APP_DATA_DIR = state;
  process.env.NO_BG_TASKS = "1";
  const harness = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: {
      dataDir: join(root, "host-data"),
      tempDir: join(root, "host-temp"),
    },
  });
  cleanups.push(async () => {
    await harness.experimental_dispose();
    if (previousState === undefined) delete process.env.E2E_TEST_APP_DATA_DIR;
    else process.env.E2E_TEST_APP_DATA_DIR = previousState;
    if (previousBackground === undefined) delete process.env.NO_BG_TASKS;
    else process.env.NO_BG_TASKS = previousBackground;
  });
  const independent = await harness.experimental_call("mutateBranch", {
    repository,
    action: "create-independent",
    branchName: "task/independent",
    parentBranchName: null,
  });
  expect(independent.appliedStacks).toEqual([["task/independent"]]);
  expect(independent.branches).toContainEqual({
    name: "task/independent",
    merged: false,
  });
  await writeFile(join(repository, ".gitignore"), "ignored.txt\n");
  await writeFile(join(repository, "tracked.txt"), "base\n");
  const diff = JSON.parse(
    (
      await exec("but", ["-C", repository, "diff", "--json"], {
        env: environment,
      })
    ).stdout,
  ) as { changes: Array<{ id: string }> };
  await exec(
    "but",
    [
      "-C",
      repository,
      "commit",
      "-b",
      "task/independent",
      "-m",
      "Seed tracked fixture",
      ...diff.changes.map((change) => change.id),
      "--json",
    ],
    { env: environment },
  );
  await writeFile(join(repository, "tracked.txt"), "dirty tracked\n");
  await writeFile(join(repository, "untracked.txt"), "dirty untracked\n");
  await writeFile(join(repository, "ignored.txt"), "dirty ignored\n");
  const before = await Promise.all(
    ["tracked.txt", "untracked.txt", "ignored.txt"].map((name) =>
      readFile(join(repository, name), "utf8"),
    ),
  );
  const stacked = await harness.experimental_call("mutateBranch", {
    repository,
    action: "create-stacked",
    branchName: "task/stacked",
    parentBranchName: "task/independent",
  });
  expect(stacked.appliedStacks).toEqual([["task/stacked", "task/independent"]]);
  expect(stacked.combinedWorkingCopy).toMatchObject({
    hasChanges: true,
    changeCount: 2,
  });
  expect(stacked.combinedWorkingCopy.paths).not.toContain("ignored.txt");
  expect(
    await Promise.all(
      ["tracked.txt", "untracked.txt", "ignored.txt"].map((name) =>
        readFile(join(repository, name), "utf8"),
      ),
    ),
  ).toEqual(before);
  // Reset only the disposable fixture bytes after preservation is proven so
  // GitButler can exercise its normal workspace-changing recovery commands.
  await writeFile(join(repository, "tracked.txt"), "base\n");
  await rm(join(repository, "untracked.txt"));
  await rm(join(repository, "ignored.txt"));
  await exec("but", ["-C", repository, "unapply", "task/stacked", "--json"], {
    env: environment,
  });
  const unapplied = await harness.experimental_call("inspectRepository", {
    repository,
  });
  expect(unapplied.appliedStacks).toEqual([]);
  expect(unapplied.branches.map((branch) => branch.name)).toEqual(
    expect.arrayContaining(["task/stacked", "task/independent"]),
  );
  await exec("but", ["-C", repository, "apply", "task/stacked", "--json"], {
    env: environment,
  });
  await exec(
    "but",
    [
      "-C",
      repository,
      "reword",
      "task/stacked",
      "-m",
      "task/renamed",
      "--json",
    ],
    { env: environment },
  );
  const renamed = await harness.experimental_call("inspectRepository", {
    repository,
  });
  expect(
    renamed.branches.some((branch) => branch.name === "task/stacked"),
  ).toBe(false);
  expect(
    renamed.branches.some((branch) => branch.name === "task/renamed"),
  ).toBe(true);
  await exec(
    "but",
    ["-C", repository, "branch", "delete", "task/renamed", "--json"],
    { env: environment },
  );
  const missing = await harness.experimental_call("inspectRepository", {
    repository,
  });
  expect(
    missing.branches.some((branch) => branch.name === "task/renamed"),
  ).toBe(false);
});
