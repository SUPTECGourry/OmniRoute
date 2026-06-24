import { randomUUID } from "node:crypto";
import { XAI_OAUTH_CONFIG } from "../constants/oauth";
import {
  XAI_OAUTH_CALLBACK_PATH,
  XAI_OAUTH_REDIRECT_PORT,
  XAI_OAUTH_REFERRER,
  XAI_OAUTH_SCOPE,
  resolveXaiOAuthDiscovery,
} from "@omniroute/open-sse/config/xaiOAuth.ts";

function decodeBase64UrlJson(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;

  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function readOAuthPayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: "invalid_response", error_description: text };
  }
}

function buildForm(entries: Record<string, string | null | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  return params;
}

function tokenErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  return (firstString(payload.error_description, payload.message, payload.error) || fallback).slice(
    0,
    500
  );
}

export const xaiOAuth = {
  config: XAI_OAUTH_CONFIG,
  flowType: "authorization_code_pkce",
  supportsDeviceCode: true,
  fixedPort: XAI_OAUTH_REDIRECT_PORT,
  callbackPath: XAI_OAUTH_CALLBACK_PATH,

  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: config.scope || XAI_OAUTH_SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: config.codeChallengeMethod || "S256",
      state,
      nonce: randomUUID(),
      plan: "generic",
      referrer: XAI_OAUTH_REFERRER,
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },

  exchangeToken: async (config, code, redirectUri, codeVerifier, _state, codeChallenge) => {
    if (!codeVerifier) {
      throw new Error("xAI OAuth token exchange requires a PKCE code verifier");
    }
    if (!codeChallenge) {
      throw new Error("xAI OAuth token exchange requires the original PKCE code challenge");
    }

    const discovery = await resolveXaiOAuthDiscovery();
    const response = await fetch(discovery.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: buildForm({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        code_challenge: codeChallenge,
        code_challenge_method: config.codeChallengeMethod || "S256",
      }),
    });

    const payload = await readOAuthPayload(response);
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error(
          "xAI OAuth token exchange was rejected with 403. OAuth sign-in may succeed while xAI's backend OAuth API allowlist still blocks the account; use the API-key provider `xai` as a fallback."
        );
      }
      throw new Error(
        `xAI OAuth token exchange failed: ${tokenErrorMessage(payload, response.statusText)}`
      );
    }

    return {
      ...payload,
      token_endpoint: discovery.tokenEndpoint,
      _authFlow: "authorization_code_pkce",
    };
  },

  requestDeviceCode: async (config) => {
    const discovery = await resolveXaiOAuthDiscovery();
    const response = await fetch(discovery.deviceAuthorizationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: buildForm({
        client_id: config.clientId,
        scope: config.scope || XAI_OAUTH_SCOPE,
      }),
    });

    const payload = await readOAuthPayload(response);
    if (!response.ok) {
      throw new Error(
        `xAI device code request failed: ${tokenErrorMessage(payload, response.statusText)}`
      );
    }

    return payload;
  },

  pollToken: async (config, deviceCode) => {
    const discovery = await resolveXaiOAuthDiscovery();
    const response = await fetch(discovery.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: buildForm({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.clientId,
        device_code: deviceCode,
      }),
    });

    const payload = await readOAuthPayload(response);
    const code = firstString(payload.error);
    const stillPending = code === "authorization_pending" || code === "slow_down";

    return {
      ok: response.ok || stillPending,
      data: response.ok
        ? {
            ...payload,
            token_endpoint: discovery.tokenEndpoint,
            _authFlow: "device_code",
          }
        : payload,
    };
  },

  mapTokens: (tokens) => {
    const idClaims = decodeBase64UrlJson(tokens.id_token);
    const accessClaims = decodeBase64UrlJson(tokens.access_token);
    const claims = idClaims || accessClaims || {};
    const email = firstString(claims.email, claims.preferred_username);
    const accountId = firstString(claims.sub, claims.user_id, claims.account_id);
    const displayName = firstString(claims.name, claims.given_name, email, accountId);

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      email,
      displayName,
      name: displayName,
      providerSpecificData: {
        accountId,
        issuer: firstString(claims.iss),
        tokenEndpoint: firstString(tokens.token_endpoint),
        authFlow: firstString(tokens._authFlow) || "authorization_code_pkce",
        scope: tokens.scope,
      },
    };
  },
};
