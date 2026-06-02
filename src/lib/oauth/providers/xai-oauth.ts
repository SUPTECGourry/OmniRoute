import { XAI_OAUTH_CONFIG } from "../constants/oauth";

/**
 * xAI Grok OAuth (SuperGrok / X Premium+)
 *
 * Browser PKCE flow against auth.x.ai (public client_id, loopback or start-callback-server).
 * The resulting access_token is a Bearer token accepted by https://api.x.ai/v1 (chat/completions
 * and other surfaces). No XAI_API_KEY required when the linked X account has Premium+ (or direct
 * SuperGrok subscription).
 *
 * IMPORTANT: uses fixedPort 56121 + callbackPath "/callback" (http://127.0.0.1:56121/callback).
 * This must exactly match the redirect_uri allowlist registered for the public client_id at xAI.
 * See Hermes/OpenClaw/Kilo Code integrations. xAI is strict (127.0.0.1 form required; "localhost" rejected).
 * Flow and endpoints match patterns used by OpenCode, Hermes Agent, Kilo Code, OpenClaw, etc.
 */

/**
 * Decode base64 (URL-safe) with proper UTF-8 handling.
 * (Duplicate of the helper in codex.ts to keep this provider self-contained without pulling jose.)
 */
function base64Decode(str: string): string {
  let base64 = str;
  switch (base64.length % 4) {
    case 2:
      base64 += "==";
      break;
    case 3:
      base64 += "=";
      break;
  }
  base64 = base64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function parseIdTokenForEmail(idToken: string): { email: string | null; displayName: string | null } {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return { email: null, displayName: null };
    const decoded = JSON.parse(base64Decode(parts[1]));
    const email = decoded.email || decoded.preferred_username || decoded.sub || null;
    const displayName = decoded.name || email;
    return { email, displayName };
  } catch {
    return { email: null, displayName: null };
  }
}

export const xaiOauth = {
  config: XAI_OAUTH_CONFIG,
  flowType: "authorization_code_pkce",
  fixedPort: 56121,
  callbackPath: "/callback",

  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params: Record<string, string> = {
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: config.scope,
      code_challenge: codeChallenge,
      code_challenge_method: config.codeChallengeMethod,
      state: state,
    };

    // Merge any extra params (e.g. plan=generic seen in third-party integrations)
    if (config.extraParams) {
      for (const [k, v] of Object.entries(config.extraParams)) {
        params[k] = String(v);
      }
    }

    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    return `${config.authorizeUrl}?${queryString}`;
  },

  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code: code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`xAI OAuth token exchange failed: ${error}`);
    }

    return await response.json();
  },

  mapTokens: (tokens) => {
    let email: string | null = null;
    let displayName: string | null = null;

    // Prefer id_token (standard OIDC claims)
    if (tokens.id_token) {
      const parsed = parseIdTokenForEmail(tokens.id_token);
      email = parsed.email;
      displayName = parsed.displayName;
    }

    // Fallback: some xAI token responses embed claims directly in the access_token JWT
    if (!email && tokens.access_token) {
      const parsed = parseIdTokenForEmail(tokens.access_token);
      email = parsed.email;
      displayName = parsed.displayName;
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresIn: tokens.expires_in,
      email,
      displayName,
      // No special providerSpecificData (unlike Codex workspaces)
    };
  },
};
