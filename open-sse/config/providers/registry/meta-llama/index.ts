import type { RegistryEntry } from "../../shared";
import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";

export const meta_llamaProvider: RegistryEntry = {
  id: "meta-llama",
  alias: "meta",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.llama.com/compat/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS["meta-llama"],
};
