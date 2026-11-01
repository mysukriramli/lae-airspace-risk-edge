import { latLngToCell } from "h3-js";
import { 
  calculateAeroWindProfile, 
  calculateDensityAltitude, 
  calculateGroundRiskClass, 
  resolveSafeAltitudeBand, 
  resolveRelativeWindVector, 
  evaluateC2LinkRisk 
} from "./aerodynamics.js";
import { checkAirspaceRestrictions, getTerrainElevationM, estimateUrbanCanopyHeightM } from "./airspace.js";
import { findDetourPath } from "./routing.js";
import { exportToMavlinkPlan } from "./mavlink.js";

export const H3_RES = 8; // ~460m hexagonal sector diameter

export async function generateClearanceHash(payload) {
  const canonicalString = JSON.stringify({
    coords: payload.request_coordinates,
    h3_sector: payload.h3_index_res8,
    status: payload.clearance_status,
    sora_grc: payload.sora_ground_risk_class,
    approved_band: payload.approved_altitude_band,
    evaluated_at: payload.evaluated_at_utc
  });
  const data = new TextEncoder().encode(canonicalString);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return "sha256:" + Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,surface_pressure,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m&wind_speed_unit=ms`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather API status " + res.status);
    const cur = (await res.json()).current || {};
    return {
      valid: true,
      wind_speed_10m_ms: cur.wind_speed_10m ?? 2.5,
      wind_gusts_10m_ms: cur.wind_gusts_10m ?? 4.0,
      wind_direction_deg: cur.wind_direction_10m ?? 0,
      surface_pressure_hpa: cur.surface_pressure ?? 1013.2,
      temperature_c: cur.temperature_2m ?? 26.0,
      precipitation_mm_hr: cur.precipitation ?? 0.0
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

export async function evaluatePointClearance(lat, lon, params = {}) {
  const h3Cell = latLngToCell(lat, lon, H3_RES);
  const altRequestedAgl = parseFloat(params.alt_m || "60");
  const droneMassKg = parseFloat(params.drone_mass_kg || "5.5");
  const maxVehicleWindMs = parseFloat(params.max_wind_limit_ms || "12.0");
  const maxVehicleGustMs = parseFloat(params.max_gust_limit_ms || (maxVehicleWindMs * 1.35).toFixed(1));
  const terrainType = params.terrain || "suburban";
  const bearing = params.bearing_deg !== undefined ? parseFloat(params.bearing_deg) : null;
  const m2Mitigation = params.m2_ground_mitigation === true || params.m2_ground_mitigation === "true";

  // 1. Airspace Check
  const airspace = await checkAirspaceRestrictions(lat, lon, altRequestedAgl);
  if (airspace.status === "RESTRICTED") {
    const denied = {
      request_coordinates: { latitude: lat, longitude: lon },
      h3_index_res8: h3Cell,
      clearance_status: "DENIED_RESTRICTED_AIRSPACE",
      operational_reasoning: `Penetrates controlled airspace: ${airspace.zone_name} (${airspace.zone_id}).`,
      reroute_required: true,
      airspace_constraint: airspace,
      evaluated_at_utc: new Date().toISOString()
    };
    denied.mission_certificate = await generateClearanceHash(denied);
    return denied;
  }

  // 2. Terrain DEM & Canopy Check
  const terrainElevationM = await getTerrainElevationM(lat, lon);
  const urbanCanopy = estimateUrbanCanopyHeightM(terrainType);
  if (altRequestedAgl < urbanCanopy.minimum_safe_cruise_alt_agl_m) {
    const obstacleDenied = {
      request_coordinates: { latitude: lat, longitude: lon },
      h3_index_res8: h3Cell,
      clearance_status: "DENIED_OBSTACLE_CLEARANCE_VIOLATION",
      operational_reasoning: `Altitude (${altRequestedAgl}m) penetrates canopy floor. Minimum is ${urbanCanopy.minimum_safe_cruise_alt_agl_m}m.`,
      reroute_required: true,
      approved_altitude_band: { min_m: urbanCanopy.minimum_safe_cruise_alt_agl_m, max_m: 120 },
      evaluated_at_utc: new Date().toISOString()
    };
    obstacleDenied.mission_certificate = await generateClearanceHash(obstacleDenied);
    return obstacleDenied;
  }

  // 3. Weather
  const meteo = await fetchWeather(lat, lon);
  if (!meteo.valid) {
    const defer = {
      request_coordinates: { latitude: lat, longitude: lon },
      h3_index_res8: h3Cell,
      clearance_status: "DEFER_TELEMETRY_UNAVAILABLE",
      operational_reasoning: "Meteorological telemetry unavailable. Clearance deferred.",
      reroute_required: true,
      evaluated_at_utc: new Date().toISOString()
    };
    defer.mission_certificate = await generateClearanceHash(defer);
    return defer;
  }

  // 4. Physics Modeling
  const density = calculateDensityAltitude(meteo.temperature_c, meteo.surface_pressure_hpa, altRequestedAgl);
  const aeroWind = calculateAeroWindProfile(meteo.wind_speed_10m_ms, meteo.wind_gusts_10m_ms, altRequestedAgl, terrainType);
  const sora = calculateGroundRiskClass(droneMassKg, density.air_density_kg_m3, "populated_urban", m2Mitigation);
  const c2Profile = evaluateC2LinkRisk(altRequestedAgl);
  const viableBand = resolveSafeAltitudeBand(
    meteo.wind_speed_10m_ms, meteo.wind_gusts_10m_ms,
    maxVehicleWindMs, maxVehicleGustMs,
    terrainType, urbanCanopy.minimum_safe_cruise_alt_agl_m
  );

  let vectorAerodynamics = null;
  if (bearing !== null) {
    vectorAerodynamics = resolveRelativeWindVector(aeroWind.steady_wind_at_alt_ms, meteo.wind_direction_deg, bearing);
  }

  let status = "CLEARED_GREEN";
  let reason = "All parameters nominal.";
  let rerouteRequired = false;

  if (aeroWind.peak_gust_at_alt_ms > maxVehicleGustMs) {
    status = "DENIED_GUST_TURBULENCE_EXCEEDED";
    reason = `Gust (${aeroWind.peak_gust_at_alt_ms} m/s) exceeds limit of ${maxVehicleGustMs} m/s.`;
    rerouteRequired = true;
  } else if (aeroWind.steady_wind_at_alt_ms > maxVehicleWindMs) {
    status = "DENIED_WIND_SHEAR_EXCEEDED";
    reason = `Wind (${aeroWind.steady_wind_at_alt_ms} m/s) exceeds limit of ${maxVehicleWindMs} m/s.`;
    rerouteRequired = true;
  } else if (meteo.precipitation_mm_hr > 12.0) {
    status = "DENIED_CONVECTIVE_PRECIPITATION";
    reason = "Precipitation violates VFR limit.";
    rerouteRequired = true;
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
      calculated_flight_amsl_m: terrainElevationM + altRequestedAgl
    },
    approved_altitude_band: viableBand,
    aerodynamic_telemetry: {
      steady_wind_at_alt_ms: aeroWind.steady_wind_at_alt_ms,
      peak_gust_at_alt_ms: aeroWind.peak_gust_at_alt_ms,
      precipitation_mm_hr: meteo.precipitation_mm_hr
    },
    vector_aerodynamics: vectorAerodynamics,
    c2_telecommunications_profile: c2Profile,
    sora_ground_risk_class: sora.sora_ground_risk_class,
    kinetic_impact_profile: {
      drone_mass_kg: droneMassKg,
      kinetic_impact_joules: sora.kinetic_impact_joules
    },
    evaluated_at_utc: new Date().toISOString()
  };

  payload.mission_certificate = await generateClearanceHash(payload);
  return payload;
}

export async function evaluateCorridor(waypoints, altM = 60, massKg = 5.5, maxWind = 12.0) {
  const blockedH3s = new Set();
  const segments = [];
  let overallCleared = true;
  let bottleneck = null;

  for (const wp of waypoints) {
    const res = await evaluatePointClearance(wp[0], wp[1], { alt_m: altM, drone_mass_kg: massKg, max_wind_limit_ms: maxWind });
    segments.push(res);
    if (res.clearance_status !== "CLEARED_GREEN") {
      overallCleared = false;
      bottleneck = res.operational_reasoning;
      blockedH3s.add(res.h3_index_res8);
    }
  }

  let detour = null;
  if (!overallCleared && waypoints.length >= 2) {
    const startH3 = latLngToCell(waypoints[0][0], waypoints[0][1], H3_RES);
    const goalH3 = latLngToCell(waypoints[waypoints.length - 1][0], waypoints[waypoints.length - 1][1], H3_RES);
    detour = findDetourPath(startH3, goalH3, blockedH3s);
  }

  return {
    corridor_status: overallCleared ? "CLEARED_CORRIDOR" : "DENIED_CORRIDOR",
    bottleneck_reason: bottleneck,
    segments,
    detour_solution: detour,
    mavlink_plan: overallCleared ? exportToMavlinkPlan(waypoints, altM) : (detour?.coordinates ? exportToMavlinkPlan(detour.coordinates, altM) : null)
  };
}
