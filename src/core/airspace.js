const GLOBAL_CORE_AERODROMES = [
  { id: "WMSA", name: "Subang Sultan Abdul Aziz Shah", lat: 3.1306, lon: 101.5497, radiusKm: 9.26 },
  { id: "WMKK", name: "Kuala Lumpur International (KLIA)", lat: 2.7456, lon: 101.7099, radiusKm: 9.26 },
  { id: "WSSS", name: "Singapore Changi Airport", lat: 1.3644, lon: 103.9915, radiusKm: 9.26 },
  { id: "WSAP", name: "Paya Lebar Airbase", lat: 1.3603, lon: 103.9094, radiusKm: 9.26 },
  { id: "VTBS", name: "Bangkok Suvarnabhumi Airport", lat: 13.6900, lon: 100.7501, radiusKm: 9.26 },
  { id: "VHHH", name: "Hong Kong Chek Lap Kok", lat: 22.3080, lon: 113.9185, radiusKm: 9.26 },
  { id: "RJTT", name: "Tokyo Haneda International", lat: 35.5494, lon: 139.7798, radiusKm: 9.26 },
  { id: "EGLL", name: "London Heathrow", lat: 51.4700, lon: -0.4543, radiusKm: 9.26 },
  { id: "LFPG", name: "Paris Charles de Gaulle", lat: 49.0097, lon: 2.5479, radiusKm: 9.26 },
  { id: "EDDF", name: "Frankfurt Main", lat: 50.0379, lon: 8.5622, radiusKm: 9.26 },
  { id: "KJFK", name: "New York John F. Kennedy", lat: 40.6413, lon: -73.7781, radiusKm: 9.26 },
  { id: "KLAX", name: "Los Angeles International", lat: 33.9416, lon: -118.4085, radiusKm: 9.26 },
  { id: "OMDB", name: "Dubai International", lat: 25.2532, lon: 55.3657, radiusKm: 9.26 },
  { id: "YSSY", name: "Sydney Kingsford Smith", lat: -33.9399, lon: 151.1753, radiusKm: 9.26 }
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

export async function getTerrainElevationM(lat, lon) {
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return 0.0;
    const data = await res.json();
    return data.elevation?.[0] ?? 0.0;
  } catch {
    return 0.0;
  }
}

export function estimateUrbanCanopyHeightM(terrainType = "suburban") {
  switch (terrainType) {
    case "urban_canyon":
      return { nominal_canopy_height_m: 65.0, minimum_safe_cruise_alt_agl_m: 110.0 };
    case "suburban":
      return { nominal_canopy_height_m: 18.0, minimum_safe_cruise_alt_agl_m: 45.0 };
    case "open_field":
      return { nominal_canopy_height_m: 0.0, minimum_safe_cruise_alt_agl_m: 25.0 };
    case "water":
      return { nominal_canopy_height_m: 0.0, minimum_safe_cruise_alt_agl_m: 20.0 };
    default:
      return { nominal_canopy_height_m: 15.0, minimum_safe_cruise_alt_agl_m: 40.0 };
  }
}

export async function checkAirspaceRestrictions(lat, lon, altitudeAglM) {
  const ICAO_CTR_RADIUS_KM = 9.26;
  const ICAO_CTR_CEILING_M = 1000;

  for (const port of GLOBAL_CORE_AERODROMES) {
    const dist = haversineKm(lat, lon, port.lat, port.lon);
    if (dist <= port.radiusKm && altitudeAglM <= ICAO_CTR_CEILING_M) {
      return {
        status: "RESTRICTED",
        zone_id: port.id,
        zone_name: port.name,
        distance_to_center_km: parseFloat(dist.toFixed(2)),
        minimum_separation_km: port.radiusKm
      };
    }
  }

  // Dynamic worldwide NOAA CTR fallback
  const latDelta = 0.16;
  const lonDelta = 0.16 / Math.max(0.2, Math.cos(lat * (Math.PI / 180)));
  const endpoint = `https://aviationweather.gov/api/data/metar?bbox=${(lat - latDelta).toFixed(4)},${(lon - lonDelta).toFixed(4)},${(lat + latDelta).toFixed(4)},${(lon + lonDelta).toFixed(4)}&format=geojson`;

  try {
    const res = await fetch(endpoint);
    if (res.ok) {
      const geojson = await res.json();
      for (const feature of geojson.features || []) {
        const [stationLon, stationLat] = feature.geometry.coordinates;
        const distKm = haversineKm(lat, lon, stationLat, stationLon);
        if (distKm <= ICAO_CTR_RADIUS_KM && altitudeAglM <= ICAO_CTR_CEILING_M) {
          return {
            status: "RESTRICTED",
            zone_id: feature.properties?.id || "AERODROME",
            zone_name: feature.properties?.site || "Controlled Aerodrome",
            distance_to_center_km: parseFloat(distKm.toFixed(2)),
            minimum_separation_km: ICAO_CTR_RADIUS_KM
          };
        }
      }
      return { status: "UNCONTROLLED" };
    }
  } catch {}

  return { status: "UNCONTROLLED" };
}
