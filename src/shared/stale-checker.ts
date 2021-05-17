import type { Redis } from "ioredis";
import { Closable } from "../Closable";
import { tenantToRedisPrefix } from "../encodeRedisKey";
import type { Producer } from "../producer/producer";
import { computeTimestampForNextRetry } from "../worker/retry";
import type { Acknowledger } from "./acknowledger";
import { scanTenantsForProcessing } from "./scan-tenants";

const oneMinute = 60 * 1000;

export interface StaleCheckerConfig {
  interval?: number | "manual";
  staleAfter?: number;
}

export class StaleChecker<ScheduleType extends string> implements Closable {
  private intervalId?: NodeJS.Timeout;

  private readonly staleAfter;

  constructor(
    private readonly redis: Redis,
    private readonly acknowledger: Acknowledger<ScheduleType>,
    private readonly producer: Producer<ScheduleType>,
    config: StaleCheckerConfig = {}
  ) {
    this.staleAfter = config.staleAfter ?? 60 * oneMinute;

    if (config.interval !== "manual") {
      this.intervalId = setInterval(
        () => this.check(),
        config.interval ?? oneMinute
      );
    }
  }

  public close() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  private getMaxDate(now = Date.now()): number {
    return now - this.staleAfter;
  }

  private async zremrangebyscoreandreturn(
    key: string,
    min: string | number,
    max: string | number
  ) {
    const result = await this.redis
      .pipeline()
      .zrangebyscore(key, min, max)
      .zremrangebyscore(key, min, max)
      .exec();

    const [rangeByScoreResult, remRangeByScoreResult] = result;

    if (rangeByScoreResult[0]) {
      throw rangeByScoreResult[0];
    }

    if (remRangeByScoreResult[0]) {
      throw remRangeByScoreResult[0];
    }

    return rangeByScoreResult[1] as string[];
  }

  private parseJobDescriptor(descriptor: string) {
    const [queue, id] = descriptor.split(":");
    return { queue, id };
  }

  public async check() {
    for await (const tenants of scanTenantsForProcessing(this.redis)) {
      await Promise.all(
        tenants.map(async (tenant) => {
          const staleJobDescriptors = await this.zremrangebyscoreandreturn(
            tenantToRedisPrefix(tenant) + "processing",
            "-inf",
            this.getMaxDate()
          );

          if (staleJobDescriptors.length === 0) {
            return;
          }

          const staleJobs = await this.producer.findJobs(
            tenant,
            staleJobDescriptors.map(this.parseJobDescriptor)
          );

          const pipeline = this.redis.pipeline();

          const error = "Job Timed Out";

          for (const job of staleJobs) {
            if (!job) {
              console.error(new Error("Expected job to still exist"));
              continue;
            }

            const timestampForNextRetry = computeTimestampForNextRetry(
              job.runAt,
              job.retry,
              job.count
            );

            await this.acknowledger._reportFailure(
              {
                tenant,
                queueId: job.queue,
                jobId: job.id,
                timestampForNextRetry,
              },
              job,
              error,
              pipeline
            );
          }

          await pipeline.exec();
        })
      );
    }
  }
}