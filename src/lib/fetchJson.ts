const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Fetches a URL over HTTPS and parses the JSON reply.
 * Fails clearly on a non-2xx status, invalid JSON, or a timeout.
 * It never retries over plain HTTP, so data cannot be downgraded to an insecure connection.
 */
export async function fetchJson<T>(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "AirWise/1.0 (Urban Air Quality Assistant)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Request failed with status code ${response.status}`);
    }

    try {
      return (await response.json()) as T;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse JSON: ${reason}`);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
