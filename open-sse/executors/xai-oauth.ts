import { XAI_OAUTH_RESPONSES_URL, validateXaiApiEndpoint } from "../config/xaiOAuth.ts";
import { DefaultExecutor } from "./default.ts";
import type { ExecuteInput, ProviderCredentials } from "./base.ts";

export class XaiOAuthExecutor extends DefaultExecutor {
  constructor() {
    super("xai-oauth");
  }

  buildUrl(
    model: string,
    stream: boolean,
    urlIndex = 0,
    credentials: ProviderCredentials | null = null
  ) {
    void model;
    void stream;
    void urlIndex;
    void credentials;
    return validateXaiApiEndpoint(XAI_OAUTH_RESPONSES_URL, "xAI OAuth inference endpoint");
  }

  needsRefresh(credentials?: ProviderCredentials | null) {
    if (credentials?.providerSpecificData?.refreshTokenDead === true) return false;
    if (credentials?.refreshToken) return true;
    return super.needsRefresh(credentials);
  }

  async execute(input: ExecuteInput) {
    const url = this.buildUrl(input.model, input.stream, 0, input.credentials);
    validateXaiApiEndpoint(url, "xAI OAuth inference endpoint");
    return super.execute(input);
  }
}
