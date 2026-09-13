import { AsyncLocalStorage } from "node:async_hooks";

export type MaintenanceKind = "backup" | "restore";

type Waiter =
  | { kind: "mutation"; resolve: () => void }
  | { kind: "maintenance"; maintenance: MaintenanceKind; resolve: () => void };

type MutationLease = { active: boolean };

export class MaintenanceCoordinator {
  readonly #context = new AsyncLocalStorage<MutationLease>();
  readonly #queue: Waiter[] = [];
  #mutations = 0;
  #maintenance: MaintenanceKind | null = null;

  get state() {
    return {
      activeMutations: this.#mutations,
      maintenance: this.#maintenance,
      queued: this.#queue.map((item) =>
        item.kind === "mutation" ? item.kind : item.maintenance,
      ),
    };
  }

  async runMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const inherited = this.#context.getStore();
    if (inherited) return operation();
    await this.#acquireMutation();
    const lease = { active: true };
    try {
      return await this.#context.run(lease, operation);
    } finally {
      if (lease.active) this.#releaseMutation(lease);
    }
  }

  async runMaintenance<T>(
    kind: MaintenanceKind,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    if (this.#context.getStore())
      throw new Error("Maintenance cannot start from inside a mutation.");
    if (
      kind === "restore" &&
      (this.#maintenance === "restore" ||
        this.#queue.some(
          (item) =>
            item.kind === "maintenance" && item.maintenance === "restore",
        ))
    )
      throw new Error("A restore is already active or queued.");
    await this.#acquireMaintenance(kind);
    try {
      return await operation();
    } finally {
      this.#maintenance = null;
      this.#drain();
    }
  }

  /** Release durable-mutation admission while awaiting an external side effect. */
  async runExternal<T>(operation: () => Promise<T>): Promise<T> {
    const lease = this.#context.getStore();
    if (!lease)
      throw new Error("External suspension requires an admitted mutation.");
    if (!lease.active)
      throw new Error("A mutation cannot suspend admission recursively.");
    this.#releaseMutation(lease);
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await operation();
    } catch (error) {
      failure = error;
    }
    await this.#acquireMutation();
    lease.active = true;
    if (failure !== undefined) throw failure;
    return result as T;
  }

  #acquireMutation() {
    if (!this.#maintenance && this.#queue.length === 0) {
      this.#mutations += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#queue.push({ kind: "mutation", resolve });
    });
  }

  #releaseMutation(lease: MutationLease) {
    lease.active = false;
    this.#mutations -= 1;
    this.#drain();
  }

  #acquireMaintenance(maintenance: MaintenanceKind) {
    if (
      !this.#maintenance &&
      this.#mutations === 0 &&
      this.#queue.length === 0
    ) {
      this.#maintenance = maintenance;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#queue.push({ kind: "maintenance", maintenance, resolve });
    });
  }

  #drain() {
    if (this.#maintenance || this.#mutations !== 0 || this.#queue.length === 0)
      return;
    const first = this.#queue[0]!;
    if (first.kind === "maintenance") {
      this.#queue.shift();
      this.#maintenance = first.maintenance;
      first.resolve();
      return;
    }
    while (this.#queue[0]?.kind === "mutation") {
      const waiter = this.#queue.shift() as Extract<
        Waiter,
        { kind: "mutation" }
      >;
      this.#mutations += 1;
      waiter.resolve();
    }
  }
}
