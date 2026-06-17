import type { RegistryEntry } from "../../shared";
import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";

export const sambanovaProvider: RegistryEntry = {
  id: "sambanova",
  alias: "samba",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.sambanova.ai/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.sambanova,
};
