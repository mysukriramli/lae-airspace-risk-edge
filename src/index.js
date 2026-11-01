import { latLngToCell } from "h3-js";
import { calculateWindShear, calculateGroundRiskClass, resolveSafeAltitudeBand } from "./physics.js";
import { fetchSurfaceAeroMeteo } from "./sensors.js";
import { generateClearanceHash } from "./crypto.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

const H3_RES = 8; // ~460m hexagon edge diameter

async function evaluatePointClearance(lat, lon, params) {
  const h3Cell = latLngToCell(lat, lon, H3_RES);
  const altRequested = parseFloat(params.alt_m || "60");
  const droneMassKg = parseFloat(params.drone_mass_kg || "5.0");
  const maxVehicleWindMs = parseFloat(params.max_wind_limit_ms || "12.0");
  const terrainType = params.terrain || "suburban";

  const meteo = await fetchSurfaceAeroMeteo(lat, lon);
  const windAtAlt = calculateWindShear(meteo.wind_speed_10m_ms, altRequested, terrainType);
  const sora = calculateGroundRiskClass(droneMassKg, "populated_urban");
  const viableBand = resolveSafeAltitudeBand(meteo.wind_speed_10m_ms, maxVehicleWindMs, terrainType);

  let status = "CLEARED_GREEN";
  let reason = "All aerodynamic and kinetic parameters within certified limits.";
  let rerouteRequired = false;

  if (windAtAlt > maxVehicleWindMs) {
    status = "DENIED_WIND_EXCEEDED";
    reason = `Wind at ${altRequested}m (${windAtAlt} m/s) exceeds maximum vehicle rating of ${maxVehicleWindMs} m/s.`;
    rerouteRequired = true;
  } else if (meteo.precipitation_mm_hr > 15.0) {
    status = "DENIED_CONVECTIVE_PRECIPITATION";
    reason = `Precipitation (${meteo.precipitation_mm_hr} mm/hr) violates VFR flight envelope.`;
    rerouteRequired = true;
  }

  const payload = {
    request_coordinates: { latitude: lat, longitude: lon },
    h3_index_res8: h3Cell,
    clearance_status: status,
    operational_reasoning: reason,
    reroute_required: rerouteRequired,
    requested_altitude_agl_m: altRequested,
    approved_altitude_band: viableBand,
    aerodynamic_telemetry: {
      surface_wind_ms: meteo.wind_speed_10m_ms,
      calculated_wind_at_alt_ms: windAtAlt,
      max_vehicle_wind_limit_ms: maxVehicleWindMs,
      precipitation_mm_hr: meteo.precipitation_mm_hr
    },
    sora_ground_risk_class: sora.sora_ground_risk_class,
    kinetic_impact_profile: {
      drone_mass_kg: droneMassKg,
      terminal_velocity_ms: sora.terminal_velocity_ms,
      kinetic_impact_joules: sora.kinetic_impact_joules
    },
    evaluated_at_utc: new Date().toISOString()
  };

  payload.mission_certificate = await generateClearanceHash(payload);
  return payload;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // Agent Discovery Manifest
    if (pathname === "/" || pathname === "/llms.txt") {
      return new Response(JSON.stringify({
        service: "lae-airspace-risk-edge",
        version: "1.0.0",
        purpose: "Low-Altitude Economy (LAE) Pre-Flight Mission Clearance Authority",
        endpoints: {
          single_clearance: "GET /v1/clearance?lat={lat}&lon={lon}&alt_m={alt}&drone_mass_kg={mass}&max_wind_limit_ms={limit}&terrain={suburban|urban_canyon}",
          corridor_clearance: "POST /v1/clearance-corridor"
        },
        regulatory_framework: "JARUS SORA v2.5 / GRC Matrix"
      }, null, 2), { headers: CORS_HEADERS });
    }

    // 1. Single Point Clearance Evaluation
    if (pathname === "/v1/clearance" && request.method === "GET") {
      const lat = parseFloat(searchParams.get("lat"));
      const lon = parseFloat(searchParams.get("lon"));

      if (isNaN(lat) || isNaN(lon)) {
        return new Response(JSON.stringify({ error: "Missing required 'lat' and 'lon' query parameters" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      const h3Cell = latLngToCell(lat, lon, H3_RES);
      const alt = searchParams.get("alt_m") || "60";
      const mass = searchParams.get("drone_mass_kg") || "5.0";

      // Cloudflare Anycast In-Memory Edge Cache Match
      const cache = caches.default;
      const cacheUrl = new URL(`https://lae-cache.internal/cells/${h3Cell}?alt=${alt}&mass=${mass}`);
      const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

      let cached = await cache.match(cacheKey);
      if (cached) {
        const body = await cached.json();
        body.cache_status = "HIT_EDGE";
        return new Response(JSON.stringify(body, null, 2), {
          status: 200,
          headers: { ...CORS_HEADERS, "X-Edge-Cache": "HIT" }
        });
      }

      const evaluation = await evaluatePointClearance(lat, lon, Object.fromEntries(searchParams));
      evaluation.cache_status = "MISS_EVALUATED";

      const res = new Response(JSON.stringify(evaluation, null, 2), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=180",
          "X-Edge-Cache": "MISS"
        }
      });

      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // 2. Flight Corridor Trajectory Assessment
    if (pathname === "/v1/clearance-corridor" && request.method === "POST") {
      try {
        const body = await request.json();
        const waypoints = body.waypoints || [];
        const altRequested = body.alt_m || 60;
        const mass = body.drone_mass_kg || 5.0;
        const maxWind = body.max_wind_limit_ms || 12.0;

        if (!Array.isArray(waypoints) || waypoints.length === 0) {
          return new Response(JSON.stringify({ error: "Provide a 'waypoints' array: [[lat, lon], ...]" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        // De-duplicate waypoints sharing the exact same H3 Res-8 spatial cell
        const uniqueCells = new Map();
        for (const wp of waypoints) {
          const cell = latLngToCell(wp[0], wp[1], H3_RES);
          if (!uniqueCells.has(cell)) {
            uniqueCells.set(cell, { lat: wp[0], lon: wp[1], cell });
          }
        }

        const corridorResults = [];
        let overallCleared = true;
        let bottleneckReason = null;

        for (const item of uniqueCells.values()) {
          const evalRes = await evaluatePointClearance(item.lat, item.lon, {
            alt_m: altRequested,
            drone_mass_kg: mass,
            max_wind_limit_ms: maxWind
          });

          if (evalRes.clearance_status !== "CLEARED_GREEN") {
            overallCleared = false;
            bottleneckReason = evalRes.operational_reasoning;
          }
          corridorResults.push(evalRes);
        }

        return new Response(JSON.stringify({
          corridor_status: overallCleared ? "CLEARED_CORRIDOR" : "DENIED_CORRIDOR",
          bottleneck_reason: bottleneckReason,
          total_waypoints_submitted: waypoints.length,
          unique_h3_sectors_evaluated: corridorResults.length,
          segments: corridorResults,
          corridor_hash: await generateClearanceHash({
            request_coordinates: waypoints[0],
            h3_index_res8: Array.from(uniqueCells.keys()).join(":"),
            clearance_status: overallCleared ? "CLEARED" : "DENIED",
            sora_ground_risk_class: corridorResults[0]?.sora_ground_risk_class || "GRC_1",
            approved_altitude_band: overallCleared ? { min: 20, max: altRequested } : null,
            evaluated_at_utc: new Date().toISOString()
          })
        }, null, 2), { headers: CORS_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Invalid corridor payload", details: err.message }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }
    }

    return new Response(JSON.stringify({ error: "Route not found" }), { status: 404, headers: CORS_HEADERS });
  }
};
