import type { RegistryEntry } from "../../shared";
import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";

export const friendliaiProvider: RegistryEntry = {
  id: "friendliai",
  alias: "friendli",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.friendli.ai/dedicated/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.friendliai,
};
