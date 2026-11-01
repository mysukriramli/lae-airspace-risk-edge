/**
 * Malaysian Aerodrome Reference Points & Restricted Airspaces (WGS84)
 */
const RESTRICTED_AIRSPACES = [
  {
    icao: "WMSA",
    name: "Sultan Abdul Aziz Shah Airport (Subang)",
    lat: 3.1306,
    lon: 101.5497,
    radiusKm: 9.26, // 5 Nautical Miles CTR
    ceilingM: 1000
  },
  {
    icao: "WMKK",
    name: "Kuala Lumpur International Airport (KLIA)",
    lat: 2.7456,
    lon: 101.7099,
    radiusKm: 9.26,
    ceilingM: 1500
  },
  {
    icao: "WMPR",
    name: "Putrajaya Government Administrative Center (Prohibited Area)",
    lat: 2.9264,
    lon: 101.6964,
    radiusKm: 4.5,
    ceilingM: 600
  },
  {
    icao: "WMKF",
    name: "RMAF Simpang Air Base (Sungai Besi)",
    lat: 3.1114,
    lon: 101.7011,
    radiusKm: 5.5,
    ceilingM: 600
  }
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Validates coordinate against 3D Airspace Geofences
 */
export function checkAirspaceRestrictions(lat, lon, altitudeAglM) {
  for (const zone of RESTRICTED_AIRSPACES) {
    const dist = haversineKm(lat, lon, zone.lat, zone.lon);
    if (dist <= zone.radiusKm && altitudeAglM <= zone.ceilingM) {
      return {
        restricted: true,
        zone_id: zone.icao,
        zone_name: zone.name,
        distance_to_center_km: parseFloat(dist.toFixed(2)),
        minimum_separation_km: zone.radiusKm
      };
    }
  }

  return {
    restricted: false,
    zone_id: null,
    zone_name: null,
    distance_to_center_km: null,
    minimum_separation_km: null
  };
}
