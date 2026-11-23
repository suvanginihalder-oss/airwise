import { z } from "zod";
import type { PersonalizedPlan } from "../../types/index.js";
import { PersonalizedPlanSchema } from "../../types/index.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

/** How long to wait for one Gemini request before giving up (ms). */
const REQUEST_TIMEOUT_MS = 20000;

/** Used when GEMINI_MODEL / GEMINI_FALLBACK_MODELS are not set. Model names change, so prefer the env vars. */
const DEFAULT_MODEL = "gemini-3.5-flash";
const DEFAULT_FALLBACK_MODELS = "gemini-3.5-flash-lite,gemini-flash-lite-latest";

/** HTTP statuses where trying a different model can help (quota, retired model, overload). */
const RETRYABLE_STATUSES = new Set([404, 429, 500, 503]);

/** An error that another model cannot fix, such as a bad key or a malformed request. */
class FatalGeminiError extends Error {}

/**
 * Calls the Gemini REST API and validates the JSON reply with Zod.
 * Tries the primary model first, then each fallback model when a model is out of quota,
 * retired or overloaded. The key is sent in the x-goog-api-key header, never in the URL.
 *
 * @param outputExample optional example JSON that shows the model the exact shape to return
 */
export async function callGeminiJson<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  outputExample?: string,
): Promise<{ data: T; modelUsed: string; fallbackUsed: boolean }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }

  const primaryModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const fallbackModels = (
    process.env.GEMINI_FALLBACK_MODELS || DEFAULT_FALLBACK_MODELS
  )
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const candidateModels = Array.from(new Set([primaryModel, ...fallbackModels]));

  const promptText = outputExample
    ? `${userPrompt}\n\nReturn ONLY a JSON object shaped exactly like this example, replacing the placeholder values:\n${outputExample}`
    : userPrompt;

  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.2,
      topK: 40,
      topP: 0.95,
      responseMimeType: "application/json",
    },
  };

  let lastError: Error | null = null;

  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const status = response.status;
        console.warn(
          `Gemini API error on model ${model} (status ${status}): ${errorText.slice(0, 200)}`,
        );

        if (RETRYABLE_STATUSES.has(status)) {
          lastError = new Error(`Model ${model} returned status ${status}`);
          continue;
        }
        throw new FatalGeminiError(`Gemini API error (status ${status})`);
      }

      const resJson: GeminiResponse = await response.json();
      const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        throw new Error("Empty response received from Gemini");
      }

      const validated = schema.parse(JSON.parse(rawText));
      return { data: validated, modelUsed: model, fallbackUsed: i > 0 };
    } catch (err: unknown) {
      if (err instanceof FatalGeminiError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Error invoking model ${model}: ${msg}`);
      lastError = err instanceof Error ? err : new Error(msg);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error("All Gemini models failed");
}

type RiskLevel = "Low" | "Moderate" | "High" | "Critical";

const BANDS = [
  "Good",
  "Satisfactory",
  "Moderate",
  "Poor",
  "Very Poor",
  "Severe",
] as const;

const GENERAL_RISK: RiskLevel[] = [
  "Low",
  "Low",
  "Moderate",
  "High",
  "Critical",
  "Critical",
];
const SENSITIVE_RISK: RiskLevel[] = [
  "Low",
  "Moderate",
  "High",
  "Critical",
  "Critical",
  "Critical",
];

const MEMBER_ADVICE: Record<
  string,
  { category: string; sensitive: boolean; action: string }
> = {
  children: {
    category: "Children",
    sensitive: true,
    action:
      "Keep outdoor play for the cleaner hours of the day and switch to active indoor games in a room with filtered air when readings are high.",
  },
  elderly: {
    category: "Older adults",
    sensitive: true,
    action:
      "Limit time outdoors when readings are high, wear a well-fitted N95 respirator if you must go out, and keep regular medicines within reach.",
  },
  asthma_respiratory: {
    category: "People with asthma or lung conditions",
    sensitive: true,
    action:
      "Follow your doctor's action plan, keep reliever medication accessible, and avoid exertion outdoors on high-pollution days.",
  },
  heart_condition: {
    category: "People with heart conditions",
    sensitive: true,
    action:
      "Avoid strenuous outdoor activity when readings are high and speak to your doctor about warning symptoms to watch for.",
  },
  pregnancy: {
    category: "Pregnant women",
    sensitive: true,
    action:
      "Reduce time outdoors on high-pollution days, use a well-fitted N95 respirator if you must go out, and talk to your doctor about any concerns.",
  },
  healthy_adult: {
    category: "Healthy adults",
    sensitive: false,
    action:
      "Move intense exercise indoors or to the cleaner hours of the day when readings are high.",
  },
};

/** Index of the band in BANDS. An unknown band is treated as Poor, the cautious middle. */
function bandRank(band: string): number {
  const index = BANDS.findIndex((name) => name === band);
  return index === -1 ? 3 : index;
}

function buildMemberRisks(band: string, members: readonly string[]) {
  const rank = bandRank(band);
  const known = members.filter((member) => member in MEMBER_ADVICE);
  const selected = known.length > 0 ? known : ["healthy_adult"];

  return selected.map((member) => {
    const advice = MEMBER_ADVICE[member];
    const riskLevel = (advice.sensitive ? SENSITIVE_RISK : GENERAL_RISK)[rank];
    return { category: advice.category, riskLevel, action: advice.action };
  });
}

/**
 * Deterministic plan used when Gemini is unavailable or unconfigured.
 * It works offline, uses no invented numbers, and marks itself as a fallback.
 */
export function generateDeterministicPlanFallback(
  city: string,
  band: string,
  members: readonly string[],
): PersonalizedPlan {
  return PersonalizedPlanSchema.parse({
    headline: `Winter Smog Defence Plan for ${city} (${band})`,
    todayRiskSummary: `Air quality in ${city} is currently in the ${band} band. Keep windows sealed when outdoor air is worst, use air filtration indoors, and cut avoidable emissions at home.`,
    memberRisks: buildMemberRisks(band, members),
    lowEmissionRoutine: {
      morning: [
        "Keep street-facing windows and doors closed while outdoor air is at its worst.",
        "Switch on the kitchen exhaust or chimney before lighting the stove so cooking smoke leaves the home.",
        "Check school smog advisories and pack an N95 respirator for children if outdoor travel is unavoidable.",
      ],
      commute: [
        "Where you can, choose metro, bus or a shared ride instead of driving alone.",
        "If you drive, use recirculation mode with a clean cabin filter and avoid idling.",
        "Avoid walking or waiting beside heavy traffic during peak hours.",
      ],
      evening: [
        "Run a purifier or DIY filter fan in the bedroom for an hour or so before sleep, with the door and windows shut.",
        "Wipe floors and surfaces with a damp cloth instead of dry sweeping, which lifts dust back into the air.",
        "Avoid incense sticks, mosquito coils and scented candles indoors.",
      ],
    },
    indoorAirHacks: [
      {
        title: "Choose when to air the house",
        description:
          "Outdoor air is often at its worst in the early morning and late evening in winter. Open windows briefly during the cleanest hours shown in the forecast, and keep them shut the rest of the time.",
        category: "Ventilation",
        costEstimate: "Free",
      },
      {
        title: "Corsi-Rosenthal box (DIY filter fan)",
        description:
          "Tape a MERV 13 or HEPA-grade filter to the intake side of a standard box fan. Home-made filter fans can remove a large share of fine particles from a room at a fraction of the cost of a commercial purifier.",
        category: "Purification",
        costEstimate: "About ₹1,200 to ₹1,800 (estimate)",
      },
      {
        title: "Plants are not air purifiers",
        description:
          "Indoor plants are pleasant, but they do not filter fine particles (PM2.5 or PM10) in any meaningful way. Do not rely on them in place of filtration or source control.",
        category: "Habits",
        costEstimate: "Not applicable",
      },
      {
        title: "Cook with less smoke",
        description:
          "Use the exhaust fan whenever you cook, cover pans while frying, and avoid open-flame roasting without ventilation.",
        category: "Source Reduction",
        costEstimate: "Free",
      },
    ],
    sustainableCommuteSwap: {
      currentMode: "Driving alone",
      suggestedMode: "Metro, bus or a shared ride",
      monthlyCo2SavedKg: 0,
      explanation:
        "Switching solo petrol or diesel trips to public transport or a shared ride lowers tailpipe emissions near your home. The app's commute calculator shows an estimate for your own distance.",
    },
    whyThisMatters:
      "In winter, cold air near the ground can trap vehicle exhaust, construction dust and smoke close to where people live. Cutting your own emissions helps the whole neighbourhood, and cleaner indoor air protects developing and sensitive lungs.",
    isAiGenerated: false,
    fallbackUsed: true,
    generationNotice:
      "Built-in baseline guidance based on the air quality band. AI personalization was unavailable.",
  });
}
