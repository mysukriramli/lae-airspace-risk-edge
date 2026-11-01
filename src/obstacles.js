/**
 * Global Digital Elevation Model (DEM) Resolver
 */
export async function getTerrainElevationM(lat, lon) {
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "LAE-Airspace-Risk-Edge/3.0" },
      cf: { cacheTtl: 86400 * 30, cacheEverything: true }
    });
    if (!res.ok) return 0.0;
    const data = await res.json();
    return data.elevation?.[0] ?? 0.0;
  } catch {
    return 0.0;
  }
}

/**
 * 3D Urban Building Canopy Height Model (DSM)
 * Evaluates structural obstructions (high-rise cores, cranes, power lines) based on density zoning.
 */
export function estimateUrbanCanopyHeightM(terrainType = "suburban") {
  switch (terrainType) {
    case "urban_canyon":
      return {
        nominal_canopy_height_m: 65.0,
        tallest_obstacle_buffer_m: 110.0,
        minimum_safe_cruise_alt_agl_m: 135.0,
        obstacle_class: "HIGH_RISE_STRUCTURES_AND_CRANES"
      };
    case "suburban":
      return {
        nominal_canopy_height_m: 18.0,
        tallest_obstacle_buffer_m: 35.0,
        minimum_safe_cruise_alt_agl_m: 55.0,
        obstacle_class: "LOW_RESIDENTIAL_AND_UTILITY_POLES"
      };
    case "open_field":
      return {
        nominal_canopy_height_m: 0.0,
        tallest_obstacle_buffer_m: 15.0,
        minimum_safe_cruise_alt_agl_m: 30.0,
        obstacle_class: "GROUND_VEGETATION"
      };
    case "water":
      return {
        nominal_canopy_height_m: 0.0,
        tallest_obstacle_buffer_m: 5.0,
        minimum_safe_cruise_alt_agl_m: 20.0,
        obstacle_class: "OPEN_WATER_VESSEL_MASTS"
      };
    default:
      return {
        nominal_canopy_height_m: 15.0,
        tallest_obstacle_buffer_m: 30.0,
        minimum_safe_cruise_alt_agl_m: 50.0,
        obstacle_class: "MIXED_TERRAIN"
      };
  }
}

/**
 * Active Temporary Flight Restrictions (TFRs) and Dynamic Digital NOTAMs
 */
const ACTIVE_DYNAMIC_TFRS = [
  {
    tfr_id: "TFR-2026-WM-01",
    name: "Putrajaya Administrative Complex Geofence",
    center: [2.9264, 101.6964],
    radius_km: 4.5,
    ceiling_m_agl: 600,
    active_until_utc: "2026-12-31T23:59:59Z",
    reason: "VIP_GOVERNMENT_PROTECTION"
  },
  {
    tfr_id: "TFR-2026-US-NYC",
    name: "UN General Assembly Permanent Geofence",
    center: [40.7499, -73.9674],
    radius_km: 3.8,
    ceiling_m_agl: 750,
    active_until_utc: "2026-12-31T23:59:59Z",
    reason: "DIPLOMATIC_HEADQUARTERS"
  }
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function checkDynamicTFRs(lat, lon, altitudeAglM) {
  const now = new Date();

  for (const tfr of ACTIVE_DYNAMIC_TFRS) {
    if (new Date(tfr.active_until_utc) < now) continue;
    const dist = haversineKm(lat, lon, tfr.center[0], tfr.center[1]);
    if (dist <= tfr.radius_km && altitudeAglM <= tfr.ceiling_m_agl) {
      return {
        active_tfr_found: true,
        tfr_id: tfr.tfr_id,
        tfr_name: tfr.name,
        reason: tfr.reason,
        distance_km: parseFloat(dist.toFixed(2)),
        radius_km: tfr.radius_km,
        ceiling_m: tfr.ceiling_m_agl
      };
    }
  }

  return { active_tfr_found: false };
}
