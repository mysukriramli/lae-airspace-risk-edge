import { latLngToCell } from "h3-js";
import { 
  calculateAeroWindProfile, 
  calculateDensityAltitude, 
  calculateGroundRiskClass, 
  resolveSafeAltitudeBand, 
  resolveRelativeWindVector, 
  evaluateC2LinkRisk 
} from "./physics.js";
import { fetchSurfaceAeroMeteo } from "./sensors.js";
import { generateClearanceHash } from "./crypto.js";
import { checkAirspaceRestrictions } from "./airspace.js";
import { getTerrainElevationM, estimateUrbanCanopyHeightM, checkDynamicTFRs } from "./obstacles.js";
import { validateEnterpriseToken } from "./auth.js";
import { calculateBearingDeg } from "./conformance.js";

export { AirspaceCorridorDO } from "./durable_object.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

const H3_RES = 8; // ~460m hexagonal sector diameter
const H3_DISTRICT_RES = 6; // ~36 km² regional cluster for Durable Object partitioning

async function evaluatePointClearance(lat, lon, params = {}) {
  const h3Cell = latLngToCell(lat, lon, H3_RES);
  const altRequestedAgl = parseFloat(params.alt_m || "60");
  const droneMassKg = parseFloat(params.drone_mass_kg || "5.5");
  const maxVehicleWindMs = parseFloat(params.max_wind_limit_ms || "12.0");
  const maxVehicleGustMs = parseFloat(params.max_gust_limit_ms || (maxVehicleWindMs * 1.35).toFixed(1));
  const terrainType = params.terrain || "suburban";
  const bearing = params.bearing_deg !== undefined ? parseFloat(params.bearing_deg) : null;
  const m2Mitigation = params.m2_ground_mitigation === "true" || params.m2_ground_mitigation === true;

  // 1. Dynamic TFR / NOTAM Validation
  const tfrCheck = checkDynamicTFRs(lat, lon, altRequestedAgl);
  if (tfrCheck.active_tfr_found) {
    const tfrPayload = {
      request_coordinates: { latitude: lat, longitude: lon },
      h3_index_res8: h3Cell,
      clearance_status: "DENIED_TEMPORARY_FLIGHT_RESTRICTION",
      operational_reasoning: `Flight intersects active emergency/VIP geofence: ${tfrCheck.tfr_name} (${tfrCheck.tfr_id}). Reason: ${tfrCheck.reason}.`,
      reroute_required: true,
      tfr_constraint: tfrCheck,
      approved_altitude_band: null,
      evaluated_at_utc: new Date().toISOString()
    };
    tfrPayload.mission_certificate = await generateClearanceHash(tfrPayload);
    return tfrPayload;
  }

  // 2. Airspace Restriction Check
  const airspace = await checkAirspaceRestrictions(lat, lon, altRequestedAgl);
  if (airspace.status === "RESTRICTED") {
    const deniedPayload = {
      request_coordinates: { latitude: lat, longitude: lon },
      h3_index_res8: h3Cell,
      clearance_status: "DENIED_RESTRICTED_AIRSPACE",
      operational_reasoning: `Corridor penetrates controlled aerodrome CTR: ${airspace.zone_name} (${airspace.zone_id}). Distance: ${airspace.distance_to_center_km} km (Separation required: ${airspace.minimum_separation_km} km).`,
      reroute_required: true,
      airspace_constraint: airspace,
      approved_altitude_band: null,
      evaluated_at_utc: new Date().toISOString()
    };
    deniedPayload.mission_certificate = await generateClearanceHash(deniedPayload);
    return deniedPayload;
  }

  // 3. Terrain DEM & 3D Building Canopy (DSM) Obstacle Floor
  const terrainElevationM = await getTerrainElevationM(lat, lon);
  const urbanCanopy = estimateUrbanCanopyHeightM(terrainType);
  const trueAltitudeAmsl = terrainElevationM + altRequestedAgl;

  if (altRequestedAgl < urbanCanopy.minimum_safe_cruise_alt_agl_m) {
    const obstaclePayload = {
      request_coordinates: { latitude: lat, longitude: lon },
      h3_index_res8: h3Cell,
      clearance_status: "DENIED_OBSTACLE_CLEARANCE_VIOLATION",
      operational_reasoning: `Requested altitude (${altRequestedAgl}m AGL) penetrates 3D urban canopy floor. Minimum certified clearance for ${terrainType} is ${urbanCanopy.minimum_safe_cruise_alt_agl_m}m AGL.`,
      reroute_required: true,
      obstacle_profile: urbanCanopy,
      approved_altitude_band: { min_m: urbanCanopy.minimum_safe_cruise_alt_agl_m, max_m: 120 },
      evaluated_at_utc: new Date().toISOString()
    };
    obstaclePayload.mission_certificate = await generateClearanceHash(obstaclePayload);
    return obstaclePayload;
  }

  // 4. Atmospheric Telemetry
  const meteo = await fetchSurfaceAeroMeteo(lat, lon);
  if (!meteo.valid) {
    const deferredPayload = {
      request_coordinates: { latitude: lat, longitude: lon },
      h3_index_res8: h3Cell,
      clearance_status: "DEFER_TELEMETRY_UNAVAILABLE",
      operational_reasoning: `Upstream weather observations offline. Clearance deferred under fail-safe rules: ${meteo.error_message}`,
      reroute_required: true,
      approved_altitude_band: null,
      evaluated_at_utc: new Date().toISOString()
    };
    deferredPayload.mission_certificate = await generateClearanceHash(deferredPayload);
    return deferredPayload;
  }

  // 5. Environmental Physics Calculations
  const density = calculateDensityAltitude(meteo.temperature_c, meteo.surface_pressure_hpa, altRequestedAgl);
  const aeroWind = calculateAeroWindProfile(meteo.wind_speed_10m_ms, meteo.wind_gusts_10m_ms, altRequestedAgl, terrainType);
  const sora = calculateGroundRiskClass(droneMassKg, density.air_density_kg_m3, "populated_urban", m2Mitigation);
  const c2Profile = evaluateC2LinkRisk(altRequestedAgl);
  const viableBand = resolveSafeAltitudeBand(
    meteo.wind_speed_10m_ms,
    meteo.wind_gusts_10m_ms,
    maxVehicleWindMs,
    maxVehicleGustMs,
    terrainType,
    urbanCanopy.minimum_safe_cruise_alt_agl_m
  );

  let vectorAerodynamics = null;
  if (bearing !== null) {
    vectorAerodynamics = resolveRelativeWindVector(aeroWind.steady_wind_at_alt_ms, meteo.wind_direction_deg, bearing);
  }

  // 6. Decision Matrix
  let status = "CLEARED_GREEN";
  let reason = "All aerodynamic, obstacle, airspace, and kinetic parameters within certified limits.";
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
      calculated_flight_amsl_m: trueAltitudeAmsl,
      obstacle_canopy_floor_m: urbanCanopy.minimum_safe_cruise_alt_agl_m
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

    const auth = validateEnterpriseToken(request, env);
    if (!auth.authorized) {
      return new Response(JSON.stringify({ error: auth.error }), { status: 401, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // 1. Model Context Protocol (MCP) Endpoint
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
              serverInfo: { name: "lae-airspace-risk-edge", version: "3.0.0" }
            }
          }), { headers: CORS_HEADERS });
        }

        if (method === "tools/list") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "evaluate_airspace_clearance",
                  description: "Evaluates low-altitude flight clearance, aerodrome geofencing, terrain/canopy obstacles, wind shear, and SORA GRC.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      lat: { type: "number" },
                      lon: { type: "number" },
                      alt_m: { type: "number", default: 60 },
                      drone_mass_kg: { type: "number", default: 5.5 },
                      max_wind_limit_ms: { type: "number", default: 12.0 },
                      terrain: { type: "string", enum: ["water", "open_field", "suburban", "urban_canyon"] }
                    },
                    required: ["lat", "lon"]
                  }
                },
                {
                  name: "evaluate_corridor_clearance",
                  description: "Evaluates full corridor trajectory across multiple waypoints.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      waypoints: { type: "array", items: { type: "array", items: { type: "number" } } },
                      alt_m: { type: "number", default: 60 }
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
            const result = await evaluateCorridorClearance(args.waypoints, args.alt_m, args.drone_mass_kg, args.max_wind_limit_ms);
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
            }), { headers: CORS_HEADERS });
          }

          return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Tool not found" } }), { status: 404, headers: CORS_HEADERS });
        }

        return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message: "Unsupported method" } }), { status: 400, headers: CORS_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: err.message } }), { status: 500, headers: CORS_HEADERS });
      }
    }

    // 2. Discovery Manifest
    if (pathname === "/" || pathname === "/llms.txt") {
      return new Response(JSON.stringify({
        service: "lae-airspace-risk-edge",
        version: "3.0.0",
        purpose: "Enterprise Mission Clearance Authority, Distributed Durable 4D UTM, and In-Flight Conformance Monitoring",
        endpoints: {
          single_clearance: "GET /v1/clearance?lat={lat}&lon={lon}&alt_m={alt}",
          corridor_clearance: "POST /v1/clearance-corridor",
          durable_reserve_4d: "POST /v1/reserve-corridor",
          in_flight_telemetry: "POST /v1/conformance/telemetry"
        },
        regulatory_standards: "ASTM F3548 UTM + ICAO Annex 2/11 + JARUS SORA v2.5"
      }, null, 2), { headers: CORS_HEADERS });
    }

    // 3. REST Single Waypoint Clearance
    if (pathname === "/v1/clearance" && request.method === "GET") {
      const lat = parseFloat(searchParams.get("lat"));
      const lon = parseFloat(searchParams.get("lon"));

      if (isNaN(lat) || isNaN(lon)) {
        return new Response(JSON.stringify({ error: "Missing required 'lat' and 'lon' query parameters" }), { status: 400, headers: CORS_HEADERS });
      }

      const h3Cell = latLngToCell(lat, lon, H3_RES);
      const alt = searchParams.get("alt_m") || "60";
      const mass = searchParams.get("drone_mass_kg") || "5.5";
      const terrain = searchParams.get("terrain") || "suburban";

      const cache = caches.default;
      const cacheUrl = new URL(`https://lae-cache.internal/v3/cells/${h3Cell}?alt=${alt}&mass=${mass}&t=${terrain}`);
      const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

      const cached = await cache.match(cacheKey);
      if (cached) {
        const body = await cached.json();
        body.cache_status = "HIT_EDGE";
        return new Response(JSON.stringify(body, null, 2), { status: 200, headers: { ...CORS_HEADERS, "X-Edge-Cache": "HIT" } });
      }

      const evaluation = await evaluatePointClearance(lat, lon, Object.fromEntries(searchParams));
      evaluation.cache_status = "MISS_EVALUATED";

      const res = new Response(JSON.stringify(evaluation, null, 2), {
        status: 200,
        headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=180", "X-Edge-Cache": "MISS" }
      });

      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // 4. REST Corridor Evaluation
    if (pathname === "/v1/clearance-corridor" && request.method === "POST") {
      try {
        const body = await request.json();
        const waypoints = body.waypoints || [];
        const altRequested = body.alt_m || 60;
        const mass = body.drone_mass_kg || 5.5;
        const maxWind = body.max_wind_limit_ms || 12.0;
        const maxGust = body.max_gust_limit_ms || (maxWind * 1.35);

        if (!Array.isArray(waypoints) || waypoints.length === 0) {
          return new Response(JSON.stringify({ error: "Provide a 'waypoints' array: [[lat, lon], ...]" }), { status: 400, headers: CORS_HEADERS });
        }

        const corridorEvaluation = await evaluateCorridorClearance(waypoints, altRequested, mass, maxWind, maxGust);
        return new Response(JSON.stringify(corridorEvaluation, null, 2), { headers: CORS_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Malformed corridor payload", details: err.message }), { status: 400, headers: CORS_HEADERS });
      }
    }

    // 5. Distributed ACID 4D Corridor Reservation via Cloudflare Durable Object
    if (pathname === "/v1/reserve-corridor" && request.method === "POST") {
      try {
        const body = await request.json();
        const { waypoints, alt_m = 60, time_start_utc, time_end_utc, mission_id, priority_tier } = body;

        if (!waypoints || !time_start_utc || !time_end_utc || !mission_id) {
          return new Response(JSON.stringify({ error: "Missing required fields: 'waypoints', 'alt_m', 'time_start_utc', 'time_end_utc', 'mission_id'" }), { status: 400, headers: CORS_HEADERS });
        }

        // Partition by anchor H3 Res-6 district (~36 km²) to coordinate spatiotemporal slots without race conditions
        const anchorCell = latLngToCell(waypoints[0][0], waypoints[0][1], H3_DISTRICT_RES);
        const cells = Array.from(new Set(waypoints.map(wp => latLngToCell(wp[0], wp[1], H3_RES))));

        const doId = env.AIRSPACE_DO.idFromName(anchorCell);
        const doStub = env.AIRSPACE_DO.get(doId);

        const doResponse = await doStub.fetch("https://do.internal/reserve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cells, alt_m, time_start_utc, time_end_utc, mission_id, priority_tier, waypoints })
        });

        const doResult = await doResponse.json();

        if (doResult.conflict) {
          return new Response(JSON.stringify({
            reservation_status: "CONFLICT_DETECTED",
            conflict_details: doResult
          }, null, 2), { status: 409, headers: CORS_HEADERS });
        }

        return new Response(JSON.stringify({
          reservation_status: "CONFIRMED_4D_RESERVED",
          mission_id,
          district_partition: anchorCell,
          allocated_cells_count: doResult.allocated_slots,
          altitude_band_m: `${Math.floor(alt_m / 30) * 30}-${Math.floor(alt_m / 30) * 30 + 30}m`,
          window_start: time_start_utc,
          window_end: time_end_utc,
          reservation_witness: await generateClearanceHash({
            request_coordinates: waypoints[0],
            h3_index_res8: cells.join(":"),
            status: "RESERVED_4D_DURABLE",
            evaluated_at: new Date().toISOString()
          })
        }, null, 2), { headers: CORS_HEADERS });

      } catch (err) {
        return new Response(JSON.stringify({ error: "Failed to process Durable 4D reservation", details: err.message }), { status: 400, headers: CORS_HEADERS });
      }
    }

    // 6. In-Flight Live Conformance Monitoring Telemetry Ingestion
    if (pathname === "/v1/conformance/telemetry" && request.method === "POST") {
      try {
        const body = await request.json();
        const { mission_id, lat, lon, alt_agl_m, timestamp_utc } = body;

        if (!mission_id || lat === undefined || lon === undefined || alt_agl_m === undefined) {
          return new Response(JSON.stringify({ error: "Missing required telemetry fields: 'mission_id', 'lat', 'lon', 'alt_agl_m'" }), { status: 400, headers: CORS_HEADERS });
        }

        const anchorCell = latLngToCell(lat, lon, H3_DISTRICT_RES);
        const doId = env.AIRSPACE_DO.idFromName(anchorCell);
        const doStub = env.AIRSPACE_DO.get(doId);

        const doResponse = await doStub.fetch("https://do.internal/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mission_id, lat, lon, alt_agl_m, timestamp_utc: timestamp_utc || new Date().toISOString() })
        });

        const telemetryResult = await doResponse.json();
        return new Response(JSON.stringify(telemetryResult, null, 2), { headers: CORS_HEADERS });

      } catch (err) {
        return new Response(JSON.stringify({ error: "Failed to process in-flight telemetry", details: err.message }), { status: 400, headers: CORS_HEADERS });
      }
    }

    return new Response(JSON.stringify({ error: "Endpoint not found" }), { status: 404, headers: CORS_HEADERS });
  }
};
