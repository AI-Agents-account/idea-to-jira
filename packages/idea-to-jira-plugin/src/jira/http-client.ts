import { JiraFailure } from "./types.js";

export interface JiraHttpClientOptions {
  readonly origin: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface JiraJsonResponse<T> {
  readonly status: number;
  readonly value: T;
}

function safeApiPath(path: string): boolean {
  return path.startsWith("/rest/api/2/") && !path.includes("..") && !path.includes("//") && !/[\r\n]/.test(path);
}

async function boundedBody(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) throw new JiraFailure("JIRA_RESPONSE_TOO_LARGE");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0; let result = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new JiraFailure("JIRA_RESPONSE_TOO_LARGE");
      }
      result += decoder.decode(part.value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally { reader.releaseLock(); }
}

function statusFailure(status: number): JiraFailure {
  if (status === 401) return new JiraFailure("JIRA_UNAUTHORIZED");
  if (status === 403) return new JiraFailure("JIRA_FORBIDDEN");
  if (status === 429) return new JiraFailure("JIRA_RATE_LIMITED");
  if (status >= 500) return new JiraFailure("JIRA_SERVER_ERROR");
  return new JiraFailure("JIRA_REQUEST_REJECTED");
}

export class JiraHttpClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly maximum: number;
  constructor(private readonly options: JiraHttpClientOptions) {
    let origin: URL;
    try { origin = new URL(options.origin); } catch { throw new Error("JIRA_HTTP_CONFIG_INVALID"); }
    if (origin.protocol !== "https:" || origin.origin !== options.origin || origin.pathname !== "/" || origin.username || origin.password || !options.token.trim()) throw new Error("JIRA_HTTP_CONFIG_INVALID");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000) throw new Error("JIRA_HTTP_CONFIG_INVALID");
    this.maximum = options.maxResponseBytes ?? 2_097_152;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1_024 || this.maximum > 16_777_216) throw new Error("JIRA_HTTP_CONFIG_INVALID");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async read<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<JiraJsonResponse<T>> {
    return this.request<T>(path, method, body);
  }

  /** The sole write surface: method and endpoint cannot be selected by a caller/model. */
  async createIssue(fields: Readonly<Record<string, unknown>>): Promise<JiraJsonResponse<unknown>> {
    return this.request("/rest/api/2/issue", "POST", Object.freeze({ fields }));
  }

  private async request<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<JiraJsonResponse<T>> {
    if (!safeApiPath(path)) throw new JiraFailure("JIRA_MALFORMED", true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, `${this.options.origin}/`), {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: Object.freeze({
          accept: "application/json",
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new JiraFailure("JIRA_TIMEOUT", false, { cause: error });
      throw new JiraFailure("JIRA_NETWORK_ERROR", false, { cause: error });
    } finally { clearTimeout(timeout); }
    if (response.status >= 300 && response.status < 400) throw new JiraFailure("JIRA_REDIRECT_DENIED");
    const raw = await boundedBody(response, this.maximum);
    if (!response.ok) throw statusFailure(response.status);
    let value: unknown;
    try { value = raw.length === 0 ? {} : JSON.parse(raw); }
    catch (error) { throw new JiraFailure("JIRA_MALFORMED", false, { cause: error }); }
    return Object.freeze({ status: response.status, value: value as T });
  }
}
