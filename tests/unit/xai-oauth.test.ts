import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { generateCodeChallenge } from "../../src/lib/oauth/utils/pkce.ts";
import { xaiOAuth } from "../../src/lib/oauth/providers/xai-oauth.ts";
import {
  XAI_OAUTH_AUTHORIZE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_MODELS_URL,
  XAI_OAUTH_RESPONSES_URL,
  XAI_OAUTH_TIER_GATE_MESSAGE,
  buildXaiOAuthDeadRefreshData,
  clearXaiOAuthDiscoveryCache,
  isXaiOAuthTierGateResponse,
  validateXaiApiEndpoint,
  validateXaiOAuthEndpoint,
} from "../../open-sse/config/xaiOAuth.ts";
import {
  refreshXaiOAuthToken,
  supportsTokenRefresh,
} from "../../open-sse/services/tokenRefresh.ts";
import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import { parseModel } from "../../open-sse/services/model.ts";

type TestFetch = typeof fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bodyToParams(body: BodyInit | null | undefined): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams(typeof body === "string" ? body : String(body ?? ""));
}

async function withMockedFetch<TResult>(fetchImpl: TestFetch, fn: () => Promise<TResult>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  clearXaiOAuthDiscoveryCache();
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    clearXaiOAuthDiscoveryCache();
  }
}

function createLog() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

test("xAI OAuth auth URL uses S256 PKCE and Hermes-compatible parameters", () => {
  const codeVerifier = "xai-test-code-verifier";
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const authUrl = xaiOAuth.buildAuthUrl(
    xaiOAuth.config,
    "http://127.0.0.1:56121/callback",
    "state-123",
    codeChallenge
  );

  const url = new URL(authUrl);
  assert.equal(`${url.origin}${url.pathname}`, XAI_OAUTH_AUTHORIZE_URL);
  assert.equal(url.searchParams.get("client_id"), XAI_OAUTH_CLIENT_ID);
  assert.match(XAI_OAUTH_CLIENT_ID, /^[0-9a-f-]{36}$/i);
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:56121/callback");
  assert.equal(url.searchParams.get("code_challenge"), codeChallenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("plan"), "generic");
  assert.equal(url.searchParams.get("referrer"), "hermes-agent");
  assert.ok(url.searchParams.get("scope")?.includes("offline_access"));
  assert.ok(url.searchParams.get("scope")?.includes("grok-cli:access"));
  assert.ok(url.searchParams.get("scope")?.includes("api:access"));
});

test("xAI OAuth token exchange sends code verifier and original challenge", async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];

  await withMockedFetch(
    async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/.well-known/openid-configuration")) {
        return jsonResponse({
          issuer: "https://auth.x.ai",
          authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
          token_endpoint: "https://auth.x.ai/oauth2/token",
          device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
        });
      }
      return jsonResponse({
        access_token: "access.jwt.parts",
        refresh_token: "refresh-token",
        expires_in: 3600,
      });
    },
    async () => {
      const result = await xaiOAuth.exchangeToken(
        xaiOAuth.config,
        "auth-code",
        "http://127.0.0.1:56121/callback",
        "verifier-123",
        "state-123",
        "challenge-123"
      );

      assert.equal(result.access_token, "access.jwt.parts");
      assert.equal(result._authFlow, "authorization_code_pkce");
      assert.equal(result.token_endpoint, "https://auth.x.ai/oauth2/token");
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, "https://auth.x.ai/oauth2/token");

      const params = bodyToParams(calls[1].options.body);
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("client_id"), XAI_OAUTH_CLIENT_ID);
      assert.equal(params.get("code"), "auth-code");
      assert.equal(params.get("redirect_uri"), "http://127.0.0.1:56121/callback");
      assert.equal(params.get("code_verifier"), "verifier-123");
      assert.equal(params.get("code_challenge"), "challenge-123");
      assert.equal(params.get("code_challenge_method"), "S256");
    }
  );
});

test("xAI OAuth manual fallback keeps the original PKCE challenge available", () => {
  const routeSource = readFileSync(
    new URL("../../src/app/api/oauth/[provider]/[action]/route.ts", import.meta.url),
    "utf8"
  );
  const modalSource = readFileSync(
    new URL("../../src/shared/components/OAuthModal.tsx", import.meta.url),
    "utf8"
  );

  assert.match(routeSource, /codeChallenge: authData\.codeChallenge/);
  assert.match(routeSource, /state: authData\.state/);
  assert.match(routeSource, /field: "codeChallenge"/);
  assert.match(routeSource, /Code challenge is required for xAI OAuth exchange/);

  assert.match(modalSource, /const PKCE_CALLBACK_SERVER_PROVIDERS = new Set\(\["codex"\]\)/);
  assert.match(
    modalSource,
    /provider === "claude" \|\| provider === "cline" \|\| provider === "xai-oauth"/
  );
  assert.match(modalSource, /codeChallenge: authData\.codeChallenge/);
  assert.match(modalSource, /Device Code/);
});

test("xAI OAuth endpoint pinning rejects non-x.ai OAuth hosts and non-api inference hosts", () => {
  assert.equal(
    validateXaiOAuthEndpoint("https://auth.x.ai/oauth2/token"),
    "https://auth.x.ai/oauth2/token"
  );
  assert.equal(validateXaiApiEndpoint(XAI_OAUTH_RESPONSES_URL), XAI_OAUTH_RESPONSES_URL);
  assert.equal(validateXaiApiEndpoint(XAI_OAUTH_MODELS_URL), XAI_OAUTH_MODELS_URL);

  assert.throws(() => validateXaiOAuthEndpoint("https://example.com/oauth2/token"), /x\.ai/);
  assert.throws(() => validateXaiOAuthEndpoint("http://auth.x.ai/oauth2/token"), /HTTPS/);
  assert.throws(() => validateXaiApiEndpoint("https://auth.x.ai/oauth2/token"), /api\.x\.ai/);
});

test("xAI OAuth refresh terminal 4xx marks the refresh token dead and skips replay", async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const log = createLog();

  await withMockedFetch(
    async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ error: "invalid_grant" }, 400);
    },
    async () => {
      const result = await refreshXaiOAuthToken("refresh-token", {}, log);
      assert.equal(result?.error, "unrecoverable_refresh_error");
      assert.equal(result?.code, "invalid_grant");
      assert.equal(result?.providerSpecificData?.refreshTokenDead, true);
      assert.equal(result?.providerSpecificData?.reauthRequired, true);
      assert.equal(calls.length, 1);

      const params = bodyToParams(calls[0].options.body);
      assert.equal(params.get("grant_type"), "refresh_token");
      assert.equal(params.get("refresh_token"), "refresh-token");
      assert.equal(params.get("client_id"), XAI_OAUTH_CLIENT_ID);

      const skipped = await refreshXaiOAuthToken(
        "refresh-token",
        result?.providerSpecificData,
        log
      );
      assert.equal(skipped?.error, "unrecoverable_refresh_error");
      assert.equal(skipped?.providerSpecificData?.refreshTokenDead, true);
      assert.equal(calls.length, 1, "quarantined refresh token must not be posted again");
    }
  );
});

test("xAI OAuth tier-gating helper returns API-key fallback guidance", () => {
  assert.equal(isXaiOAuthTierGateResponse("xai-oauth", 403), true);
  assert.equal(isXaiOAuthTierGateResponse("xai-oauth", 401), false);
  assert.equal(isXaiOAuthTierGateResponse("xai", 403), false);
  assert.match(XAI_OAUTH_TIER_GATE_MESSAGE, /provider: xai/);
  assert.match(XAI_OAUTH_TIER_GATE_MESSAGE, /HTTP 403/);
});

test("xAI OAuth provider is registered separately from xai API key and grok-web cookie paths", () => {
  assert.ok(REGISTRY["xai-oauth"]);
  assert.ok(REGISTRY.xai);
  assert.ok(REGISTRY["grok-web"]);
  assert.equal(REGISTRY["xai-oauth"].authType, "oauth");
  assert.equal(REGISTRY.xai.authType, "apikey");
  assert.equal(REGISTRY["grok-web"].authType, "apikey");
  assert.equal(REGISTRY["grok-web"].authHeader, "cookie");
  assert.equal(supportsTokenRefresh("xai-oauth"), true);

  const models = REGISTRY["xai-oauth"].models ?? [];
  assert.equal(models[0]?.id, "grok-build-0.1");
  assert.ok(models.some((model) => model.id === "grok-4.3"));
  assert.equal(
    models.find((model) => model.id === "grok-4.20-multi-agent-0309")?.toolCalling,
    false
  );

  assert.deepEqual(parseModel("grok-oauth/grok-4.3"), {
    provider: "xai-oauth",
    model: "grok-4.3",
    isAlias: false,
    providerAlias: "grok-oauth",
    extendedContext: false,
  });
});

test("xAI OAuth dead-refresh data carries a reauth-required marker", () => {
  const data = buildXaiOAuthDeadRefreshData("invalid_grant");
  assert.equal(data.refreshTokenDead, true);
  assert.equal(data.refreshTokenDeadCode, "invalid_grant");
  assert.equal(data.reauthRequired, true);
  assert.match(data.refreshTokenDeadAt, /^\d{4}-\d{2}-\d{2}T/);
});
