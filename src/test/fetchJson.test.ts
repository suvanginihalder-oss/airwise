import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchJson } from "../lib/fetchJson";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockFetchOnce(response: Partial<Response>) {
  const fetchMock = vi.fn().mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchJson", () => {
  it("returns the parsed JSON body", async () => {
    mockFetchOnce({ ok: true, status: 200, json: async () => ({ value: 42 }) });
    await expect(fetchJson<{ value: number }>("https://example.com/a")).resolves.toEqual({
      value: 42,
    });
  });

  it("sends a User-Agent and asks for JSON", async () => {
    const fetchMock = mockFetchOnce({ ok: true, status: 200, json: async () => ({}) });
    await fetchJson("https://example.com/a");
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/a");
    const headers = options.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("AirWise");
    expect(headers.Accept).toBe("application/json");
  });

  it("rejects with the status code for a non-2xx reply", async () => {
    mockFetchOnce({ ok: false, status: 503 });
    await expect(fetchJson("https://example.com/a")).rejects.toThrow(
      "Request failed with status code 503",
    );
  });

  it("rejects when the body is not valid JSON", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(fetchJson("https://example.com/a")).rejects.toThrow(
      "Failed to parse JSON",
    );
  });

  it("does not retry over plain HTTP after a failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchJson("https://example.com/a")).rejects.toThrow(
      "connection reset",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a timeout when the request is aborted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      ),
    );

    const pending = fetchJson("https://example.com/slow", 5000);
    const assertion = expect(pending).rejects.toThrow("Request timed out after 5000 ms");
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});
