import type { RegistryEntry } from "../../shared.ts";
import { resolvePublicCred } from "../../shared.ts";
import {
  XAI_OAUTH_MODELS_URL,
  XAI_OAUTH_RESPONSES_URL,
  XAI_OAUTH_TOKEN_URL,
} from "../../../xaiOAuth.ts";

export const xai_oauthProvider: RegistryEntry = {
  id: "xai-oauth",
  alias: "xai-oauth",
  format: "openai-responses",
  executor: "xai-oauth",
  baseUrl: XAI_OAUTH_RESPONSES_URL,
  modelsUrl: XAI_OAUTH_MODELS_URL,
  authType: "oauth",
  authHeader: "bearer",
  oauth: {
    clientIdEnv: "XAI_OAUTH_CLIENT_ID",
    clientIdDefault: resolvePublicCred("xai_id"),
    tokenUrl: XAI_OAUTH_TOKEN_URL,
    refreshUrl: XAI_OAUTH_TOKEN_URL,
  },
  models: [
    { id: "grok-build-0.1", name: "Grok Build 0.1", contextLength: 256000 },
    { id: "grok-4.3", name: "Grok 4.3" },
    { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 Reasoning", supportsReasoning: true },
    { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20" },
    {
      id: "grok-4.20-multi-agent-0309",
      name: "Grok 4.20 Multi Agent",
      toolCalling: false,
    },
  ],
};
