export async function fetchSurfaceAeroMeteo(lat, lon) {
  const endpoint = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m&wind_speed_unit=ms`;

  try {
    const res = await fetch(endpoint, {
      headers: { "User-Agent": "LAE-Airspace-Risk-Edge/1.0" },
      cf: { cacheTtl: 300, cacheEverything: true }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cur = data.current || {};

    return {
      wind_speed_10m_ms: cur.wind_speed_10m ?? 2.5,
      wind_gusts_10m_ms: cur.wind_gusts_10m ?? 4.0,
      wind_direction_deg: cur.wind_direction_10m ?? 0,
      precipitation_mm_hr: cur.precipitation ?? 0.0,
      temperature_c: cur.temperature_2m ?? 28.0,
      source: "OPEN_METEO_AERO"
    };
  } catch {
    return {
      wind_speed_10m_ms: 3.0,
      wind_gusts_10m_ms: 5.0,
      wind_direction_deg: 90,
      precipitation_mm_hr: 0.0,
      temperature_c: 28.0,
      source: "FALLBACK_CLIMATOLOGY"
    };
  }
}
