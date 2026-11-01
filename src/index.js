import { latLngToCell } from "h3-js";
import { 
  calculateAeroWindProfile, 
  calculateDensityAltitude, 
  calculateGroundRiskClass, 
  resolveSafeAltitudeBand,
  calculateBearingDeg,
  resolveRelativeWindVector,
  evaluateC2LinkRisk
} from "./physics.js";
import { fetchSurfaceAeroMeteo } from "./sensors.js";
import { generateClearanceHash } from "./crypto.js";
import { checkAirspaceRestrictions, getTerrainElevationM } from "./airspace.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

const H3_RES = 8; // ~460m hexagonal sector diameter

/**
 * In-Memory 4D Spatiotemporal Reservation Registry (ASTM F3548 UTM)
 * Partition key: h3_cell:altitude_bin:epoch_time_slot_30s
 */
const ACTIVE_4D_RESERVATIONS = new Map();

function cleanExpiredReservations() {
  const now = Date.now();
  for (const [key, record] of ACTIVE_4D_RESERVATIONS.entries()) {
    if (record.expiresAt < now) {
      ACTIVE_4D_RESERVATIONS.delete(key);
    }
  }
}

function check4DConflicts(cells, altitudeM, startIso, endIso, missionId) {
  cleanExpiredReservations();
  const startTime = new Date(startIso).getTime();
  const endTime = new Date(endIso).getTime();
  const altBin = Math.floor(altitudeM / 30) * 30; // 30-meter vertical separation slices

  for (const cell of cells) {
    for (let t = startTime; t <= endTime; t += 30000) {
      const slotBin = Math.floor(t / 30000) * 30000;
      const key = `${cell}:${altBin}:${slotBin}`;
      const existing = ACTIVE_4D_RESERVATIONS.get(key);

      if (existing && existing.missionId !== missionId) {
        return {
          conflict: true,
          conflicting_mission_id: existing.missionId,
          conflict_h3_cell: cell,
          altitude_bin_m: `${altBin}-${altBin + 30}m`,
          time_slot_utc: new Date(slotBin).toISOString(),
          recommended_action: "ADVISE_DEPARTURE_DELAY_60S"
        };
      }
    }
  }

  return { conflict: false };
}

function commit4DReservation(cells, altitudeM, startIso, endIso, missionId, priorityTier = "COMMERCIAL_LOGISTICS") {
  const startTime = new Date(startIso).getTime();
  const endTime = new Date(endIso).getTime();
  const altBin = Math.floor(altitudeM / 30) * 30;

  for (const cell of cells) {
    for (let t = startTime; t <= endTime; t += 30000) {
      const slotBin = Math.floor(t / 30000) * 30000;
      const key = `${cell}:${altBin}:${slotBin}`;
      ACTIVE_4D_RESERVATIONS.set(key, {
        missionId,
        priorityTier,
        expiresAt: endTime + 60000
      });
    }
  }
}

/**
 * Evaluates single waypoint clearance with terrain DEM, C2 link risk, and vector aerodynamics
 */
async function evaluatePointClearance(lat, lon, params = {}) {
  const h3Cell = latLngToCell(lat, lon, H3_RES);
  const altRequestedAgl = parseFloat(params.alt_m || "60");
  const droneMassKg = parseFloat(params.drone_mass_kg || "5.5");
  const maxVehicleWindMs = parseFloat(params.max_wind_limit_ms || "12.0");
  const maxVehicleGustMs = parseFloat(params.max_gust_limit_ms || (maxVehicleWindMs * 1.35).toFixed(1));
  const terrainType = params.terrain || "suburban";
  const bearing = params.bearing_deg !== undefined ? parseFloat(params.bearing_deg) : null;
  const m2Mitigation = params.m2_ground_mitigation === "true" || params.m2_ground_mitigation === true;

  // 1. Terrain DEM & True AGL Separation
  const terrainElevationM = await getTerrainElevationM(lat, lon);
  const trueAltitudeAmsl = terrainElevationM + altRequestedAgl;

  // 2. Airspace Restriction Check
  const airspace = await checkAirspaceRestrictions(lat, lon, altRequestedAgl);
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

  // 3. Meteorological Telemetry Check
  const meteo = await fetchSurfaceAeroMeteo(lat, lon);
  if (!meteo.valid) {
    const deferredPayload = {
      request_coordinates: { latitude: lat, longitude: lon },
      h3_index_res8: h3Cell,
      clearance_status: "DEFER_TELEMETRY_UNAVAILABLE",
      operational_reasoning: `Upstream weather observations offline. Clearance deferred under fail-safe rules: ${meteo.error_message}`,
      reroute_required: true,
      airspace_constraint: airspace,
      approved_altitude_band: null,
      evaluated_at_utc: new Date().toISOString()
    };
    deferredPayload.mission_certificate = await generateClearanceHash(deferredPayload);
    return deferredPayload;
  }

  // 4. Physical Calculations
  const density = calculateDensityAltitude(meteo.temperature_c, meteo.surface_pressure_hpa, altRequestedAgl);
  const aeroWind = calculateAeroWindProfile(meteo.wind_speed_10m_ms, meteo.wind_gusts_10m_ms, altRequestedAgl, terrainType);
  const sora = calculateGroundRiskClass(droneMassKg, density.air_density_kg_m3, "populated_urban", m2Mitigation);
  const c2Profile = evaluateC2LinkRisk(altRequestedAgl);
  const viableBand = resolveSafeAltitudeBand(
    meteo.wind_speed_10m_ms, 
    meteo.wind_gusts_10m_ms, 
    maxVehicleWindMs, 
    maxVehicleGustMs, 
    terrainType
  );

  let vectorAerodynamics = null;
  if (bearing !== null) {
    vectorAerodynamics = resolveRelativeWindVector(aeroWind.steady_wind_at_alt_ms, meteo.wind_direction_deg, bearing);
  }

  // 5. Decision Matrix
  let status = "CLEARED_GREEN";
  let reason = "All aerodynamic, airspace, and kinetic parameters within certified limits.";
  let rerouteRequired = false;

  if (aeroWind.peak_gust_at_alt_ms > maxVehicleGustMs) {
    status = "DENIED_GUST_TURBULENCE_EXCEEDED";
    reason = `Peak gust at ${altRequestedAgl}m (${aeroWind.peak_gust_at_alt_ms} m/s) exceeds vehicle limit of ${maxVehicleGustMs} m/s.`;
    rerouteRequired = true;
  } else if (aeroWind.steady_wind_at_alt_ms > maxVehicleWindMs) {
    status = "DENIED_WIND_SHEAR_EXCEEDED";
    reason = `Steady wind at ${altRequestedAgl}m (${aeroWind.steady_wind_at_alt_ms} m/s) exceeds vehicle rating of ${maxVehicleWindMs} m/s.`;
    rerouteRequired = true;
  } else if (meteo.precipitation_mm_hr > 12.0) {
    status = "DENIED_CONVECTIVE_PRECIPITATION";
    reason = `Precipitation intensity (${meteo.precipitation_mm_hr} mm/hr) violates VFR flight limits.`;
    rerouteRequired = true;
  } else if (density.thrust_efficiency_factor < 0.82) {
    status = "DENIED_DENSITY_ALTITUDE_THIN_AIR";
    reason = `Density altitude (${density.density_altitude_m}m) reduces aerodynamic lift efficiency below 82%.`;
    rerouteRequired = true;
  } else if (c2Profile.c2_link_safety === "POOR_SIDELOBE_INTERFERENCE") {
    status = "ADVISORY_C2_DEGRADATION";
    reason = "Target altitude exceeds 120m AGL, incurring antenna null interference from cellular down-tilt.";
  }

  const payload = {
    request_coordinates: { latitude: lat, longitude: lon },
    h3_index_res8: h3Cell,
    clearance_status: status,
    operational_reasoning: reason,
    reroute_required: rerouteRequired,
    altitude_profile: {
      requested_alt_agl_m: altRequestedAgl,
      terrain_elevation_amsl_m: terrainElevationM,
      calculated_flight_amsl_m: trueAltitudeAmsl
    },
    approved_altitude_band: viableBand,
    airspace_constraint: airspace,
    aerodynamic_telemetry: {
      surface_wind_ms: meteo.wind_speed_10m_ms,
      surface_gust_ms: meteo.wind_gusts_10m_ms,
      wind_direction_deg: meteo.wind_direction_deg,
      steady_wind_at_alt_ms: aeroWind.steady_wind_at_alt_ms,
      peak_gust_at_alt_ms: aeroWind.peak_gust_at_alt_ms,
      max_vehicle_wind_limit_ms: maxVehicleWindMs,
      max_vehicle_gust_limit_ms: maxVehicleGustMs,
      precipitation_mm_hr: meteo.precipitation_mm_hr
    },
    vector_aerodynamics: vectorAerodynamics,
    atmospheric_profile: {
      temperature_c: meteo.temperature_c,
      surface_pressure_hpa: meteo.surface_pressure_hpa,
      air_density_kg_m3: density.air_density_kg_m3,
      density_altitude_m: density.density_altitude_m,
      thrust_efficiency_factor: density.thrust_efficiency_factor
    },
    c2_telecommunications_profile: c2Profile,
    sora_ground_risk_class: sora.sora_ground_risk_class,
    kinetic_impact_profile: {
      drone_mass_kg: droneMassKg,
      terminal_velocity_ms: sora.terminal_velocity_ms,
      kinetic_impact_joules: sora.kinetic_impact_joules,
      baseline_grc: sora.baseline_grc,
      m2_mitigation_applied: sora.m2_mitigation_applied
    },
    evaluated_at_utc: new Date().toISOString()
  };

  payload.mission_certificate = await generateClearanceHash(payload);
  return payload;
}

/**
 * Evaluates flight corridor trajectory across sequential waypoints
 */
async function evaluateCorridorClearance(waypoints, altRequested = 60, mass = 5.5, maxWind = 12.0, maxGust = 16.2) {
  const uniqueCells = new Map();

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const cell = latLngToCell(wp[0], wp[1], H3_RES);
    let bearing = null;
    if (i < waypoints.length - 1) {
      bearing = calculateBearingDeg(wp[0], wp[1], waypoints[i + 1][0], waypoints[i + 1][1]);
    }

    if (!uniqueCells.has(cell)) {
      uniqueCells.set(cell, { lat: wp[0], lon: wp[1], cell, bearing });
    }
  }

  const cellPromises = Array.from(uniqueCells.values()).map(item =>
    evaluatePointClearance(item.lat, item.lon, {
      alt_m: altRequested,
      drone_mass_kg: mass,
      max_wind_limit_ms: maxWind,
      max_gust_limit_ms: maxGust,
      bearing_deg: item.bearing
    })
  );

  const corridorResults = await Promise.all(cellPromises);

  let overallCleared = true;
  let bottleneckReason = null;
  let bottleneckStatus = "CLEARED_CORRIDOR";

  for (const res of corridorResults) {
    if (res.clearance_status !== "CLEARED_GREEN" && res.clearance_status !== "ADVISORY_C2_DEGRADATION") {
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

        if (method === "initialize") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "lae-airspace-risk-edge", version: "2.2.0" }
            }
          }), { headers: CORS_HEADERS });
        }

        if (method === "notifications/initialized") {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (method === "ping") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), { headers: CORS_HEADERS });
        }

        if (method === "tools/list") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "evaluate_airspace_clearance",
                  description: "Evaluates low-altitude flight clearance, aerodrome geofencing, terrain AGL clearance, wind shear, C2 link quality, and SORA GRC.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      lat: { type: "number", description: "Target latitude" },
                      lon: { type: "number", description: "Target longitude" },
                      alt_m: { type: "number", default: 60, description: "Planned altitude AGL in meters" },
                      drone_mass_kg: { type: "number", default: 5.5, description: "Total takeoff mass in kg" },
                      max_wind_limit_ms: { type: "number", default: 12.0, description: "Max steady wind rating in m/s" },
                      bearing_deg: { type: "number", description: "Forward flight bearing in degrees (0-360)" },
                      m2_ground_mitigation: { type: "boolean", default: false, description: "Whether SORA M2 ground impact mitigation area is secured" }
                    },
                    required: ["lat", "lon"]
                  }
                },
                {
                  name: "evaluate_corridor_clearance",
                  description: "Evaluates an entire flight corridor trajectory over an array of waypoints, calculating crosswinds and aggregate clearance proof.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      waypoints: {
                        type: "array",
                        items: { type: "array", items: { type: "number" } },
                        description: "Array of [lat, lon] coordinates."
                      },
                      alt_m: { type: "number", default: 60 },
                      drone_mass_kg: { type: "number", default: 5.5 },
                      max_wind_limit_ms: { type: "number", default: 12.0 }
                    },
                    required: ["waypoints"]
                  }
                }
              ]
            }
          }), { headers: CORS_HEADERS });
        }

        if (method === "tools/call") {
          const toolName = params?.name;
          const args = params?.arguments || {};

          if (toolName === "evaluate_airspace_clearance") {
            const result = await evaluatePointClearance(args.lat, args.lon, args);
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
            }), { headers: CORS_HEADERS });
          }

          if (toolName === "evaluate_corridor_clearance") {
            const result = await evaluateCorridorClearance(
              args.waypoints, 
              args.alt_m, 
              args.drone_mass_kg, 
              args.max_wind_limit_ms, 
              args.max_gust_limit_ms
            );
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
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

    // 2. Discovery Manifest
    if (pathname === "/" || pathname === "/llms.txt") {
      return new Response(JSON.stringify({
        service: "lae-airspace-risk-edge",
        version: "2.2.0",
        purpose: "Mission Clearance Authority & 4D Spatiotemporal UTM Deconfliction Engine",
        mcp_endpoint: "POST /mcp",
        endpoints: {
          single_clearance: "GET /v1/clearance?lat={lat}&lon={lon}&alt_m={alt}&bearing_deg={deg}",
          corridor_clearance: "POST /v1/clearance-corridor",
          reserve_corridor_4d: "POST /v1/reserve-corridor"
        },
        regulatory_standards: "ASTM F3548 UTM + ICAO CTR + JARUS SORA v2.5"
      }, null, 2), { headers: CORS_HEADERS });
    }

    // 3. REST Single Waypoint Clearance
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
      const bearing = searchParams.get("bearing_deg") || "0";

      const cache = caches.default;
      const cacheUrl = new URL(`https://lae-cache.internal/v22/cells/${h3Cell}?alt=${alt}&mass=${mass}&b=${bearing}`);
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

      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // 4. REST Flight Corridor Batch Evaluation
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

    // 5. REST 4D Spatiotemporal Corridor Reservation (ASTM F3548 Strategic Deconfliction)
    if (pathname === "/v1/reserve-corridor" && request.method === "POST") {
      try {
        const body = await request.json();
        const { waypoints, alt_m = 60, time_start_utc, time_end_utc, mission_id, priority_tier } = body;

        if (!waypoints || !time_start_utc || !time_end_utc || !mission_id) {
          return new Response(JSON.stringify({
            error: "Missing required fields: 'waypoints', 'alt_m', 'time_start_utc', 'time_end_utc', 'mission_id'"
          }), { status: 400, headers: CORS_HEADERS });
        }

        const cells = Array.from(new Set(waypoints.map(wp => latLngToCell(wp[0], wp[1], H3_RES))));
        const conflictCheck = check4DConflicts(cells, alt_m, time_start_utc, time_end_utc, mission_id);

        if (conflictCheck.conflict) {
          return new Response(JSON.stringify({
            reservation_status: "CONFLICT_DETECTED",
            conflict_details: conflictCheck
          }, null, 2), { status: 409, headers: CORS_HEADERS });
        }

        commit4DReservation(cells, alt_m, time_start_utc, time_end_utc, mission_id, priority_tier);

        return new Response(JSON.stringify({
          reservation_status: "CONFIRMED_4D_RESERVED",
          mission_id,
          reserved_h3_cells_count: cells.length,
          altitude_band_m: `${Math.floor(alt_m / 30) * 30}-${Math.floor(alt_m / 30) * 30 + 30}m`,
          window_start: time_start_utc,
          window_end: time_end_utc,
          reservation_witness: await generateClearanceHash({
            request_coordinates: waypoints[0],
            h3_index_res8: cells.join(":"),
            status: "RESERVED_4D",
            evaluated_at: new Date().toISOString()
          })
        }, null, 2), { headers: CORS_HEADERS });

      } catch (err) {
        return new Response(JSON.stringify({ error: "Failed to process 4D reservation", details: err.message }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }
    }

    return new Response(JSON.stringify({ error: "Endpoint not found" }), { status: 404, headers: CORS_HEADERS });
  }
};
