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

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_CONTROL = "public, s-maxage=900, stale-while-revalidate=1800";
const MAX_STATION_AGE_MS = 24 * 60 * 60 * 1000;

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

interface OpenAQLocation {
  id: number;
  name: string;
  datetimeLast?: { utc?: string } | null;
  sensors?: Array<{
    id: number;
    parameter?: {
      id?: number;
      name?: string;
      units?: string;
    };
  }>;
}

interface OpenAQLocationsResponse {
  results?: OpenAQLocation[];
}

interface OpenAQLatestResponse {
  results?: Array<{
    sensorsId: number;
    value: number;
    datetime?: { utc?: string };
  }>;
}

interface OpenAQStationReading {
  stationName: string;
  timestamp: string;
  pm2_5: number;
  pm10?: number;
  nitrogen_dioxide?: number;
  sulphur_dioxide?: number;
  ozone?: number;
  carbon_monoxide?: number;
}

function round1(value: number | null | undefined): number {
  return value == null ? 0 : Math.round(value * 10) / 10;
}

function parseUtcMs(utcString: string | undefined): number {
  if (!utcString) return 0;
  const parsed = Date.parse(utcString);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecentUtc(utcString: string | undefined, maxAgeMs: number): boolean {
  const ms = parseUtcMs(utcString);
  return ms > 0 && Date.now() - ms <= maxAgeMs;
}

function isMicrogramsPerCubicMeter(units: string | undefined): boolean {
  if (!units) return true;
  const normalized = units.toLowerCase().replace(/\s+/g, "");
  return (
    normalized.includes("ug/m3") ||
    normalized.includes("µg/m³") ||
    normalized.includes("μg/m³")
  );
}

async function fetchOpenAQCurrent(
  latitude: number,
  longitude: number,
): Promise<{ reading: OpenAQStationReading | null; status: string }> {
  const apiKey = process.env.OPENAQ_API_KEY?.trim();
  if (!apiKey) return { reading: null, status: "openaq-no-key" };

  const headers = { "X-API-Key": apiKey };
  const locUrl = `https://api.openaq.org/v3/locations?coordinates=${latitude},${longitude}&radius=25000&parameters_id=2&limit=100`;

  const locRes = await fetch(locUrl, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!locRes.ok) {
    console.warn(`OpenAQ locations error: ${locRes.status}`);
    return { reading: null, status: `openaq-loc-http-${locRes.status}` };
  }

  const locJson = (await locRes.json()) as OpenAQLocationsResponse;
  const freshStations = (locJson.results ?? []).filter((loc) =>
    isRecentUtc(loc.datetimeLast?.utc, MAX_STATION_AGE_MS),
  );
  if (freshStations.length === 0) {
    return { reading: null, status: "openaq-no-fresh-stations" };
  }

  // Prefer stations with PM10 + newest reading timestamp
  freshStations.sort((a, b) => {
    const aHasPm10 = a.sensors?.some(
      (s) => s.parameter?.name?.toLowerCase() === "pm10" || s.parameter?.id === 1,
    )
      ? 1
      : 0;
    const bHasPm10 = b.sensors?.some(
      (s) => s.parameter?.name?.toLowerCase() === "pm10" || s.parameter?.id === 1,
    )
      ? 1
      : 0;
    if (bHasPm10 !== aHasPm10) return bHasPm10 - aHasPm10;
    return parseUtcMs(b.datetimeLast?.utc) - parseUtcMs(a.datetimeLast?.utc);
  });

  for (const station of freshStations.slice(0, 5)) {
    const sensorMap = new Map(
      (station.sensors ?? []).map((s) => [s.id, s.parameter]),
    );

    const latestRes = await fetch(
      `https://api.openaq.org/v3/locations/${station.id}/latest`,
      { headers, signal: AbortSignal.timeout(8000) },
    );
    if (!latestRes.ok) continue;

    const latestJson = (await latestRes.json()) as OpenAQLatestResponse;
    let pm25: number | undefined;
    let pm10: number | undefined;
    let no2: number | undefined;
    let so2: number | undefined;
    let o3: number | undefined;
    let co: number | undefined;
    let latestTimestamp: string | undefined;

    for (const item of latestJson.results ?? []) {
      if (!Number.isFinite(item.value) || item.value < 0) continue;
      if (
        item.datetime?.utc &&
        !isRecentUtc(item.datetime.utc, MAX_STATION_AGE_MS)
      ) {
        continue;
      }

      const param = sensorMap.get(item.sensorsId);
      const rawName = param?.name?.toLowerCase().replace(/\./g, "");
      const paramId = param?.id;
      if (!isMicrogramsPerCubicMeter(param?.units)) continue;

      if (rawName === "pm25" || paramId === 2) {
        pm25 = round1(item.value);
        latestTimestamp = item.datetime?.utc || latestTimestamp;
      } else if (rawName === "pm10" || paramId === 1) {
        pm10 = round1(item.value);
      } else if (rawName === "no2") {
        no2 = round1(item.value);
      } else if (rawName === "so2") {
        so2 = round1(item.value);
      } else if (rawName === "o3") {
        o3 = round1(item.value);
      } else if (rawName === "co") {
        co = round1(item.value);
      }
    }

    if (pm25 != null) {
      return {
        reading: {
          stationName: station.name,
          timestamp:
            latestTimestamp ||
            station.datetimeLast?.utc ||
            new Date().toISOString(),
          pm2_5: pm25,
          pm10,
          nitrogen_dioxide: no2,
          sulphur_dioxide: so2,
          ozone: o3,
          carbon_monoxide: co,
        },
        status: `openaq:${station.name}`,
      };
    }
  }

  return { reading: null, status: "openaq-no-valid-latest" };
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
    res.setHeader("X-AQ-Source", cached.isModelledEstimate ? "open-meteo-cached" : "openaq-cached");
    return res.status(200).json(cached);
  }

  try {
    let latitude: number;
    let longitude: number;
    let resolvedCityName: string;
    let timezone = "Asia/Kolkata";

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

    const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone&hourly=pm10,pm2_5&forecast_days=2&timezone=${encodeURIComponent(timezone)}`;

    const [openMeteoResult, openAqResult] = await Promise.allSettled([
      fetchJson<OpenMeteoAirQualityResponse>(aqUrl),
      fetchOpenAQCurrent(latitude, longitude),
    ]);

    if (openMeteoResult.status !== "fulfilled") {
      throw openMeteoResult.reason;
    }

    const aqData = openMeteoResult.value;
    const cur = aqData.current;
    if (!cur) {
      throw new Error("Current air quality data missing in Open-Meteo response");
    }
    if (cur.pm2_5 == null || cur.pm10 == null) {
      throw new Error("Particulate readings are unavailable for this location");
    }

    const liveStation =
      openAqResult.status === "fulfilled" ? openAqResult.value.reading : null;
    const aqSource =
      openAqResult.status === "fulfilled"
        ? openAqResult.value.status
        : "openaq-rejected";

    const currentPollutants: CurrentPollutants = {
      pm2_5: liveStation?.pm2_5 ?? round1(cur.pm2_5),
      pm10: liveStation?.pm10 ?? round1(cur.pm10),
      nitrogen_dioxide:
        liveStation?.nitrogen_dioxide ?? round1(cur.nitrogen_dioxide),
      sulphur_dioxide:
        liveStation?.sulphur_dioxide ?? round1(cur.sulphur_dioxide),
      ozone: liveStation?.ozone ?? round1(cur.ozone),
      carbon_monoxide:
        liveStation?.carbon_monoxide ?? round1(cur.carbon_monoxide),
    };

    const aqiResult = computeAQI(currentPollutants);

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
      timestamp: liveStation?.timestamp || cur.time || new Date().toISOString(),
      current: currentPollutants,
      aqi: aqiResult,
      hourly: hourlyItems,
      sourceAttribution: liveStation
        ? `Live station data by OpenAQ (${liveStation.stationName}); 48h forecast by Open-Meteo.com, CAMS ENSEMBLE`
        : "Air quality data by Open-Meteo.com, CAMS ENSEMBLE data provider",
      isModelledEstimate: !liveStation,
      gridResolutionKm: 11,
    };

    setCached(cacheKey, payload, CACHE_TTL_MS);

    res.setHeader("Cache-Control", CACHE_CONTROL);
    res.setHeader("X-AQ-Source", aqSource);
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