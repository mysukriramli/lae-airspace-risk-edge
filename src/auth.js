/**
 * Authenticates enterprise client requests via Bearer token
 */
export function validateEnterpriseToken(request, env) {
  if (env.REQUIRE_API_KEY !== "true") return { authorized: true, client_id: "PUBLIC_EVALUATOR" };

  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { authorized: false, error: "Missing or malformed Authorization header. Expected 'Bearer <key>'." };
  }

  const token = authHeader.replace("Bearer ", "").trim();
  const validKeys = (env.ENTERPRISE_API_KEYS || "lae_live_testkey_12345").split(",");

  if (validKeys.includes(token)) {
    return { authorized: true, client_id: `ORG_${token.slice(0, 8)}` };
  }

  return { authorized: false, error: "Unauthorized: Invalid or revoked enterprise API token." };
}
