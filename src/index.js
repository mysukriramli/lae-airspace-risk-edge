import { latLngToCell } from "h3-js";
import { 
  calculateAeroWindProfile, 
  calculateDensityAltitude, 
  calculateGroundRiskClass, 
  resolveSafeAltitudeBand 
} from "./physics.js";
import { fetchSurfaceAeroMeteo } from "./sensors.js";
import { generateClearanceHash } from "./crypto.js";
import { checkAirspaceRestrictions } from "./airspace.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

const H3_RES = 8; // ~460m hexagonal sector diameter

/**
 * Evaluates single waypoint clearance against airspace, weather, density altitude, and SORA GRC
 */
async function evaluatePointClearance(lat, lon, params = {}) {
  const h3Cell = latLngToCell(lat, lon, H3_RES);
  const altRequested = parseFloat(params.alt_m || "60");
  const droneMassKg = parseFloat(params.drone_mass_kg || "5.5");
  const maxVehicleWindMs = parseFloat(params.max_wind_limit_ms || "12.0");
  const maxVehicleGustMs = parseFloat(params.max_gust_limit_ms || (maxVehicleWindMs * 1.35).toFixed(1));
  const terrainType = params.terrain || "suburban";

  // 1. Airspace Verification (Local embedded check + Global dynamic lookup)
  const airspace = await checkAirspaceRestrictions(lat, lon, altRequested);
  if (airspace.status === "RESTRICTED") {
    const deniedPayload = {
      request_coordinates: { latitude: lat, longitude: lon },
      h3_index_res8: h3Cell,
      clearance_status: "DENIED_RESTRICTED_AIRSPACE",
      operational_reasoning: `Corridor penetrates controlled airspace: ${airspace.zone_name} (${airspace.zone_id}). Distance: ${airspace.distance_to_center_km} km (Separation required: ${airspace.minimum_separation_km} km).`,
      reroute_required: true,
      airspace_constraint: airspace,
      approved_altitude_band: null,
      evaluated_at_utc: new Date().toISOString()
    };
    deniedPayload.mission_certificate = await generateClearanceHash(deniedPayload);
    return deniedPayload;
  }

  // 2. Fetch Atmospheric Telemetry (Fail-safe validation)
  const meteo = await fetchSurfaceAeroMeteo(lat, lon);
  if (!meteo.valid) {
    const deferredPayload = {
      request_coordinates: { latitude: lat, longitude: lon },
      h3_index_res8: h3Cell,
      clearance_status: "DEFER_TELEMETRY_UNAVAILABLE",
      operational_reasoning: `Upstream meteorological observations offline. Clearance deferred under fail-safe rules: ${meteo.error_message}`,
      reroute_required: true,
      airspace_constraint: airspace,
      approved_altitude_band: null,
      evaluated_at_utc: new Date().toISOString()
    };
    deferredPayload.mission_certificate = await generateClearanceHash(deferredPayload);
    return deferredPayload;
  }

  // 3. Compute Environmental Physics
  const density = calculateDensityAltitude(meteo.temperature_c, meteo.surface_pressure_hpa, altRequested);
  const aeroWind = calculateAeroWindProfile(meteo.wind_speed_10m_ms, meteo.wind_gusts_10m_ms, altRequested, terrainType);
  const sora = calculateGroundRiskClass(droneMassKg, density.air_density_kg_m3, "populated_urban");
  const viableBand = resolveSafeAltitudeBand(
    meteo.wind_speed_10m_ms, 
    meteo.wind_gusts_10m_ms, 
    maxVehicleWindMs, 
    maxVehicleGustMs, 
    terrainType
  );

  // 4. Decision Matrix
  let status = "CLEARED_GREEN";
  let reason = "All aerodynamic, airspace, and kinetic parameters within certified limits.";
  let rerouteRequired = false;

  if (aeroWind.peak_gust_at_alt_ms > maxVehicleGustMs) {
    status = "DENIED_GUST_TURBULENCE_EXCEEDED";
    reason = `Peak gust at ${altRequested}m (${aeroWind.peak_gust_at_alt_ms} m/s) exceeds vehicle limit of ${maxVehicleGustMs} m/s.`;
    rerouteRequired = true;
  } else if (aeroWind.steady_wind_at_alt_ms > maxVehicleWindMs) {
    status = "DENIED_WIND_SHEAR_EXCEEDED";
    reason = `Steady wind at ${altRequested}m (${aeroWind.steady_wind_at_alt_ms} m/s) exceeds vehicle rating of ${maxVehicleWindMs} m/s.`;
    rerouteRequired = true;
  } else if (meteo.precipitation_mm_hr > 12.0) {
    status = "DENIED_CONVECTIVE_PRECIPITATION";
    reason = `Precipitation intensity (${meteo.precipitation_mm_hr} mm/hr) violates VFR flight limits.`;
    rerouteRequired = true;
  } else if (density.thrust_efficiency_factor < 0.82) {
    status = "DENIED_DENSITY_ALTITUDE_THIN_AIR";
    reason = `Density altitude (${density.density_altitude_m}m) reduces aerodynamic lift efficiency below 82%.`;
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
    airspace_constraint: airspace,
    aerodynamic_telemetry: {
      surface_wind_ms: meteo.wind_speed_10m_ms,
      surface_gust_ms: meteo.wind_gusts_10m_ms,
      steady_wind_at_alt_ms: aeroWind.steady_wind_at_alt_ms,
      peak_gust_at_alt_ms: aeroWind.peak_gust_at_alt_ms,
      max_vehicle_wind_limit_ms: maxVehicleWindMs,
      max_vehicle_gust_limit_ms: maxVehicleGustMs,
      precipitation_mm_hr: meteo.precipitation_mm_hr
    },
    atmospheric_profile: {
      temperature_c: meteo.temperature_c,
      surface_pressure_hpa: meteo.surface_pressure_hpa,
      air_density_kg_m3: density.air_density_kg_m3,
      density_altitude_m: density.density_altitude_m,
      thrust_efficiency_factor: density.thrust_efficiency_factor
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

/**
 * Evaluates batch flight corridor trajectory with concurrent H3 sector resolution
 */
async function evaluateCorridorClearance(waypoints, altRequested = 60, mass = 5.5, maxWind = 12.0, maxGust = 16.2) {
  // Deduplicate waypoints sharing identical H3 resolution 8 cells (~460m)
  const uniqueCells = new Map();
  for (const wp of waypoints) {
    const cell = latLngToCell(wp[0], wp[1], H3_RES);
    if (!uniqueCells.has(cell)) {
      uniqueCells.set(cell, { lat: wp[0], lon: wp[1], cell });
    }
  }

  // Parallel resolution of all unique corridor cells
  const cellPromises = Array.from(uniqueCells.values()).map(item =>
    evaluatePointClearance(item.lat, item.lon, {
      alt_m: altRequested,
      drone_mass_kg: mass,
      max_wind_limit_ms: maxWind,
      max_gust_limit_ms: maxGust
    })
  );

  const corridorResults = await Promise.all(cellPromises);

  let overallCleared = true;
  let bottleneckReason = null;
  let bottleneckStatus = "CLEARED_CORRIDOR";

  for (const res of corridorResults) {
    if (res.clearance_status !== "CLEARED_GREEN") {
      overallCleared = false;
      bottleneckStatus = res.clearance_status;
      bottleneckReason = res.operational_reasoning;
      break;
    }
  }

  return {
    corridor_status: overallCleared ? "CLEARED_CORRIDOR" : "DENIED_CORRIDOR",
    bottleneck_status: overallCleared ? null : bottleneckStatus,
    bottleneck_reason: bottleneckReason,
    total_waypoints_submitted: waypoints.length,
    unique_h3_sectors_evaluated: corridorResults.length,
    segments: corridorResults,
    corridor_witness_hash: await generateClearanceHash({
      request_coordinates: waypoints[0],
      h3_index_res8: Array.from(uniqueCells.keys()).join(":"),
      clearance_status: overallCleared ? "CLEARED" : "DENIED",
      sora_ground_risk_class: corridorResults[0]?.sora_ground_risk_class || "GRC_1",
      approved_altitude_band: overallCleared ? { min: 20, max: altRequested } : null,
      evaluated_at_utc: new Date().toISOString()
    })
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // 1. Model Context Protocol (MCP) JSON-RPC 2.0 Handler
    if (pathname === "/mcp" && request.method === "POST") {
      try {
        const rpc = await request.json();
        const { id, method, params } = rpc;

        // MCP Handshake: initialize
        if (method === "initialize") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: {}
              },
              serverInfo: {
                name: "lae-airspace-risk-edge",
                version: "2.0.0"
              }
            }
          }), { headers: CORS_HEADERS });
        }

        // MCP Notification: initialized
        if (method === "notifications/initialized") {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // MCP Ping
        if (method === "ping") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), { headers: CORS_HEADERS });
        }

        // MCP Tool Catalog: tools/list
        if (method === "tools/list") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "evaluate_airspace_clearance",
                  description: "Evaluates low-altitude flight clearance at a specific coordinate. Computes aerodrome restriction zones, Hellmann wind shear profiles, density altitude penalties, and JARUS SORA kinetic ground risk.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      lat: { type: "number", description: "Target latitude in decimal degrees." },
                      lon: { type: "number", description: "Target longitude in decimal degrees." },
                      alt_m: { type: "number", default: 60, description: "Planned flight altitude AGL in meters." },
                      drone_mass_kg: { type: "number", default: 5.5, description: "Aircraft all-up takeoff mass in kg." },
                      max_wind_limit_ms: { type: "number", default: 12.0, description: "Max certified steady wind rating in m/s." },
                      max_gust_limit_ms: { type: "number", description: "Max certified peak gust threshold in m/s (defaults to 1.35x wind limit)." },
                      terrain: { type: "string", enum: ["water", "open_field", "suburban", "urban_canyon"], default: "suburban" }
                    },
                    required: ["lat", "lon"]
                  }
                },
                {
                  name: "evaluate_corridor_clearance",
                  description: "Evaluates an entire flight corridor trajectory over an array of waypoints. Deduplicates identical H3 spatial sectors and returns a unified corridor GO/NO-GO clearance with cryptographic witness proof.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      waypoints: {
                        type: "array",
                        items: {
                          type: "array",
                          items: { type: "number" },
                          minItems: 2,
                          maxItems: 2
                        },
                        description: "Array of [lat, lon] coordinates forming the planned trajectory."
                      },
                      alt_m: { type: "number", default: 60, description: "Planned flight altitude AGL in meters." },
                      drone_mass_kg: { type: "number", default: 5.5, description: "Aircraft all-up mass in kg." },
                      max_wind_limit_ms: { type: "number", default: 12.0, description: "Max vehicle steady wind limit in m/s." }
                    },
                    required: ["waypoints"]
                  }
                }
              ]
            }
          }), { headers: CORS_HEADERS });
        }

        // MCP Tool Execution: tools/call
        if (method === "tools/call") {
          const toolName = params?.name;
          const args = params?.arguments || {};

          if (toolName === "evaluate_airspace_clearance") {
            if (typeof args.lat !== "number" || typeof args.lon !== "number") {
              return new Response(JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: -32602, message: "Invalid params: 'lat' and 'lon' are required numbers." }
              }), { status: 400, headers: CORS_HEADERS });
            }

            const result = await evaluatePointClearance(args.lat, args.lon, args);
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result, null, 2)
                  }
                ]
              }
            }), { headers: CORS_HEADERS });
          }

          if (toolName === "evaluate_corridor_clearance") {
            const waypoints = args.waypoints;
            if (!Array.isArray(waypoints) || waypoints.length === 0) {
              return new Response(JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: -32602, message: "Invalid params: 'waypoints' must be an array of [lat, lon]." }
              }), { status: 400, headers: CORS_HEADERS });
            }

            const altRequested = args.alt_m || 60;
            const mass = args.drone_mass_kg || 5.5;
            const maxWind = args.max_wind_limit_ms || 12.0;
            const maxGust = args.max_gust_limit_ms || (maxWind * 1.35);

            const result = await evaluateCorridorClearance(waypoints, altRequested, mass, maxWind, maxGust);
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result, null, 2)
                  }
                ]
              }
            }), { headers: CORS_HEADERS });
          }

          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Tool '${toolName}' not found.` }
          }), { status: 404, headers: CORS_HEADERS });
        }

        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: `Unsupported method '${method}'.` }
        }), { status: 400, headers: CORS_HEADERS });

      } catch (err) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32700, message: `Parse error: ${err.message}` }
        }), { status: 500, headers: CORS_HEADERS });
      }
    }

    // 2. Discovery Manifest for Autonomous Agents & Web Crawlers
    if (pathname === "/" || pathname === "/llms.txt") {
      return new Response(JSON.stringify({
        service: "lae-airspace-risk-edge",
        version: "2.0.0",
        purpose: "Worldwide Low-Altitude Economy Mission Clearance Authority",
        mcp_endpoint: "POST /mcp",
        decision_states: [
          "CLEARED_GREEN",
          "DENIED_RESTRICTED_AIRSPACE",
          "DENIED_WIND_SHEAR_EXCEEDED",
          "DENIED_GUST_TURBULENCE_EXCEEDED",
          "DENIED_CONVECTIVE_PRECIPITATION",
          "DENIED_DENSITY_ALTITUDE_THIN_AIR",
          "DEFER_TELEMETRY_UNAVAILABLE"
        ],
        endpoints: {
          mcp_json_rpc: "POST /mcp",
          single_clearance: "GET /v1/clearance?lat={lat}&lon={lon}&alt_m={alt}&drone_mass_kg={mass}&max_wind_limit_ms={limit}",
          corridor_clearance: "POST /v1/clearance-corridor"
        },
        regulatory_standards: "ICAO Annex 2/11 CTR + JARUS SORA v2.5 GRC"
      }, null, 2), { headers: CORS_HEADERS });
    }

    // 3. REST Single Waypoint Clearance Verification
    if (pathname === "/v1/clearance" && request.method === "GET") {
      const lat = parseFloat(searchParams.get("lat"));
      const lon = parseFloat(searchParams.get("lon"));

      if (isNaN(lat) || isNaN(lon)) {
        return new Response(JSON.stringify({ error: "Missing required numeric 'lat' and 'lon' query parameters" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      const h3Cell = latLngToCell(lat, lon, H3_RES);
      const alt = searchParams.get("alt_m") || "60";
      const mass = searchParams.get("drone_mass_kg") || "5.5";

      // Anycast In-Memory DRAM Cache Lookup
      const cache = caches.default;
      const cacheUrl = new URL(`https://lae-cache.internal/v2/cells/${h3Cell}?alt=${alt}&mass=${mass}`);
      const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

      const cached = await cache.match(cacheKey);
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

      // Populate edge cache non-blockingly
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // 4. REST High-Concurrency Flight Corridor Batch Evaluation
    if (pathname === "/v1/clearance-corridor" && request.method === "POST") {
      try {
        const body = await request.json();
        const waypoints = body.waypoints || [];
        const altRequested = body.alt_m || 60;
        const mass = body.drone_mass_kg || 5.5;
        const maxWind = body.max_wind_limit_ms || 12.0;
        const maxGust = body.max_gust_limit_ms || (maxWind * 1.35);

        if (!Array.isArray(waypoints) || waypoints.length === 0) {
          return new Response(JSON.stringify({ error: "Provide a 'waypoints' array: [[lat, lon], ...]" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        const corridorEvaluation = await evaluateCorridorClearance(waypoints, altRequested, mass, maxWind, maxGust);
        return new Response(JSON.stringify(corridorEvaluation, null, 2), { headers: CORS_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Malformed corridor payload", details: err.message }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }
    }

    return new Response(JSON.stringify({ error: "Endpoint not found" }), { status: 404, headers: CORS_HEADERS });
  }
};
