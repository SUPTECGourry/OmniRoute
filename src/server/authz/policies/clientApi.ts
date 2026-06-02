import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth.ts";
import type { AuthOutcome, PolicyContext, RoutePolicy } from "../context";
import { allow, reject } from "../context";

function extractBearer(headers: Headers): string | null {
  const raw = headers.get("authorization") ?? headers.get("Authorization");
  const xApiKey = headers.get("x-api-key") ?? headers.get("X-Api-Key");
  if (raw) {
    const trimmed = raw.trim();
    if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
    return trimmed.slice(7).trim() || null;
  } else if (xApiKey) {
    return xApiKey?.trim() || null;
  }
  return null;
}

function maskKeyId(apiKey: string): string {
  const tail = apiKey.slice(-4);
  return `key_${tail}`;
}

export const clientApiPolicy: RoutePolicy = {
  routeClass: "CLIENT_API",
  async evaluate(ctx: PolicyContext): Promise<AuthOutcome> {
    const bearer = extractBearer(ctx.request.headers);
    if (!bearer) {
      if (await isDashboardSessionAuthenticated(ctx.request)) {
        return allow({ kind: "dashboard_session", id: "dashboard" });
      }

      if (process.env.REQUIRE_API_KEY !== "true") {
        return allow({ kind: "anonymous", id: "local" });
      }

      return reject(401, "AUTH_002", "Authentication required", {
        hint: "Provide a valid OmniRoute client API key (create one in the dashboard) via Authorization: Bearer ... or X-Api-Key, or set REQUIRE_API_KEY=false to allow unauthenticated /v1 access.",
      });
    }

    const { validateApiKey } = await import("../../../lib/db/apiKeys");
    const ok = await validateApiKey(bearer);
    if (!ok) {
      // Issue #2257: when REQUIRE_API_KEY is off, a stale CLI config (Codex
      // Desktop auto-config, Hermes, etc.) carrying an invalid Bearer
      // shouldn't 401 the whole request — REQUIRE_API_KEY=false means
      // "anonymous traffic is allowed", so an invalid key should degrade to
      // anonymous instead of rejecting. We log a warning so the bad key is
      // still observable in the request log.
      if (process.env.REQUIRE_API_KEY !== "true") {
        console.warn(
          `[clientApiPolicy] invalid bearer presented to ${ctx.classification.normalizedPath} ` +
            `but REQUIRE_API_KEY=false — falling through to anonymous (key_id=${maskKeyId(bearer)})`
        );
        return allow({ kind: "anonymous", id: "local" });
      }
      return reject(401, "AUTH_002", "Invalid API key", {
        hint: "This is the OmniRoute proxy API key (not the upstream xAI token). Log into the dashboard with INITIAL_PASSWORD, create a key under API Keys, then pass it as 'Authorization: Bearer <key>' or 'X-Api-Key: <key>' on /v1 calls. Set REQUIRE_API_KEY=false (and restart container) to allow anonymous access on trusted networks. The xAI OAuth connection only supplies credentials to api.x.ai.",
      });
    }

    return allow({ kind: "client_api_key", id: maskKeyId(bearer) });
  },
};
