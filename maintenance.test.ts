import { describe, expect, it } from "vitest";
import { MaintenanceCoordinator } from "./maintenance";

const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve };
};

describe("MaintenanceCoordinator", () => {
  it("drains admitted mutations and preserves FIFO fairness", async () => {
    const coordinator = new MaintenanceCoordinator();
    const held = deferred();
    const order: string[] = [];
    const first = coordinator.runMutation(async () => {
      order.push("mutation-1");
      await held.promise;
    });
    await Promise.resolve();
    const backup = coordinator.runMaintenance("backup", () =>
      order.push("backup"),
    );
    const second = coordinator.runMutation(() => order.push("mutation-2"));
    held.resolve();
    await Promise.all([first, backup, second]);
    expect(order).toEqual(["mutation-1", "backup", "mutation-2"]);
  });

  it("releases admission around external work and reacquires afterward", async () => {
    const coordinator = new MaintenanceCoordinator();
    const external = deferred();
    const order: string[] = [];
    const mutation = coordinator.runMutation(async () => {
      order.push("prepared");
      await coordinator.runExternal(async () => {
        order.push("external");
        await external.promise;
      });
      order.push("settled");
    });
    await Promise.resolve();
    await Promise.resolve();
    const backup = coordinator.runMaintenance("backup", () =>
      order.push("backup"),
    );
    await backup;
    external.resolve();
    await mutation;
    expect(order).toEqual(["prepared", "external", "backup", "settled"]);
  });

  it("releases on failure, permits nested mutation helpers, and rejects restore overlap", async () => {
    const coordinator = new MaintenanceCoordinator();
    await expect(
      coordinator.runMutation(async () => {
        await coordinator.runMutation(() => undefined);
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await coordinator.runMaintenance("backup", () => undefined);

    const held = deferred();
    const restore = coordinator.runMaintenance("restore", () => held.promise);
    await Promise.resolve();
    await expect(
      coordinator.runMaintenance("restore", () => undefined),
    ).rejects.toThrow("already active");
    held.resolve();
    await restore;
  });
});
