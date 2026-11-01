import { evaluatePointClearance, evaluateCorridor } from "./core/engine.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // Agent Discovery
    if (pathname === "/" || pathname === "/llms.txt") {
      return new Response(JSON.stringify({
        service: "lae-airspace-risk-edge",
        version: "3.1.0",
        cost: "$0 Free Tier",
        hybrid_modes: {
          edge_url: url.origin,
          local_repo: "npx lae-airspace-risk-edge"
        },
        endpoints: {
          single_clearance: "GET /v1/clearance?lat={lat}&lon={lon}&alt_m={alt}",
          corridor_clearance: "POST /v1/clearance-corridor",
          mcp_http: "POST /mcp"
        }
      }, null, 2), { headers: CORS });
    }

    // Single Coordinate Clearance (Cached at Edge)
    if (pathname === "/v1/clearance" && request.method === "GET") {
      const lat = parseFloat(searchParams.get("lat"));
      const lon = parseFloat(searchParams.get("lon"));
      if (isNaN(lat) || isNaN(lon)) {
        return new Response(JSON.stringify({ error: "Missing 'lat' and 'lon'" }), { status: 400, headers: CORS });
      }

      const cache = caches.default;
      const cacheKey = new Request(request.url, { method: "GET" });
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const evalResult = await evaluatePointClearance(lat, lon, Object.fromEntries(searchParams));
      const res = new Response(JSON.stringify(evalResult, null, 2), {
        status: 200,
        headers: { ...CORS, "Cache-Control": "public, max-age=180" }
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // Corridor Evaluation & Detour Routing
    if (pathname === "/v1/clearance-corridor" && request.method === "POST") {
      try {
        const body = await request.json();
        const result = await evaluateCorridor(body.waypoints, body.alt_m, body.drone_mass_kg, body.max_wind_limit_ms);
        return new Response(JSON.stringify(result, null, 2), { headers: CORS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: CORS });
      }
    }

    // MCP JSON-RPC Endpoint (HTTP)
    if (pathname === "/mcp" && request.method === "POST") {
      try {
        const rpc = await request.json();
        const { id, method, params } = rpc;

        if (method === "initialize") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "lae-airspace-edge", version: "3.1.0" } }
          }), { headers: CORS });
        }

        if (method === "tools/list") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0", id,
            result: {
              tools: [
                {
                  name: "evaluate_airspace_clearance",
                  description: "Evaluates single coordinate flight clearance.",
                  inputSchema: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] }
                },
                {
                  name: "evaluate_and_route_corridor",
                  description: "Evaluates trajectory, provides A* detour and MAVLink plan.",
                  inputSchema: { type: "object", properties: { waypoints: { type: "array" } }, required: ["waypoints"] }
                }
              ]
            }
          }), { headers: CORS });
        }

        if (method === "tools/call") {
          const args = params?.arguments || {};
          if (params?.name === "evaluate_airspace_clearance") {
            const out = await evaluatePointClearance(args.lat, args.lon, args);
            return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } }), { headers: CORS });
          }
          if (params?.name === "evaluate_and_route_corridor") {
            const out = await evaluateCorridor(args.waypoints, args.alt_m, args.drone_mass_kg, args.max_wind_limit_ms);
            return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } }), { headers: CORS });
          }
        }

        return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Tool not found" } }), { status: 404, headers: CORS });
      } catch (err) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: err.message } }), { status: 500, headers: CORS });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: CORS });
  }
};
