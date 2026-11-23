import type { VercelRequest, VercelResponse } from "@vercel/node";
import { computeAQI } from "../src/lib/aqi.js";
import { checkRateLimit, getCached, setCached } from "../src/lib/rateLimit.js";
import { fetchJson } from "../src/lib/fetchJson.js";
import { findIndexedCity } from "../src/lib/cityIndex.js";
import { getClientIp } from "../src/lib/clientIp.js";
import type {
  AirQualityData,
  CurrentPollutants,
  HourlyForecastItem,
} from "../src/types/index.js";

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_CONTROL = "public, s-maxage=900, stale-while-revalidate=1800";

interface GeocodingResult {
  results?: Array<{
    id: number;
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    admin1?: string;
    timezone?: string;
  }>;
}

/** Open-Meteo returns null for readings it does not have, so every value may be null. */
interface OpenMeteoAirQualityResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  current?: {
    time: string;
    pm2_5: number | null;
    pm10: number | null;
    nitrogen_dioxide?: number | null;
    sulphur_dioxide?: number | null;
    ozone?: number | null;
    carbon_monoxide?: number | null;
  };
  hourly?: {
    time: string[];
    pm2_5: Array<number | null>;
    pm10: Array<number | null>;
  };
}

/** Rounds to one decimal place. Only used for the secondary gases, where a missing value shows as 0. */
function round1(value: number | null | undefined): number {
  return value == null ? 0 : Math.round(value * 10) / 10;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { allowed } = checkRateLimit(getClientIp(req), 60, 60000);
  if (!allowed) {
    return res.status(429).json({
      error:
        "Rate limit exceeded. Please wait a moment before refreshing air quality data.",
    });
  }

  const city = ((req.query.city as string) || "Delhi").trim();
  if (city.length < 2 || city.length > 60) {
    return res.status(400).json({
      error: "Invalid city name parameter (2-60 characters required).",
    });
  }

  const cacheKey = `aq_${city.toLowerCase()}`;
  const cached = getCached<AirQualityData>(cacheKey);
  if (cached) {
    res.setHeader("Cache-Control", CACHE_CONTROL);
    return res.status(200).json(cached);
  }

  try {
    let latitude: number;
    let longitude: number;
    let resolvedCityName: string;
    let timezone = "Asia/Kolkata";

    // 1. Pre-indexed coordinates skip the geocoding request for common cities
    const indexed = findIndexedCity(city);
    if (indexed) {
      latitude = indexed.latitude;
      longitude = indexed.longitude;
      resolvedCityName = indexed.city;
      timezone = indexed.timezone;
    } else {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
      const geoData = await fetchJson<GeocodingResult>(geoUrl);

      const match = geoData.results?.[0];
      if (!match) {
        return res
          .status(404)
          .json({ error: `City "${city}" not found. Please verify spelling.` });
      }

      latitude = match.latitude;
      longitude = match.longitude;
      resolvedCityName = match.name;
      timezone = match.timezone || "auto";
    }

    // 2. Current and 48-hour hourly air quality from the Open-Meteo Air Quality API
    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone&hourly=pm10,pm2_5&forecast_days=2&timezone=${encodeURIComponent(timezone)}`;
    const aqData = await fetchJson<OpenMeteoAirQualityResponse>(aqUrl);

    const cur = aqData.current;
    if (!cur) {
      throw new Error("Current air quality data missing in Open-Meteo response");
    }
    // Never turn a missing particulate reading into 0: that would show "Good" air by mistake.
    if (cur.pm2_5 == null || cur.pm10 == null) {
      throw new Error("Particulate readings are unavailable for this location");
    }

    const currentPollutants: CurrentPollutants = {
      pm2_5: round1(cur.pm2_5),
      pm10: round1(cur.pm10),
      nitrogen_dioxide: round1(cur.nitrogen_dioxide),
      sulphur_dioxide: round1(cur.sulphur_dioxide),
      ozone: round1(cur.ozone),
      carbon_monoxide: round1(cur.carbon_monoxide),
    };

    const aqiResult = computeAQI(currentPollutants);

    // Hours with a missing particulate value are skipped, not set to 0,
    // so the forecast never shows a false "best hour".
    const hourlyItems: HourlyForecastItem[] = [];
    const times = aqData.hourly?.time ?? [];
    const pm25s = aqData.hourly?.pm2_5 ?? [];
    const pm10s = aqData.hourly?.pm10 ?? [];

    for (let i = 0; i < times.length; i++) {
      const p25 = pm25s[i];
      const p10 = pm10s[i];
      if (p25 == null || p10 == null) continue;

      const pm2_5 = round1(p25);
      const pm10 = round1(p10);
      const subAqi = computeAQI({ pm2_5, pm10 });
      hourlyItems.push({
        time: times[i],
        pm2_5,
        pm10,
        aqi: subAqi.aqi,
        band: subAqi.band,
      });
    }

    const payload: AirQualityData = {
      city: resolvedCityName,
      latitude,
      longitude,
      timezone: aqData.timezone || timezone,
      timestamp: cur.time || new Date().toISOString(),
      current: currentPollutants,
      aqi: aqiResult,
      hourly: hourlyItems,
      sourceAttribution:
        "Air quality data by Open-Meteo.com, CAMS ENSEMBLE data provider",
      isModelledEstimate: true,
      gridResolutionKm: 11,
    };

    setCached(cacheKey, payload, CACHE_TTL_MS);

    res.setHeader("Cache-Control", CACHE_CONTROL);
    return res.status(200).json(payload);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch air quality data";
    console.error(`Air quality fetch error for city "${city}": ${message}`);
    return res.status(502).json({
      error:
        "Could not retrieve live air quality data right now. Please try again shortly.",
    });
  }
}
