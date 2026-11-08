import { handle } from "./app";
import { pairingStore } from "./pairing-store";
import { recordQueueState } from "./telemetry";
import { handleXQueue } from "./x-queue";
import { cleanupWorkerSubscriptions } from "./x-subscriptions";

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
  async scheduled(_controller, env) {
    // 片付けは、キューの記録の失敗に巻き込まれずに走らせる。
    await recordQueueState(env.X_EVENTS).catch(() => undefined);
    // ルートのないまま残った、Worker が作った購読を片付ける (X の課金を止める)。
    const store = pairingStore(env);
    if (store)
      await cleanupWorkerSubscriptions(env, store, {
        fetch: (input, init) => fetch(input, init),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
  },
  queue(batch, env) {
    return handleXQueue(batch.messages, env, {
      fetch: (input, init) => fetch(input, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  },
} satisfies ExportedHandler<Env>;
