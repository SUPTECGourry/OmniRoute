import { resolvePublicCred } from "../utils/publicCreds.ts";

export const XAI_OAUTH_PROVIDER_ID = "xai-oauth";
export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
export const XAI_OAUTH_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;
export const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
export const XAI_OAUTH_API_BASE_URL = "https://api.x.ai/v1";
export const XAI_OAUTH_RESPONSES_URL = `${XAI_OAUTH_API_BASE_URL}/responses`;
export const XAI_OAUTH_MODELS_URL = `${XAI_OAUTH_API_BASE_URL}/models`;
export const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
export const XAI_OAUTH_REDIRECT_PORT = 56121;
export const XAI_OAUTH_CALLBACK_PATH = "/callback";
export const XAI_OAUTH_REFERRER = "hermes-agent";
export const XAI_OAUTH_CLIENT_ID = resolvePublicCred("xai_id", "XAI_OAUTH_CLIENT_ID");
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_TIER_GATE_MESSAGE =
  "xAI accepted the OAuth login, but rejected inference with HTTP 403. This account may not be allowlisted for the OAuth API surface yet; use the API-key path instead (provider: xai).";

export type XaiOAuthDiscovery = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string;
};

type RawDiscovery = {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  device_authorization_endpoint?: unknown;
};

let discoveryCache: XaiOAuthDiscovery | null = null;

function isPinnedXaiHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "x.ai" || normalized.endsWith(".x.ai");
}

export function validateXaiOAuthEndpoint(endpoint: string, label = "OAuth endpoint"): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${label} must be a valid HTTPS x.ai URL`);
  }

  if (parsed.protocol !== "https:" || !isPinnedXaiHost(parsed.hostname)) {
    throw new Error(`${label} must use HTTPS on x.ai or a x.ai subdomain`);
  }

  return parsed.toString();
}

export function validateXaiApiEndpoint(endpoint: string, label = "xAI API endpoint"): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }

  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "api.x.ai") {
    throw new Error(`${label} must use https://api.x.ai`);
  }

  return parsed.toString();
}

function endpointFromDiscovery(raw: RawDiscovery, key: keyof RawDiscovery, fallback: string) {
  const value = raw[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export async function resolveXaiOAuthDiscovery(
  fetchImpl: typeof fetch = fetch
): Promise<XaiOAuthDiscovery> {
  if (discoveryCache) return discoveryCache;

  const response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`xAI OAuth discovery failed: ${response.status}`);
  }

  const raw = (await response.json()) as RawDiscovery;
  const issuer = endpointFromDiscovery(raw, "issuer", XAI_OAUTH_ISSUER).replace(/\/+$/, "");
  validateXaiOAuthEndpoint(issuer, "xAI OAuth issuer");
  if (issuer !== XAI_OAUTH_ISSUER) {
    throw new Error("xAI OAuth issuer mismatch");
  }

  discoveryCache = {
    issuer,
    authorizationEndpoint: validateXaiOAuthEndpoint(
      endpointFromDiscovery(raw, "authorization_endpoint", XAI_OAUTH_AUTHORIZE_URL),
      "xAI authorization endpoint"
    ),
    tokenEndpoint: validateXaiOAuthEndpoint(
      endpointFromDiscovery(raw, "token_endpoint", XAI_OAUTH_TOKEN_URL),
      "xAI token endpoint"
    ),
    deviceAuthorizationEndpoint: validateXaiOAuthEndpoint(
      endpointFromDiscovery(raw, "device_authorization_endpoint", XAI_OAUTH_DEVICE_CODE_URL),
      "xAI device authorization endpoint"
    ),
  };

  return discoveryCache;
}

export function clearXaiOAuthDiscoveryCache(): void {
  discoveryCache = null;
}

export function buildXaiOAuthRedirectUri(port = XAI_OAUTH_REDIRECT_PORT): string {
  return `http://${XAI_OAUTH_REDIRECT_HOST}:${port}${XAI_OAUTH_CALLBACK_PATH}`;
}

export function isXaiOAuthTierGateResponse(provider: string, status: number): boolean {
  return provider === XAI_OAUTH_PROVIDER_ID && status === 403;
}

export function buildXaiOAuthDeadRefreshData(code: string | null | undefined) {
  return {
    refreshTokenDead: true,
    refreshTokenDeadAt: new Date().toISOString(),
    refreshTokenDeadCode: code || "refresh_failed",
    reauthRequired: true,
  };
}
