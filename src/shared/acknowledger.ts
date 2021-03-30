import createDebug from "debug";
import { Pipeline, Redis } from "ioredis";
import { encodeRedisKey, tenantToRedisPrefix } from "../encodeRedisKey";
import { defineLocalCommands } from "../redis-commands";

const debug = createDebug("owl:acknowledger");

declare module "ioredis" {
  type AcknowledgeArgs = [
    tenantPrefix: string,
    id: string,
    queue: string,
    timestampToRescheduleFor: number | undefined
  ];
  interface Commands {
    acknowledge(...args: AcknowledgeArgs): Promise<void>;
  }

  interface Pipeline {
    acknowledge(...args: AcknowledgeArgs): this;
  }
}

export interface AcknowledgementDescriptor {
  tenant: string;
  queueId: string;
  jobId: string;
  timestampForNextRetry?: number;
  nextExecutionDate?: number;
}

export type OnError = (job: AcknowledgementDescriptor, error: Error) => void;

export class Acknowledger {
  constructor(
    private readonly redis: Redis,
    private readonly onError?: OnError
  ) {
    defineLocalCommands(this.redis, __dirname);
  }

  public _reportFailure(
    descriptor: AcknowledgementDescriptor,
    error: any,
    pipeline: Pipeline
  ) {
    const { timestampForNextRetry, queueId, jobId } = descriptor;
    const isRetryable = !!timestampForNextRetry;
    const event = isRetryable ? "retry" : "fail";

    const errorString = encodeURIComponent(error);

    const _queueId = encodeRedisKey(queueId);
    const _jobId = encodeRedisKey(jobId);

    const prefix = tenantToRedisPrefix(descriptor.tenant);

    pipeline.publish(prefix + event, `${_queueId}:${_jobId}:${errorString}`);
    pipeline.publish(prefix + _queueId, `${event}:${_jobId}:${errorString}`);
    pipeline.publish(
      prefix + `${_queueId}:${_jobId}`,
      `${event}:${errorString}`
    );
    pipeline.publish(prefix + `${_queueId}:${_jobId}:${event}`, errorString);

    pipeline.acknowledge(prefix, _jobId, _queueId, timestampForNextRetry);

    if (!isRetryable) {
      this.onError?.(descriptor, error);
    }
  }

  public async reportFailure(
    descriptor: AcknowledgementDescriptor,
    error: any
  ) {
    const pipeline = this.redis.pipeline();
    this._reportFailure(descriptor, error, pipeline);
    await pipeline.exec();
  }

  public async acknowledge(
    descriptor: AcknowledgementDescriptor,
    options: { dontReschedule?: boolean } = {}
  ) {
    const { queueId, jobId, nextExecutionDate, tenant } = descriptor;

    await this.redis.acknowledge(
      tenantToRedisPrefix(tenant),
      encodeRedisKey(jobId),
      encodeRedisKey(queueId),
      options.dontReschedule ? undefined : nextExecutionDate
    );

    if (nextExecutionDate) {
      debug(
        `requestNextJobs(): job #${jobId} - acknowledged (next execution: ${nextExecutionDate})`
      );
    } else {
      debug(`requestNextJobs(): job #${jobId} - acknowledged`);
    }
  }
}