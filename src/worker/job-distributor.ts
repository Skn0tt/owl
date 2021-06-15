import { Logger } from "pino";
import { Closable } from "../Closable";

export class JobDistributor<T> implements Closable {
  private readonly jobs = new Set<T>();

  private isClosed = false;

  get load() {
    return this.jobs.size;
  }

  get isPacked() {
    return this.jobs.size >= this.maxJobs;
  }

  constructor(
    private readonly fetchInitialTenants: () => AsyncGenerator<string[]>,
    private readonly fetch: (
      tenant: string
    ) => Promise<
      ["empty"] | ["retry"] | ["success", T] | ["wait", Promise<void>]
    >,
    private readonly run: (job: T, tenant: string) => Promise<void>,
    private readonly logger?: Logger,
    public readonly maxJobs: number = 100,
    private readonly autoCheckEvery: number = 1000
  ) {}

  public async start() {
    const promises: Promise<void>[] = [];
    for await (const tenants of this.fetchInitialTenants()) {
      promises.push(...tenants.map((t) => this.checkForNewJobs(t)));
    }
    await Promise.all(promises);
  }

  private async workOn(job: T, tenant: string) {
    this.jobs.add(job);

    try {
      this.logger?.trace({ job }, "Distributor: Starting work on job");
      await this.run(job, tenant);
      this.logger?.trace({ job }, "Distributor: Finished work on job");
    } catch (e) {
      this.logger?.error(e);
      console.error(e);
    }

    this.jobs.delete(job);

    this.checkForNewJobs(tenant);
  }

  // DI for testing
  setTimeout: (cb: () => void, timeout: number) => NodeJS.Timeout =
    global.setTimeout;

  autoCheckIds: Record<string, NodeJS.Timeout> = {};

  private delayAutoCheck(tenant: string) {
    if (this.autoCheckIds[tenant]) {
      clearTimeout(this.autoCheckIds[tenant]);
    }

    if (this.isClosed) {
      return;
    }

    this.autoCheckIds[tenant] = this.setTimeout(
      () => this.checkForNewJobs(tenant),
      this.autoCheckEvery
    );
  }

  public async checkForNewJobs(tenant: string) {
    this.logger?.trace({ tenant }, "Checking for jobs");
    this.delayAutoCheck(tenant);

    while (!this.isPacked) {
      const result = await this.fetch(tenant);
      this.logger?.trace({ tenant, result }, "Checking for jobs finished");
      switch (result[0]) {
        case "empty": {
          return;
        }

        case "success": {
          const job = result[1];
          this.workOn(job, tenant);
          continue;
        }

        case "wait": {
          const waitFor = result[1];
          await waitFor;
          continue;
        }

        case "retry": {
          continue;
        }
      }
    }
  }

  close() {
    this.isClosed = true;
    for (const autoCheckId of Object.values(this.autoCheckIds)) {
      clearTimeout(autoCheckId);
    }
  }
}
