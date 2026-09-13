import { test, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hostEntry from "./host";
import plugin from "./server";
import { ARCHIVE_SCHEMA_VERSION } from "./archive";

test("migration ledger count equals archive schema version", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-workspace-mig-"));
  const worker = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: {
      dataDir: join(root, "host"),
      tempDir: join(root, "temp"),
    },
  });
  try {
    const { bb } = await createFakePluginHost({
      pluginId: "task-workspace",
      dataDir: join(root, "plugin"),
      experimental_callHostRpc: async ({ method, input }) =>
        worker.experimental_call(method as never, input as never),
      experimental_hostEntry: true,
    });
    await plugin(bb);
    const db = bb.storage.database();
    const count = (
      db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get() as {
        count: number;
      }
    ).count;
    expect(count).toBe(ARCHIVE_SCHEMA_VERSION);
  } finally {
    await worker.experimental_dispose();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 20,
    });
  }
});
