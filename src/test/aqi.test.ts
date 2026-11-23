import { describe, it, expect } from "vitest";
import {
  calculateSubIndex,
  computeAQI,
  getAQIBand,
  getBandDetails,
  WHO_GUIDELINES,
} from "../lib/aqi";

// The breakpoint tables are the same ones used in aqi.ts (CPCB national AQI).
const PM25 = [
  { bLo: 0, bHi: 30, iLo: 0, iHi: 50 },
  { bLo: 31, bHi: 60, iLo: 51, iHi: 100 },
  { bLo: 61, bHi: 90, iLo: 101, iHi: 200 },
  { bLo: 91, bHi: 120, iLo: 201, iHi: 300 },
  { bLo: 121, bHi: 250, iLo: 301, iHi: 400 },
  { bLo: 251, bHi: 500, iLo: 401, iHi: 500 },
];
const PM10 = [
  { bLo: 0, bHi: 50, iLo: 0, iHi: 50 },
  { bLo: 51, bHi: 100, iLo: 51, iHi: 100 },
  { bLo: 101, bHi: 250, iLo: 101, iHi: 200 },
  { bLo: 251, bHi: 350, iLo: 201, iHi: 300 },
  { bLo: 351, bHi: 430, iLo: 301, iHi: 400 },
  { bLo: 431, bHi: 600, iLo: 401, iHi: 500 },
];

describe("calculateSubIndex", () => {
  it("returns 0 for zero or negative concentrations", () => {
    expect(calculateSubIndex(0, PM25)).toBe(0);
    expect(calculateSubIndex(-5, PM25)).toBe(0);
  });

  it("hits the top of every PM2.5 band exactly", () => {
    expect(calculateSubIndex(30, PM25)).toBe(50);
    expect(calculateSubIndex(60, PM25)).toBe(100);
    expect(calculateSubIndex(90, PM25)).toBe(200);
    expect(calculateSubIndex(120, PM25)).toBe(300);
    expect(calculateSubIndex(250, PM25)).toBe(400);
    expect(calculateSubIndex(500, PM25)).toBe(500);
  });

  it("hits the top of every PM10 band exactly", () => {
    expect(calculateSubIndex(50, PM10)).toBe(50);
    expect(calculateSubIndex(100, PM10)).toBe(100);
    expect(calculateSubIndex(250, PM10)).toBe(200);
    expect(calculateSubIndex(350, PM10)).toBe(300);
    expect(calculateSubIndex(430, PM10)).toBe(400);
  });

  it("starts each new band at the first index value of that band", () => {
    expect(calculateSubIndex(31, PM25)).toBe(51);
    expect(calculateSubIndex(251, PM25)).toBe(401);
    expect(calculateSubIndex(431, PM10)).toBe(401);
  });

  it("interpolates inside a band", () => {
    expect(calculateSubIndex(45, PM25)).toBe(75);
    expect(calculateSubIndex(300, PM10)).toBe(250);
  });

  it("caps the index at 500 above the highest breakpoint", () => {
    expect(calculateSubIndex(900, PM25)).toBe(500);
    expect(calculateSubIndex(2000, PM10)).toBe(500);
  });

  it("rejects values that are not real numbers", () => {
    expect(() => calculateSubIndex(Number.NaN, PM25)).toThrow(RangeError);
    expect(() => calculateSubIndex(Number.POSITIVE_INFINITY, PM25)).toThrow(
      RangeError,
    );
  });
});

describe("getAQIBand", () => {
  it("maps every edge of every band", () => {
    const cases: Array<[number, string]> = [
      [0, "Good"],
      [50, "Good"],
      [51, "Satisfactory"],
      [100, "Satisfactory"],
      [101, "Moderate"],
      [200, "Moderate"],
      [201, "Poor"],
      [300, "Poor"],
      [301, "Very Poor"],
      [400, "Very Poor"],
      [401, "Severe"],
      [500, "Severe"],
    ];
    for (const [aqi, band] of cases) {
      expect(getAQIBand(aqi)).toBe(band);
    }
  });
});

describe("getBandDetails", () => {
  it("gives every band a label that includes its range and a description", () => {
    const bands = [
      "Good",
      "Satisfactory",
      "Moderate",
      "Poor",
      "Very Poor",
      "Severe",
    ] as const;
    for (const band of bands) {
      const details = getBandDetails(band);
      expect(details.label).toContain(band);
      expect(details.label).toMatch(/\d+–\d+/);
      expect(details.description.length).toBeGreaterThan(10);
      expect(details.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("computeAQI", () => {
  it("uses the higher of the PM2.5 and PM10 sub-indices", () => {
    const result = computeAQI({ pm2_5: 100, pm10: 100 });
    expect(result.subIndices.pm25).toBe(232);
    expect(result.subIndices.pm10).toBe(100);
    expect(result.aqi).toBe(232);
    expect(result.band).toBe("Poor");
    expect(result.prominentPollutant).toBe("PM2.5");
  });

  it("reports PM10 as the prominent pollutant when it dominates", () => {
    const result = computeAQI({ pm2_5: 10, pm10: 300 });
    expect(result.aqi).toBe(250);
    expect(result.prominentPollutant).toBe("PM10");
  });

  it("reports clean air as Good", () => {
    const result = computeAQI({ pm2_5: 0, pm10: 0 });
    expect(result.aqi).toBe(0);
    expect(result.band).toBe("Good");
  });

  it("never shows 0 when some particulate is present", () => {
    const result = computeAQI({ pm2_5: 0.2, pm10: 0.2 });
    expect(result.aqi).toBe(1);
  });

  it("flags Severe air at very high readings", () => {
    const result = computeAQI({ pm2_5: 400, pm10: 600 });
    expect(result.band).toBe("Severe");
    expect(result.aqi).toBeGreaterThanOrEqual(401);
  });

  it("compares readings with the WHO 24-hour guideline values", () => {
    const result = computeAQI({ pm2_5: 30, pm10: 90 });
    expect(result.whoComparisons.pm25Ratio).toBe(2);
    expect(result.whoComparisons.pm10Ratio).toBe(2);
    expect(result.whoComparisons.pm25Exceeds).toBe(true);
    expect(result.whoComparisons.pm10Exceeds).toBe(true);
  });

  it("does not flag a reading exactly at the WHO guideline", () => {
    const result = computeAQI({
      pm2_5: WHO_GUIDELINES.PM25_24H_LIMIT,
      pm10: WHO_GUIDELINES.PM10_24H_LIMIT,
    });
    expect(result.whoComparisons.pm25Ratio).toBe(1);
    expect(result.whoComparisons.pm25Exceeds).toBe(false);
    expect(result.whoComparisons.pm10Exceeds).toBe(false);
  });

  it("ignores the secondary gases when calculating the index", () => {
    const base = computeAQI({ pm2_5: 80, pm10: 120 });
    const withGases = computeAQI({
      pm2_5: 80,
      pm10: 120,
      nitrogen_dioxide: 400,
      sulphur_dioxide: 400,
      ozone: 400,
      carbon_monoxide: 9000,
    });
    expect(withGases.aqi).toBe(base.aqi);
  });
});
