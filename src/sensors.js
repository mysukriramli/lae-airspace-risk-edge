export async function fetchSurfaceAeroMeteo(lat, lon) {
  const endpoint = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,surface_pressure,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m&wind_speed_unit=ms`;

  try {
    const res = await fetch(endpoint, {
      headers: { "User-Agent": "LAE-Airspace-Risk-Edge/3.0" },
      cf: { cacheTtl: 180, cacheEverything: true }
    });

    if (!res.ok) throw new Error(`Upstream weather returned HTTP ${res.status}`);
    const data = await res.json();
    const cur = data.current || {};

    const windSpeed = cur.wind_speed_10m;
    const windGusts = cur.wind_gusts_10m;
    const pressure = cur.surface_pressure;
    const temp = cur.temperature_2m;

    if (windSpeed === undefined || pressure === undefined) {
      throw new Error("Essential meteorological fields missing in upstream payload");
    }

    return {
      valid: true,
      wind_speed_10m_ms: parseFloat(windSpeed.toFixed(2)),
      wind_gusts_10m_ms: parseFloat((windGusts ?? (windSpeed * 1.35)).toFixed(2)),
      wind_direction_deg: cur.wind_direction_10m ?? 0,
      surface_pressure_hpa: parseFloat(pressure.toFixed(1)),
      temperature_c: parseFloat((temp ?? 25.0).toFixed(1)),
      relative_humidity_pct: cur.relative_humidity_2m ?? 70,
      precipitation_mm_hr: cur.precipitation ?? 0.0,
      source: "OPEN_METEO_WMO_FEED"
    };
  } catch (err) {
    return {
      valid: false,
      error_message: err.message,
      source: "TELEMETRY_UNAVAILABLE"
    };
  }
}
