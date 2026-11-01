/**
 * Global Digital Elevation Model (DEM) Resolver
 * Queries open 90m/30m SRTM elevation grids to determine true ground elevation above sea level.
 */
export async function getTerrainElevationM(lat, lon) {
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "LAE-Airspace-Risk-Edge/2.1" },
      cf: { cacheTtl: 86400 * 30, cacheEverything: true } // Terrain elevation never changes; cache 30 days
    });

    if (!res.ok) throw new Error("Elevation query failed");
    const data = await res.json();
    return data.elevation?.[0] ?? 0.0;
  } catch {
    return 0.0; // Fail-soft fallback to sea level
  }
}
