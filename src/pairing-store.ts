import { DurableObject } from "cloudflare:workers";
import { relayEndpoint, type XRelayTarget, xRelayTargets } from "./config";

type PairingRoute = { recipient: string; routeID: string; token: string; managementHash: string };
type Reservation = { routeID: string; managementHash: string; cancelled?: boolean };
type Code = {
  recipient: string;
  hash: string;
  proofKey: string;
  expires: number;
  usedBy?: Reservation;
  reservations?: Reservation[];
};
type State = { codes: Code[]; routes: (PairingRoute & { nextTestAt?: number })[] };

declare global {
  interface Env {
    PAIRING_ROUTES?: DurableObjectNamespace<PairingStore>;
    PAIRING_ADMIN_TOKEN?: string;
  }
}

export class PairingStore extends DurableObject<Env> {
  private read(): State {
    return this.ctx.storage.kv.get<State>("pairing") ?? { codes: [], routes: [] };
  }

  issue(code: Code): boolean {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      state.codes = state.codes.filter(
        (entry) => entry.expires > Date.now() && entry.recipient !== code.recipient,
      );
      if (state.codes.length >= 8) return false;
      state.codes.push(code);
      this.ctx.storage.kv.put("pairing", state);
      return true;
    });
  }

  reserveCode(
    hash: string,
    recipient: string,
    routeID: string,
    managementHash: string,
  ): string | undefined {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      const code = state.codes.find(
        (item) => item.hash === hash && item.recipient === recipient && item.expires > Date.now(),
      );
      if (
        !code ||
        (code.usedBy &&
          (code.usedBy.routeID !== routeID || code.usedBy.managementHash !== managementHash))
      )
        return undefined;
      code.reservations ??= [];
      const reservations = code.reservations;
      const existing = reservations.find(
        (item) => item.routeID === routeID && item.managementHash === managementHash,
      );
      if (existing) return existing.cancelled ? undefined : code.proofKey;
      if (reservations.length >= 4) return undefined;
      reservations.push({ routeID, managementHash });
      this.ctx.storage.kv.put("pairing", state);
      return code.proofKey;
    });
  }

  list(): { x_user_id: string; route_id: string }[] {
    return this.read().routes.map(({ recipient, routeID }) => ({
      x_user_id: recipient,
      route_id: routeID,
    }));
  }

  registerRoute(codeHash: string, route: PairingRoute): "connected" | "invalid" | "conflict" {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      const code = state.codes.find(
        (item) =>
          item.hash === codeHash && item.recipient === route.recipient && item.expires > Date.now(),
      );
      if (
        !code?.reservations?.some(
          (item) =>
            item.routeID === route.routeID &&
            item.managementHash === route.managementHash &&
            !item.cancelled,
        ) ||
        (code.usedBy !== undefined &&
          (code.usedBy.managementHash !== route.managementHash ||
            code.usedBy.routeID !== route.routeID))
      )
        return "invalid";
      const existing = state.routes.find((item) => item.routeID === route.routeID);
      if (existing) {
        if (
          existing.managementHash !== route.managementHash ||
          existing.recipient !== route.recipient ||
          existing.token !== route.token
        )
          return "conflict";
      } else {
        if (code.usedBy !== undefined) return "invalid";
        const manual = xRelayTargets(this.env, true);
        const all = [
          ...manual,
          ...state.routes.map((item) => ({
            recipient: item.recipient,
            routeID: item.routeID,
            config: { token: item.token },
          })),
        ];
        const sameRecipient = all.filter((item) => item.recipient === route.recipient);
        if (
          all.some((item) => item.routeID === route.routeID) ||
          sameRecipient.some((item) => item.config.token === route.token) ||
          sameRecipient.length >= 4 ||
          new Set([...all.map((item) => item.recipient), route.recipient]).size > 8
        )
          return "conflict";
        state.routes.push(route);
      }
      code.usedBy = { managementHash: route.managementHash, routeID: route.routeID };
      this.ctx.storage.kv.put("pairing", state);
      return "connected";
    });
  }

  disconnect(routeID: string, managementHash?: string): void {
    this.ctx.storage.transactionSync(() => {
      const state = this.read();
      const routes = state.routes.filter(
        (route) =>
          route.routeID !== routeID ||
          (managementHash !== undefined && route.managementHash !== managementHash),
      );
      let changed = routes.length !== state.routes.length;
      for (const code of state.codes) {
        for (const reservation of code.reservations ?? []) {
          if (
            reservation.routeID !== routeID ||
            reservation.cancelled ||
            (managementHash !== undefined && reservation.managementHash !== managementHash)
          )
            continue;
          reservation.cancelled = true;
          changed = true;
        }
      }
      if (changed) this.ctx.storage.kv.put("pairing", { ...state, routes });
    });
  }

  reserveTest(
    routeID: string,
    managementHash: string,
  ): { kind: "missing" | "limited" } | { kind: "ready"; route: PairingRoute } {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      const route = state.routes.find(
        (item) => item.routeID === routeID && item.managementHash === managementHash,
      );
      if (!route) return { kind: "missing" };
      const now = Date.now();
      if ((route.nextTestAt ?? 0) > now) return { kind: "limited" };
      route.nextTestAt = now + 60_000;
      this.ctx.storage.kv.put("pairing", state);
      return { kind: "ready", route };
    });
  }

  targets(): Pick<PairingRoute, "recipient" | "routeID" | "token">[] {
    return this.read().routes.map(({ recipient, routeID, token }) => ({
      recipient,
      routeID,
      token,
    }));
  }
}

export function pairingStore(env: Env) {
  if (
    env.PUBLIC_RELAY_TRIAL_UNTIL !== undefined ||
    env.PUBLIC_RELAY_TRIAL_ORIGIN !== undefined ||
    !/^tpa_[A-Za-z0-9_-]{43}$/.test(env.PAIRING_ADMIN_TOKEN ?? "")
  )
    return undefined;
  return env.PAIRING_ROUTES?.getByName("routes");
}

export async function deliveryTargets(env: Env): Promise<XRelayTarget[]> {
  const store = pairingStore(env);
  const manual = xRelayTargets(env, store !== undefined);
  const paired = await store?.targets();
  if (!paired?.length) return manual;
  const endpoint = relayEndpoint(env.RELAY_URL);
  const accounts = new Set(manual.map((item) => item.recipient));
  for (const { recipient, routeID, token } of paired) {
    const sameRecipient = manual.filter((item) => item.recipient === recipient);
    if (
      manual.some((item) => item.routeID === routeID) ||
      sameRecipient.some((item) => item.config.token === token) ||
      sameRecipient.length >= 4 ||
      (!accounts.has(recipient) && accounts.size >= 8)
    )
      continue;
    accounts.add(recipient);
    manual.push({
      recipient,
      routeID,
      config: { endpoint, token },
      eventTypes: ["mention", "reply"],
    });
  }
  return manual;
}
