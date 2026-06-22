import type { RegistryEntry } from "../../shared";
import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared";

export const gigachatProvider: RegistryEntry = {
  id: "gigachat",
  alias: "gigachat",
  format: "openai",
  executor: "default",
  baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
  authType: "apikey",
  authHeader: "bearer",
  models: CHAT_OPENAI_COMPAT_MODELS.gigachat,
};
