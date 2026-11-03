import { handle } from "./app";

// 名前付きの export は置かない。Workers では、名前付きの export が別の入口 (entrypoint) として呼べてしまうため。
export default {
  fetch(request, env) {
    return handle(request, env, {
      fetch: (input, init) => fetch(input, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  },
} satisfies ExportedHandler<Env>;
