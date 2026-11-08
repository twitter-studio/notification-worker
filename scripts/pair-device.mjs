const [action, origin, value, ...extra] = process.argv.slice(2);
const admin = process.env.PAIRING_ADMIN_TOKEN;
try {
  const url = new URL(origin ?? "");
  const issue = action === "issue";
  const list = action === "list";
  const validInput = issue
    ? /^[1-9][0-9]{0,18}$/.test(value ?? "")
    : list
      ? value === undefined
      : action === "revoke" && /^[a-fA-F0-9-]{36}$/.test(value ?? "");
  if (
    !validInput ||
    extra.length ||
    !/^tpa_[A-Za-z0-9_-]{43}$/.test(admin ?? "") ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error();
  const response = await fetch(
    new URL(issue ? "/v1/pairing/codes" : list ? "/v1/pairing/routes" : "/v1/pairing/revoke", url),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: JSON.stringify(issue ? { x_user_id: value } : list ? {} : { route_id: value }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (issue && response.status === 201) {
    const result = await response.json();
    if (!/^tpc_[A-Za-z0-9_-]{43}$/.test(result.code ?? "")) throw new Error();
    process.stdout.write(`${result.code}\n`);
  } else if (list && response.status === 200) {
    const { routes } = await response.json();
    if (!Array.isArray(routes)) throw new Error();
    const types = ["mention", "reply", "retweet", "quote", "like", "follow", "dm"];
    for (const route of routes) {
      if (!/^[1-9][0-9]{0,18}$/.test(route.x_user_id) || !/^[a-f0-9-]{36}$/.test(route.route_id))
        throw new Error();
      // 版 1 の Worker は種類と DM プレビューを返さない。一覧は外す配送先を確かめるのに使うので、止めずに ? を出す。
      const listed =
        Array.isArray(route.event_types) &&
        route.event_types.every((type) => typeof type === "string" && types.includes(type));
      const eventTypes = listed ? route.event_types.join(",") || "-" : "?";
      const preview =
        typeof route.dm_preview === "boolean" ? (route.dm_preview ? "dm-preview" : "-") : "?";
      // X のログインでつないだか (x-login) と、つないだ時刻。覚えのない接続を見つけるのに使う。前の版の Worker は返さない。
      const via = typeof route.x_login === "boolean" ? (route.x_login ? "x-login" : "code") : "?";
      const connected =
        route.connected_at === null
          ? "-"
          : typeof route.connected_at === "string" &&
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(route.connected_at)
            ? route.connected_at
            : "?";
      process.stdout.write(
        `${route.x_user_id} ${route.route_id} ${eventTypes} ${preview} ${via} ${connected}\n`,
      );
    }
  } else if (action === "revoke" && response.status === 204) {
    process.stdout.write("Connection removed.\n");
  } else {
    process.stderr.write(`Worker rejected the request (HTTP ${response.status}).\n`);
    process.exitCode = 1;
  }
} catch {
  process.stderr.write(
    "Set PAIRING_ADMIN_TOKEN and use pair-device.mjs issue HTTPS_WORKER_ORIGIN X_USER_ID list HTTPS_WORKER_ORIGIN, or revoke HTTPS_WORKER_ORIGIN ROUTE_ID.\n",
  );
  process.exitCode = 1;
}
