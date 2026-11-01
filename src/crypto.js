export async function generateClearanceHash(payload) {
  const canonicalString = JSON.stringify({
    coords: payload.request_coordinates,
    h3: payload.h3_index_res8,
    status: payload.clearance_status,
    grc: payload.sora_ground_risk_class,
    alt_band: payload.approved_altitude_band,
    evaluated_at: payload.evaluated_at_utc
  });

  const encoder = new TextEncoder();
  const data = encoder.encode(canonicalString);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return "sha256:" + hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}
