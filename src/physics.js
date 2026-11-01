export const SURFACE_ROUGHNESS = {
  water: 0.12,
  open_field: 0.16,
  suburban: 0.28,
  urban_canyon: 0.42
};

const P0_SEA_LEVEL_HPA = 1013.25;
const R_SPECIFIC_AIR = 287.058;
const GRAVITY = 9.80665;

export function calculateDensityAltitude(tempC, pressureHpa, altitudeAglM) {
  const tempK = tempC + 273.15;
  const pressurePa = pressureHpa * 100;
  const airDensity = pressurePa / (R_SPECIFIC_AIR * tempK);
  const pressureAltitudeM = (1 - Math.pow(pressureHpa / P0_SEA_LEVEL_HPA, 0.190284)) * 44307.69;
  const standardTempAtAltC = 15 - 0.0065 * pressureAltitudeM;
  const densityAltitudeM = pressureAltitudeM + 118.8 * (tempC - standardTempAtAltC);
  const thrustEfficiencyFactor = Math.min(1.0, parseFloat((airDensity / 1.225).toFixed(3)));

  return {
    air_density_kg_m3: parseFloat(airDensity.toFixed(3)),
    density_altitude_m: Math.round(densityAltitudeM),
    thrust_efficiency_factor: thrustEfficiencyFactor
  };
}

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

export function resolveRelativeWindVector(windSpeedMs, windDirDeg, trackBearingDeg, droneCruiseSpeedMs = 15.0) {
  const angleRad = ((windDirDeg - trackBearingDeg) * Math.PI) / 180;
  const headwindMs = parseFloat((windSpeedMs * Math.cos(angleRad)).toFixed(2));
  const crosswindMs = parseFloat(Math.abs(windSpeedMs * Math.sin(angleRad)).toFixed(2));
  const groundSpeedMs = Math.max(1.0, droneCruiseSpeedMs - headwindMs);

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

export function evaluateC2LinkRisk(altitudeAglM) {
  if (altitudeAglM > 120) {
    return {
      c2_link_safety: "POOR_SIDELOBE_INTERFERENCE",
      handover_oscillation_risk: "HIGH",
      recommended_action: "FORCE_LOCAL_WAYPOINT_INDEPENDENCE"
    };
  }
  if (altitudeAglM > 75) {
    return {
      c2_link_safety: "MODERATE_ELEVATED_NOISE",
      handover_oscillation_risk: "MEDIUM",
      recommended_action: "MONITOR_PACKET_JITTER"
    };
  }
  return {
    c2_link_safety: "OPTIMAL",
    handover_oscillation_risk: "LOW",
    recommended_action: "NOMINAL"
  };
}

export function calculateGroundRiskClass(droneMassKg, airDensity = 1.225, populationDensity = "populated_urban", m2MitigationApplied = false) {
  const cd = 1.15;
  const frontalArea = 0.05 * Math.pow(droneMassKg, 0.66);
  const terminalVelocity = Math.sqrt((2 * droneMassKg * GRAVITY) / (airDensity * frontalArea * cd));
  const kineticEnergyJoules = 0.5 * droneMassKg * Math.pow(terminalVelocity, 2);

  let baselineGrcNumber = 1;
  if (kineticEnergyJoules > 34000) {
    baselineGrcNumber = populationDensity === "populated_urban" ? 6 : 4;
  } else if (kineticEnergyJoules > 1084) {
    baselineGrcNumber = populationDensity === "populated_urban" ? 4 : 3;
  } else if (kineticEnergyJoules > 700) {
    baselineGrcNumber = populationDensity === "populated_urban" ? 3 : 2;
  } else {
    baselineGrcNumber = populationDensity === "populated_urban" ? 2 : 1;
  }

  const finalGrcNumber = m2MitigationApplied ? Math.max(1, baselineGrcNumber - 1) : baselineGrcNumber;

  return {
    terminal_velocity_ms: parseFloat(terminalVelocity.toFixed(1)),
    kinetic_impact_joules: Math.round(kineticEnergyJoules),
    baseline_grc: `GRC_${baselineGrcNumber}`,
    sora_ground_risk_class: `GRC_${finalGrcNumber}`,
    m2_mitigation_applied: m2MitigationApplied
  };
}

export function resolveSafeAltitudeBand(surfaceWindMs, surfaceGustMs, maxVehicleWindMs, maxVehicleGustMs, terrainType, minSafeAltAgl = 20) {
  const validAlts = [];
  const startAlt = Math.ceil(minSafeAltAgl / 10) * 10;

  for (let z = startAlt; z <= 150; z += 10) {
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
