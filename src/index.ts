import { handle } from "./app";
import { recordQueueState } from "./telemetry";
import { handleXQueue } from "./x-queue";

// ペアリングを有効にした構成だけがこの Durable Object を束縛する。
export { PairingStore } from "./pairing-store";
export default {
  fetch(request, env) {
    return handle(request, env, {
      fetch: (input, init) => fetch(input, init),
      enqueueX: async (job) => {
        await env.X_EVENTS.send(job);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  },
  scheduled(_controller, env) {
    return recordQueueState(env.X_EVENTS);
  },
  queue(batch, env) {
    return handleXQueue(batch.messages, env, {
      fetch: (input, init) => fetch(input, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  },
} satisfies ExportedHandler<Env>;
