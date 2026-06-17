import type { RegistryEntry } from "../../shared";
import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";

export const basetenProvider: RegistryEntry = {
  id: "baseten",
  alias: "baseten",
  format: "openai",
  executor: "default",
  baseUrl: "https://inference.baseten.co/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.baseten,
};
