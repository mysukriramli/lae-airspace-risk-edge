const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/**
 * Calculates great-circle distance between two points in meters
 */
export function calculateDistanceM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Calculates forward bearing between two coordinates in degrees
 */
export function calculateBearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Calculates perpendicular Cross-Track Error (XTE) in meters from planned route leg P1->P2 to current point P3
 */
export function calculateCrossTrackErrorM(lat1, lon1, lat2, lon2, lat3, lon3) {
  const d13 = calculateDistanceM(lat1, lon1, lat3, lon3) / EARTH_RADIUS_M;
  const theta13 = toRad(calculateBearingDeg(lat1, lon1, lat3, lon3));
  const theta12 = toRad(calculateBearingDeg(lat1, lon1, lat2, lon2));
  const xteRad = Math.asin(Math.sin(d13) * Math.sin(theta13 - theta12));
  return Math.abs(xteRad * EARTH_RADIUS_M);
}

/**
 * Evaluates live vehicle telemetry against approved trajectory
 */
export function evaluateTrajectoryConformance(currentLat, currentLon, currentAltAglM, waypoints, approvedAltAglM) {
  const LATERAL_CONTAINMENT_LIMIT_M = 25.0; // Standard urban containment bound
  const VERTICAL_CONTAINMENT_LIMIT_M = 15.0;

  let minCrossTrackM = Infinity;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    const xte = calculateCrossTrackErrorM(p1[0], p1[1], p2[0], p2[1], currentLat, currentLon);
    if (xte < minCrossTrackM) minCrossTrackM = xte;
  }

  if (minCrossTrackM === Infinity && waypoints.length > 0) {
    minCrossTrackM = calculateDistanceM(waypoints[0][0], waypoints[0][1], currentLat, currentLon);
  }

  const verticalDeviationM = Math.abs(currentAltAglM - approvedAltAglM);
  let status = "CONFORMING";
  let alertLevel = "GREEN";
  let message = "Vehicle operating strictly within approved 4D spatial corridor.";

  if (minCrossTrackM > LATERAL_CONTAINMENT_LIMIT_M * 1.5 || verticalDeviationM > VERTICAL_CONTAINMENT_LIMIT_M * 1.5) {
    status = "NON_CONFORMING_BREACH";
    alertLevel = "CRITICAL_RED";
    message = `Critical containment breach: Lateral error ${minCrossTrackM.toFixed(1)}m (limit ${LATERAL_CONTAINMENT_LIMIT_M}m), Vertical error ${verticalDeviationM.toFixed(1)}m.`;
  } else if (minCrossTrackM > LATERAL_CONTAINMENT_LIMIT_M || verticalDeviationM > VERTICAL_CONTAINMENT_LIMIT_M) {
    status = "WARN_CONTAINMENT_EXCURSION";
    alertLevel = "AMBER";
    message = `Containment excursion warning: Lateral error ${minCrossTrackM.toFixed(1)}m. Correct heading immediately.`;
  }

  return {
    conformance_status: status,
    alert_level: alertLevel,
    operational_message: message,
    metrics: {
      cross_track_error_m: parseFloat(minCrossTrackM.toFixed(2)),
      vertical_deviation_m: parseFloat(verticalDeviationM.toFixed(2)),
      max_lateral_allowable_m: LATERAL_CONTAINMENT_LIMIT_M,
      max_vertical_allowable_m: VERTICAL_CONTAINMENT_LIMIT_M
    }
  };
}
