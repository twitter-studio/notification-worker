import { handle } from "./app";
import { handleXQueue } from "./x-queue";

// 名前付きの export は置かない。Workers では、名前付きの export が別の入口 (entrypoint) として呼べてしまうため。
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
  queue(batch, env) {
    return handleXQueue(batch.messages, env, {
      fetch: (input, init) => fetch(input, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  },
} satisfies ExportedHandler<Env>;
