// Minimal HTTP JSON client for the in-container ACOS kit (hook + MCP shim).
// Workspace containers have NO default route: everything leaves through the
// egress proxy (HTTP_PROXY, 27 §12). Node's global fetch ignores HTTP_PROXY,
// so this speaks plain http with the proxy's absolute-URI form when a proxy is
// configured and the target is not in NO_PROXY. http:// targets only — every
// ACOS internal surface the kit talks to is plain http behind the proxy.
import { request as httpRequest } from "node:http";

function proxyFor(target) {
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return null;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const host = target.hostname;
  for (const rule of noProxy) {
    if (rule === "*" || host === rule || host.endsWith(rule.startsWith(".") ? rule : `.${rule}`)) return null;
  }
  return new URL(proxy);
}

/**
 * POST/GET JSON. Resolves {status, body(parsed or text)}; rejects on transport
 * error or timeout. Never throws on non-2xx — callers decide.
 */
export function requestJson(method, url, { headers = {}, body, timeoutMs = 15_000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:") return Promise.reject(new Error(`only http:// is supported in-container (got ${target.protocol})`));
  const proxy = proxyFor(target);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const opts = proxy
    ? { hostname: proxy.hostname, port: proxy.port || 80, path: target.href, method }
    : { hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method };
  opts.headers = {
    host: target.host,
    accept: "application/json",
    ...(payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {}),
    ...headers,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(opts, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let parsed = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* keep text */
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
