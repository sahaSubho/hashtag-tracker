import { InMemoryQueue } from "../../src/adapters/queue/in-memory-queue.js";
import { FakeClock } from "../helpers/fakes.js";
import { queueContract } from "../contract/queue.contract.js";

queueContract(
  (clock) => new InMemoryQueue(clock),
  (start) => new FakeClock(start)
);
