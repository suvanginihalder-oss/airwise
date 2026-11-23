import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { findIndexedCity } from "./src/lib/cityIndex.js";

interface VercelLikeRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[]>;
}

interface VercelLikeResponse extends ServerResponse {
  status: (code: number) => VercelLikeResponse;
  json: (payload: unknown) => VercelLikeResponse;
}

type VercelHandler = (
  req: VercelLikeRequest,
  res: VercelLikeResponse,
) => Promise<unknown> | unknown;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const maxBytes = 1024 * 1024;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });

    req.on("error", reject);
  });
}

function enhanceVercelResponse(res: ServerResponse): VercelLikeResponse {
  const enhanced = res as VercelLikeResponse;
  enhanced.status = (code: number): VercelLikeResponse => {
    enhanced.statusCode = code;
    return enhanced;
  };
  enhanced.json = (payload: unknown): VercelLikeResponse => {
    if (!enhanced.headersSent) {
      enhanced.setHeader("Content-Type", "application/json");
    }
    enhanced.end(JSON.stringify(payload));
    return enhanced;
  };
  return enhanced;
}

function httpGetJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (r) => {
        let data = "";
        r.on("data", (c: Buffer | string) => {
          data += c.toString();
        });
        r.on("end", () => {
          try {
            resolve(JSON.parse(data) as Record<string, unknown>);
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

function devApiPlugin(): Plugin {
  const localCache = new Map<string, { data: unknown; exp: number }>();

  return {
    name: "dev-api-middleware",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) {
          return next();
        }

        const urlObj = new URL(req.url, "http://localhost:5173");
        const pathname = urlObj.pathname;

        if (pathname === "/api/chat" || pathname === "/api/generate-plan") {
          try {
            const vReq = req as VercelLikeRequest;
            if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
              vReq.body = await readJsonBody(req);
            }
            const vRes = enhanceVercelResponse(res);
            const mod = (await server.ssrLoadModule(`${pathname}.ts`)) as {
              default?: VercelHandler;
            };
            if (typeof mod.default !== "function") {
              vRes.status(500).json({ error: `Missing default export in ${pathname}.ts` });
              return;
            }
            await mod.default(vReq, vRes);
            return;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Server error";
            if (!res.writableEnded) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: message }));
            }
            return;
          }
        }

        if (pathname === "/api/air-quality") {
          const cityQuery = (urlObj.searchParams.get("city") || "Delhi").trim();
          const cacheKey = cityQuery.toLowerCase();

          const hit = localCache.get(cacheKey);
          if (hit && Date.now() < hit.exp) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify(hit.data));
          }

          try {
            let lat = 28.65;
            let lon = 77.23;
            let resolvedName = "Delhi";
            let tz = "Asia/Kolkata";

            const found = findIndexedCity(cityQuery);
            if (found) {
              lat = found.latitude;
              lon = found.longitude;
              resolvedName = found.city;
              tz = found.timezone;
            } else {
              const geoRes = await httpGetJson(
                `http://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityQuery)}&count=1&language=en&format=json`,
              );
              const results = geoRes.results as
                | Array<{
                    latitude: number;
                    longitude: number;
                    name: string;
                    timezone?: string;
                  }>
                | undefined;

              if (!results || results.length === 0) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "application/json");
                return res.end(
                  JSON.stringify({ error: `City "${cityQuery}" not found` }),
                );
              }

              lat = results[0].latitude;
              lon = results[0].longitude;
              resolvedName = results[0].name;
              tz = results[0].timezone || "Asia/Kolkata";
            }

            const aqRes = await httpGetJson(
              `http://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone&hourly=pm10,pm2_5&forecast_days=2&timezone=${encodeURIComponent(tz)}`,
            );

            const cur = (aqRes.current ?? {}) as Record<string, unknown>;
            const curP = {
              pm2_5: Math.round(Number(cur.pm2_5 ?? 0)),
              pm10: Math.round(Number(cur.pm10 ?? 0)),
              nitrogen_dioxide: Math.round(Number(cur.nitrogen_dioxide ?? 0)),
              sulphur_dioxide: Math.round(Number(cur.sulphur_dioxide ?? 0)),
              ozone: Math.round(Number(cur.ozone ?? 0)),
              carbon_monoxide: Math.round(Number(cur.carbon_monoxide ?? 0)),
            };

            const pm25Sub = Math.min(500, Math.round((curP.pm2_5 / 30) * 50));
            const pm10Sub = Math.min(500, Math.round((curP.pm10 / 50) * 50));
            const aqiVal = Math.max(pm25Sub, pm10Sub);
            const bandVal =
              aqiVal <= 50
                ? "Good"
                : aqiVal <= 100
                  ? "Satisfactory"
                  : aqiVal <= 200
                    ? "Moderate"
                    : aqiVal <= 300
                      ? "Poor"
                      : aqiVal <= 400
                        ? "Very Poor"
                        : "Severe";

            const hourly = (aqRes.hourly ?? {}) as {
              time?: string[];
              pm2_5?: number[];
              pm10?: number[];
            };
            const hourlyItems = (hourly.time || []).map((t, i) => {
              const p25 = Math.round(hourly.pm2_5?.[i] ?? 0);
              const p10 = Math.round(hourly.pm10?.[i] ?? 0);
              return {
                time: t,
                pm2_5: p25,
                pm10: p10,
                aqi: Math.max(
                  Math.min(500, Math.round((p25 / 30) * 50)),
                  Math.min(500, Math.round((p10 / 50) * 50)),
                ),
                band: bandVal,
              };
            });

            const payload = {
              city: resolvedName,
              latitude: lat,
              longitude: lon,
              timezone: tz,
              timestamp:
                typeof cur.time === "string" ? cur.time : new Date().toISOString(),
              current: curP,
              aqi: {
                aqi: aqiVal,
                band: bandVal,
                prominentPollutant: pm25Sub >= pm10Sub ? "PM2.5" : "PM10",
                subIndices: { pm25: pm25Sub, pm10: pm10Sub },
                whoComparisons: {
                  pm25Ratio: Number((curP.pm2_5 / 15).toFixed(1)),
                  pm10Ratio: Number((curP.pm10 / 45).toFixed(1)),
                  pm25Exceeds: curP.pm2_5 > 15,
                  pm10Exceeds: curP.pm10 > 45,
                },
              },
              hourly: hourlyItems,
              sourceAttribution:
                "Air quality data by Open-Meteo.com, CAMS ENSEMBLE data provider",
              isModelledEstimate: true,
              gridResolutionKm: 11,
            };

            localCache.set(cacheKey, {
              data: payload,
              exp: Date.now() + 15 * 60 * 1000,
            });

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify(payload));
          } catch (e: unknown) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            const msg = e instanceof Error ? e.message : "Server error";
            return res.end(JSON.stringify({ error: msg }));
          }
        }

        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return {
    plugins: [react(), devApiPlugin()],
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ["react", "react-dom"],
            charts: ["recharts"],
            icons: ["lucide-react"],
          },
        },
      },
      chunkSizeWarningLimit: 600,
    },
    test: {
      globals: true,
      environment: "happy-dom",
      setupFiles: ["./src/test/setup.ts"],
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        include: ["src/lib/**"],
      },
    },
  };
});