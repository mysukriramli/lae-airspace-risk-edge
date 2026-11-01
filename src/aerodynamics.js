/**
 * Calculates initial forward azimuth / bearing in degrees between two coordinates
 */
export function calculateBearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const theta = Math.atan2(y, x);
  return (theta * (180 / Math.PI) + 360) % 360;
}

/**
 * Decomposes wind vector relative to flight track.
 * Returns headwind, crosswind, and estimated battery reserve multiplier.
 */
export function resolveRelativeWindVector(windSpeedMs, windDirDeg, trackBearingDeg, droneCruiseSpeedMs = 15.0) {
  // Angle between flight direction and where wind is coming from
  const angleRad = ((windDirDeg - trackBearingDeg) * Math.PI) / 180;

  // Headwind is positive, Tailwind is negative
  const headwindMs = parseFloat((windSpeedMs * Math.cos(angleRad)).toFixed(2));
  // Crosswind magnitude
  const crosswindMs = parseFloat(Math.abs(windSpeedMs * Math.sin(angleRad)).toFixed(2));

  // Effective ground speed along planned track
  const groundSpeedMs = Math.max(1.0, droneCruiseSpeedMs - headwindMs);

  // Aerodynamic power demand penalty factor (P ~ v^3 for drag compensation)
  let batteryReserveMultiplier = 1.0;
  if (headwindMs > 0) {
    batteryReserveMultiplier += (headwindMs / droneCruiseSpeedMs) * 0.45;
  } else {
    batteryReserveMultiplier -= Math.min(0.2, (Math.abs(headwindMs) / droneCruiseSpeedMs) * 0.2);
  }

  return {
    track_bearing_deg: Math.round(trackBearingDeg),
    headwind_component_ms: headwindMs,
    crosswind_component_ms: crosswindMs,
    effective_ground_speed_ms: parseFloat(groundSpeedMs.toFixed(1)),
    battery_reserve_margin_multiplier: parseFloat(batteryReserveMultiplier.toFixed(2))
  };
}
