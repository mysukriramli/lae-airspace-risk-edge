/**
 * Global Terrain Roughness Classes (Hellmann exponent alpha)
 */
export const SURFACE_ROUGHNESS = {
  water: 0.12,
  open_field: 0.16,
  suburban: 0.28,
  urban_canyon: 0.42
};

/**
 * Standard Atmospheric Constants (ICAO Standard Atmosphere)
 */
const P0_SEA_LEVEL_HPA = 1013.25;
const T0_SEA_LEVEL_K = 288.15; // 15 degrees Celsius
const R_SPECIFIC_AIR = 287.058; // J/(kg·K)
const GRAVITY = 9.80665; // m/s^2

/**
 * Calculates local air density (rho in kg/m^3) and Density Altitude (meters).
 * Direct impact on drone rotor thrust efficiency and battery discharge rates.
 */
export function calculateDensityAltitude(tempC, pressureHpa, altitudeAglM) {
  const tempK = tempC + 273.15;
  const pressurePa = pressureHpa * 100;
  
  // Real air density using ideal gas law: rho = P / (R * T)
  const airDensity = pressurePa / (R_SPECIFIC_AIR * tempK);
  
  // Standard temperature at current pressure altitude
  const pressureAltitudeM = (1 - Math.pow(pressureHpa / P0_SEA_LEVEL_HPA, 0.190284)) * 44307.69;
  const standardTempAtAltC = 15 - (0.0065 * pressureAltitudeM);
  
  // Density Altitude: approx. Pressure Altitude + 118.8 * (OAT - ISA Temp)
  const densityAltitudeM = pressureAltitudeM + (118.8 * (tempC - standardTempAtAltC));
  
  // Aerodynamic thrust penalty factor relative to standard sea-level air (1.225 kg/m^3)
  const thrustEfficiencyFactor = Math.min(1.0, parseFloat((airDensity / 1.225).toFixed(3)));

  return {
    air_density_kg_m3: parseFloat(airDensity.toFixed(3)),
    density_altitude_m: Math.round(densityAltitudeM),
    thrust_efficiency_factor: thrustEfficiencyFactor
  };
}

/**
 * Calculates both steady wind shear and peak instantaneous gust shear at altitude z (m AGL).
 * Gust exponent is typically ~50% of the mean wind exponent due to turbulent mixing.
 */
export function calculateAeroWindProfile(surfaceWindMs, surfaceGustMs, altitudeAglM, terrainType = "suburban") {
  const alphaMean = SURFACE_ROUGHNESS[terrainType] ?? SURFACE_ROUGHNESS.suburban;
  const alphaGust = alphaMean * 0.55; 
  const clampedAlt = Math.max(5, Math.min(altitudeAglM, 500));

  const windAtAlt = surfaceWindMs * Math.pow(clampedAlt / 10, alphaMean);
  const gustAtAlt = surfaceGustMs * Math.pow(clampedAlt / 10, alphaGust);

  return {
    steady_wind_at_alt_ms: parseFloat(windAtAlt.toFixed(2)),
    peak_gust_at_alt_ms: parseFloat(gustAtAlt.toFixed(2)),
    shear_gradient_delta: parseFloat((windAtAlt - surfaceWindMs).toFixed(2))
  };
}

/**
 * JARUS SORA Kinetic Impact Energy Class (GRC)
 * Density-corrected terminal velocity calculation:
 * v_t = sqrt((2 * m * g) / (rho * A * Cd))
 */
export function calculateGroundRiskClass(droneMassKg, airDensity = 1.225, populationDensity = "populated_urban") {
  const cd = 1.15; // Realistic drag coefficient for tumbling unpowered multirotor
  const frontalArea = 0.05 * Math.pow(droneMassKg, 0.66); // Projected impact area

  const terminalVelocity = Math.sqrt((2 * droneMassKg * GRAVITY) / (airDensity * frontalArea * cd));
  const kineticEnergyJoules = 0.5 * droneMassKg * Math.pow(terminalVelocity, 2);

  let grc = "GRC_1";
  if (kineticEnergyJoules > 34000) {
    grc = populationDensity === "populated_urban" ? "GRC_6" : "GRC_4";
  } else if (kineticEnergyJoules > 1084) {
    grc = populationDensity === "populated_urban" ? "GRC_4" : "GRC_3";
  } else if (kineticEnergyJoules > 700) {
    grc = populationDensity === "populated_urban" ? "GRC_3" : "GRC_2";
  } else {
    grc = populationDensity === "populated_urban" ? "GRC_2" : "GRC_1";
  }

  return {
    terminal_velocity_ms: parseFloat(terminalVelocity.toFixed(1)),
    kinetic_impact_joules: Math.round(kineticEnergyJoules),
    sora_ground_risk_class: grc
  };
}

/**
 * Altitude Band Solver: Solves for the certified flight corridor (20m - 150m AGL).
 * Evaluates both steady wind and peak gust envelopes against vehicle limits.
 */
export function resolveSafeAltitudeBand(surfaceWindMs, surfaceGustMs, maxVehicleWindMs, maxVehicleGustMs, terrainType) {
  const validAlts = [];

  for (let z = 20; z <= 150; z += 10) {
    const profile = calculateAeroWindProfile(surfaceWindMs, surfaceGustMs, z, terrainType);
    if (profile.steady_wind_at_alt_ms <= maxVehicleWindMs && profile.peak_gust_at_alt_ms <= maxVehicleGustMs) {
      validAlts.push(z);
    }
  }

  if (validAlts.length === 0) return null;

  return {
    min_m: validAlts[0],
    max_m: validAlts[validAlts.length - 1]
  };
}
