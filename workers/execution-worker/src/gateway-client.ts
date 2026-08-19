// Internal HTTP client to the Tool Gateway (17 §1/§4, T40). The execution
// plane NEVER talks to sandbox-manager or the DB directly — every tool
// effect traverses the gateway (S3), which authorizes, audits, dispatches
// and records cost. Transport auth = INTERNAL_API_TOKEN bearer.
import {
  ToolInvokeWireResponseSchema,
  type ToolInvokeWireRequest,
  type ToolInvokeWireResponse,
} from "@acos/contracts";

export type InvokeGateway = (req: ToolInvokeWireRequest) => Promise<ToolInvokeWireResponse>;

/** Thrown on transport/5xx problems — retryable by the Temporal policy;
 *  gateway DECISIONS (deny, failed dispatch) are results, never throws. */
export class GatewayUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayUnreachableError";
  }
}

export function createGatewayClient(options: {
  serverUrl: string;
  internalApiToken: string;
  fetchImpl?: typeof fetch;
}): InvokeGateway {
  const doFetch = options.fetchImpl ?? fetch;
  return async (req) => {
    let res: Response;
    try {
      res = await doFetch(`${options.serverUrl}/internal/v1/tools/invoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(req),
      });
    } catch (err) {
      throw new GatewayUnreachableError(`gateway unreachable: ${String(err)}`);
    }
    if (res.status >= 500) {
      throw new GatewayUnreachableError(`gateway 5xx: ${res.status}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GatewayUnreachableError(`gateway rejected transport: ${res.status} ${text}`);
    }
    return ToolInvokeWireResponseSchema.parse(await res.json());
  };
}
