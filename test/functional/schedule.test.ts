import { expect } from "chai";
import { makeWorkerEnv } from "./support";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Schedule", () => {
  const env = makeWorkerEnv();

  beforeEach(env.setup);
  afterEach(env.teardown);

  describe("every 10 msec", () => {
    describe("without 'times' limit", () => {
      it("executes until deleted", async () => {
        await env.producer.enqueue({
          queue: "scheduled-eternity",
          id: "a",
          payload: "a",
          schedule: {
            type: "every",
            meta: "10",
          },
        });

        await delay(100);

        expect(env.jobs.length).to.be.closeTo(7, 1);

        const lengthBeforeDeletion = env.jobs.length;

        await env.producer.delete("scheduled-eternity", "a");

        await delay(100);

        const lengthAfterDeletion = env.jobs.length;

        expect(lengthAfterDeletion - lengthBeforeDeletion).to.be.closeTo(0, 2);
      });
    });

    describe("with 'times' limit", () => {
      it("executes specified amount of times", async () => {
        await env.producer.enqueue({
          queue: "scheduled-times",
          id: "a",
          payload: "a",
          schedule: {
            type: "every",
            meta: "10",
          },
          times: 5,
        });

        await delay(100);

        expect(env.jobs.length).to.equal(5);
      });
    });
  });
});