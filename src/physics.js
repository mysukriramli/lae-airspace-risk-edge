export const SURFACE_ROUGHNESS = {
  water: 0.14,
  open_field: 0.18,
  suburban: 0.28,
  urban_canyon: 0.40
};

/**
 * Hellmann's power law: V(z) = V_10 * (z / 10)^alpha
 */
export function calculateWindShear(surfaceWindMs, altitudeAglM, terrainType = "suburban") {
  const alpha = SURFACE_ROUGHNESS[terrainType] ?? SURFACE_ROUGHNESS.suburban;
  const clampedAlt = Math.max(5, Math.min(altitudeAglM, 500));
  const windAtAlt = surfaceWindMs * Math.pow(clampedAlt / 10, alpha);
  return parseFloat(windAtAlt.toFixed(2));
}

/**
 * JARUS SORA Kinetic Energy & Ground Risk Class (GRC)
 * E_k = 0.5 * mass * v_terminal^2
 */
export function calculateGroundRiskClass(droneMassKg, populationDensity = "populated_urban") {
  const g = 9.80665;
  const rho = 1.225; // kg/m^3 air density
  const cd = 1.05;   // Aerodynamic drag for tumbling multi-rotor
  const area = 0.05 * Math.pow(droneMassKg, 0.66); // Frontal area scaling

  const terminalVelocity = Math.sqrt((2 * droneMassKg * g) / (rho * area * cd));
  const kineticEnergy = 0.5 * droneMassKg * Math.pow(terminalVelocity, 2);

  let grc = "GRC_1";
  if (kineticEnergy > 34000) {
    grc = populationDensity === "populated_urban" ? "GRC_6" : "GRC_4";
  } else if (kineticEnergy > 1084) {
    grc = populationDensity === "populated_urban" ? "GRC_4" : "GRC_3";
  } else if (kineticEnergy > 700) {
    grc = populationDensity === "populated_urban" ? "GRC_3" : "GRC_2";
  } else {
    grc = populationDensity === "populated_urban" ? "GRC_2" : "GRC_1";
  }

  return {
    terminal_velocity_ms: parseFloat(terminalVelocity.toFixed(1)),
    kinetic_impact_joules: Math.round(kineticEnergy),
    sora_ground_risk_class: grc
  };
}

/**
 * Solves the viable vertical flight corridor (20m - 150m AGL)
 * Returns safe min/max operational band if requested altitude is violated.
 */
export function resolveSafeAltitudeBand(surfaceWindMs, maxVehicleWindMs, terrainType) {
  const validAlts = [];
  for (let z = 20; z <= 150; z += 10) {
    const w = calculateWindShear(surfaceWindMs, z, terrainType);
    if (w <= maxVehicleWindMs) {
      validAlts.push(z);
    }
  }

  if (validAlts.length === 0) return null;

  return {
    min_m: validAlts[0],
    max_m: validAlts[validAlts.length - 1]
  };
}
