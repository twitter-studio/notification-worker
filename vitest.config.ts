import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// テストは Workers の実行環境 (workerd) で動かす。Node.js で動かすと、本番と違う API で通ってしまうため。
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        bindings: {
          // テストだけの値 (本物の秘密ではない)。
          RELAY_URL: "https://relay.test",
          RELAY_TOKEN: "tsr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          MOCK_WEBHOOK_SECRET: "test-mock-webhook-secret-0123456789abcdef",
          ENABLE_MOCK_EVENTS: "true",
          X_OAUTH2_CLIENT_SECRET: "test-x-oauth2-client-secret-0123456789abcdef",
          X_EVENT_ID_SECRET: "test-event-id-secret-0123456789abcdef",
          X_USER_ID: "1111111111111111111",
        },
      },
    }),
  ],
});
