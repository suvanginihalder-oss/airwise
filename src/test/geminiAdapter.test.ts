import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  callGeminiJson,
  generateDeterministicPlanFallback,
} from "../lib/ai/geminiAdapter";
import { PersonalizedPlanSchema } from "../types/index";

const VALID_PLAN = {
  headline: "Stay safe",
  todayRiskSummary: "High pollution today.",
  memberRisks: [],
  lowEmissionRoutine: { morning: ["Seal windows"], commute: [], evening: [] },
  indoorAirHacks: [],
  sustainableCommuteSwap: {},
  whyThisMatters: "Inversions trap smog.",
};

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }],
    }),
    text: async () => "",
  };
}

function errorResponse(status: number, text = "error") {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.stubEnv("GEMINI_MODEL", "");
  vi.stubEnv("GEMINI_FALLBACK_MODELS", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("callGeminiJson", () => {
  it("throws when no API key is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(
      callGeminiJson("system", "user", PersonalizedPlanSchema),
    ).rejects.toThrow("GEMINI_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the default model and returns validated data", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(VALID_PLAN));
    const result = await callGeminiJson("system", "user", PersonalizedPlanSchema);

    expect(result.data.headline).toBe("Stay safe");
    expect(result.modelUsed).toBe("gemini-3.5-flash");
    expect(result.fallbackUsed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the key in a header and the system prompt as a system instruction", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(VALID_PLAN));
    await callGeminiJson("SYSTEM TEXT", "USER TEXT", PersonalizedPlanSchema);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("test-key");
    expect(url).toContain(":generateContent");
    expect((options.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "test-key",
    );

    const body = JSON.parse(options.body as string);
    expect(body.systemInstruction.parts[0].text).toBe("SYSTEM TEXT");
    expect(body.contents[0].parts[0].text).toContain("USER TEXT");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("adds the output example to the prompt when one is given", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(VALID_PLAN));
    await callGeminiJson("system", "user", PersonalizedPlanSchema, '{"example":true}');

    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(options.body as string);
    expect(body.contents[0].parts[0].text).toContain('{"example":true}');
  });

  it("uses GEMINI_MODEL when it is set", async () => {
    vi.stubEnv("GEMINI_MODEL", "my-custom-model");
    fetchMock.mockResolvedValueOnce(okResponse(VALID_PLAN));
    const result = await callGeminiJson("system", "user", PersonalizedPlanSchema);

    expect(result.modelUsed).toBe("my-custom-model");
    expect(fetchMock.mock.calls[0][0]).toContain("my-custom-model:generateContent");
  });

  it("moves to the next model when the first is out of quota", async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, "quota exceeded"))
      .mockResolvedValueOnce(okResponse(VALID_PLAN));
    const result = await callGeminiJson("system", "user", PersonalizedPlanSchema);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.modelUsed).toBe("gemini-3.5-flash-lite");
    expect(result.fallbackUsed).toBe(true);
  });

  it("moves on when a model has been retired (404)", async () => {
    vi.stubEnv("GEMINI_FALLBACK_MODELS", "backup-model");
    fetchMock
      .mockResolvedValueOnce(errorResponse(404))
      .mockResolvedValueOnce(okResponse(VALID_PLAN));
    const result = await callGeminiJson("system", "user", PersonalizedPlanSchema);
    expect(result.modelUsed).toBe("backup-model");
  });

  it("does not list the same model twice", async () => {
    vi.stubEnv("GEMINI_MODEL", "model-a");
    vi.stubEnv("GEMINI_FALLBACK_MODELS", "model-a, model-b");
    fetchMock.mockResolvedValue(errorResponse(429));
    await expect(
      callGeminiJson("system", "user", PersonalizedPlanSchema),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops at once on an error another model cannot fix", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400));
    await expect(
      callGeminiJson("system", "user", PersonalizedPlanSchema),
    ).rejects.toThrow("status 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails after every model has failed", async () => {
    fetchMock.mockResolvedValue(errorResponse(503));
    await expect(
      callGeminiJson("system", "user", PersonalizedPlanSchema),
    ).rejects.toThrow("status 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("tries the next model when the reply is empty", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [] }),
        text: async () => "",
      })
      .mockResolvedValueOnce(okResponse(VALID_PLAN));
    const result = await callGeminiJson("system", "user", PersonalizedPlanSchema);
    expect(result.fallbackUsed).toBe(true);
  });
});

describe("generateDeterministicPlanFallback", () => {
  it("marks itself as an offline fallback and passes the plan schema", () => {
    const plan = generateDeterministicPlanFallback("Pune", "Poor", ["children"]);
    expect(PersonalizedPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.isAiGenerated).toBe(false);
    expect(plan.fallbackUsed).toBe(true);
    expect(plan.headline).toContain("Pune");
    expect(plan.headline).toContain("Poor");
  });

  it("only lists the household groups that were selected", () => {
    const plan = generateDeterministicPlanFallback("Pune", "Poor", [
      "children",
      "elderly",
    ]);
    expect(plan.memberRisks.map((risk) => risk.category)).toEqual([
      "Children",
      "Older adults",
    ]);
  });

  it("raises the risk level for sensitive groups as the air gets worse", () => {
    const severe = generateDeterministicPlanFallback("Pune", "Severe", [
      "children",
      "healthy_adult",
    ]);
    expect(severe.memberRisks[0]?.riskLevel).toBe("Critical");
    expect(severe.memberRisks[1]?.riskLevel).toBe("Critical");

    const satisfactory = generateDeterministicPlanFallback(
      "Pune",
      "Satisfactory",
      ["children", "healthy_adult"],
    );
    expect(satisfactory.memberRisks[0]?.riskLevel).toBe("Moderate");
    expect(satisfactory.memberRisks[1]?.riskLevel).toBe("Low");
  });

  it("falls back to a general adult entry for unknown groups", () => {
    const plan = generateDeterministicPlanFallback("Pune", "Moderate", ["unknown"]);
    expect(plan.memberRisks.length).toBe(1);
    expect(plan.memberRisks[0]?.category).toBe("Healthy adults");
  });

  it("treats an unknown band as the cautious middle", () => {
    const plan = generateDeterministicPlanFallback("Pune", "Mystery", ["children"]);
    expect(plan.memberRisks[0]?.riskLevel).toBe("Critical");
  });

  it("does not mention Delhi or invented savings for other cities", () => {
    const plan = generateDeterministicPlanFallback("Pune", "Poor", ["children"]);
    expect(JSON.stringify(plan)).not.toContain("Delhi");
    expect(plan.sustainableCommuteSwap.monthlyCo2SavedKg).toBe(0);
  });

  it("includes routine steps and indoor tips", () => {
    const plan = generateDeterministicPlanFallback("Pune", "Poor", ["children"]);
    expect(plan.lowEmissionRoutine.morning.length).toBeGreaterThan(0);
    expect(plan.lowEmissionRoutine.commute.length).toBeGreaterThan(0);
    expect(plan.lowEmissionRoutine.evening.length).toBeGreaterThan(0);
    expect(plan.indoorAirHacks.length).toBeGreaterThanOrEqual(3);
  });
});
