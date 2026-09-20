import { sleep } from "@yc/shared";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface RetryOpts {
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

/** JSON client for the analytics service. Retries network errors, 429 and 5xx with exponential backoff. */
export class AnalyticsClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
    private opts: RetryOpts = {},
  ) {}

  async post<T>(path: string, body: unknown): Promise<T> {
    const { retries = 4, baseDelayMs = 500, timeoutMs = 20_000 } = this.opts;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return (await res.json()) as T;
        const text = await res.text().catch(() => "");
        const err = new HttpError(res.status, `analytics ${path} -> ${res.status} ${text.slice(0, 200)}`);
        if (res.status < 500 && res.status !== 429) throw err; // client errors are not retryable
        lastErr = err;
      } catch (e) {
        if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
        lastErr = e;
      }
      if (attempt < retries) await sleep(baseDelayMs * 2 ** attempt);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
