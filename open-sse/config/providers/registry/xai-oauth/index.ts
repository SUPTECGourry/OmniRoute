import type { RegistryEntry } from "../../shared";
import { resolvePublicCred } from "../../shared";

export const xaiOauthProvider: RegistryEntry = {
  id: "xai-oauth",
  alias: "xai-oauth",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.x.ai/v1/chat/completions",
  authType: "oauth",
  authHeader: "bearer",
  oauth: {
    // tokenUrl used for both initial exchange and refresh
    tokenUrl: "https://auth.x.ai/oauth2/token",
    clientIdEnv: "XAI_OAUTH_CLIENT_ID",
    clientIdDefault: resolvePublicCred("xai_oauth_id"),
  },
  models: [
    { id: "grok-4.3", name: "Grok 4.3" },
  ],
  passthroughModels: true,
};
