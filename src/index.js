import { evaluatePointClearance, evaluateCorridor } from "./core/engine.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // 2. Agent Discovery Manifest
    if (pathname === "/" || pathname === "/llms.txt") {
      return new Response(JSON.stringify({
        service: "lae-airspace-risk-edge",
        version: "3.1.0",
        cost: "$0 Free Tier",
        hybrid_modes: {
          edge_url: url.origin,
          local_repo: "node bin/mcp-stdio.js"
        },
        endpoints: {
          single_clearance: "GET /v1/clearance?lat={lat}&lon={lon}&alt_m={alt}&drone_mass_kg={mass}&max_wind_limit_ms={limit}",
          corridor_clearance: "POST /v1/clearance-corridor",
          mcp_json_rpc: "POST /mcp"
        },
        regulatory_standards: "ICAO Annex 2/11 CTR + JARUS SORA v2.5 GRC"
      }, null, 2), { headers: CORS_HEADERS });
    }

    // 3. Single Coordinate Clearance Evaluation (Edge Cached)
    if (pathname === "/v1/clearance" && request.method === "GET") {
      const lat = parseFloat(searchParams.get("lat"));
      const lon = parseFloat(searchParams.get("lon"));

      if (isNaN(lat) || isNaN(lon)) {
        return new Response(JSON.stringify({ error: "Missing required 'lat' and 'lon' query parameters" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      // Edge DRAM Cache check
      const cache = caches.default;
      const cacheKey = new Request(request.url, { method: "GET" });
      const cached = await cache.match(cacheKey);

      if (cached) {
        const cachedBody = await cached.json();
        cachedBody.cache_status = "HIT_EDGE";
        return new Response(JSON.stringify(cachedBody, null, 2), {
          status: 200,
          headers: { ...CORS_HEADERS, "X-Edge-Cache": "HIT" }
        });
      }

      const evalResult = await evaluatePointClearance(lat, lon, Object.fromEntries(searchParams));
      evalResult.cache_status = "MISS_EVALUATED";

      const res = new Response(JSON.stringify(evalResult, null, 2), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=180",
          "X-Edge-Cache": "MISS"
        }
      });

      // Non-blocking write to Anycast edge cache
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // 4. Corridor Evaluation, A* Detour & MAVLink Plan Export
    if (pathname === "/v1/clearance-corridor" && request.method === "POST") {
      try {
        const body = await request.json();
        const waypoints = body.waypoints;

        if (!Array.isArray(waypoints) || waypoints.length === 0) {
          return new Response(JSON.stringify({ error: "Provide a 'waypoints' array: [[lat, lon], ...]" }), {
            status: 400,
            headers: CORS_HEADERS
          });
        }

        const altM = body.alt_m || 60;
        const massKg = body.drone_mass_kg || 5.5;
        const maxWind = body.max_wind_limit_ms || 12.0;

        const result = await evaluateCorridor(waypoints, altM, massKg, maxWind);
        return new Response(JSON.stringify(result, null, 2), { headers: CORS_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Malformed corridor request", details: err.message }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }
    }

    // 5. Model Context Protocol (MCP) JSON-RPC 2.0 Handler
    if (pathname === "/mcp" && request.method === "POST") {
      try {
        const rpc = await request.json();
        const { id, method, params } = rpc;

        // MCP Handshake
        if (method === "initialize") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "lae-airspace-edge", version: "3.1.0" }
            }
          }), { headers: CORS_HEADERS });
        }

        // Handle initialized notification (MUST return 204 or empty response without error)
        if (method === "notifications/initialized") {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // Handle ping
        if (method === "ping") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), { headers: CORS_HEADERS });
        }

        // List Available Tools
        if (method === "tools/list") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "evaluate_airspace_clearance",
                  description: "Evaluates single coordinate low-altitude flight clearance, wind shear, terrain AGL clearance, and SORA GRC.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      lat: { type: "number", description: "Target latitude" },
                      lon: { type: "number", description: "Target longitude" },
                      alt_m: { type: "number", default: 60, description: "Flight altitude AGL in meters" },
                      drone_mass_kg: { type: "number", default: 5.5, description: "Aircraft all-up mass in kg" },
                      max_wind_limit_ms: { type: "number", default: 12.0, description: "Max certified steady wind rating in m/s" }
                    },
                    required: ["lat", "lon"]
                  }
                },
                {
                  name: "evaluate_and_route_corridor",
                  description: "Evaluates trajectory over waypoints. If airspace is blocked, solves A* H3 detour and exports MAVLink .plan.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      waypoints: {
                        type: "array",
                        items: { type: "array", items: { type: "number" } },
                        description: "Array of [lat, lon] waypoints"
                      },
                      alt_m: { type: "number", default: 60 },
                      drone_mass_kg: { type: "number", default: 5.5 },
                      max_wind_limit_ms: { type: "number", default: 12.0 }
                    },
                    required: ["waypoints"]
                  }
                }
              ]
            }
          }), { headers: CORS_HEADERS });
        }

        // Execute Tool
        if (method === "tools/call") {
          const toolName = params?.name;
          const args = params?.arguments || {};

          if (toolName === "evaluate_airspace_clearance") {
            const out = await evaluatePointClearance(args.lat, args.lon, args);
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] }
            }), { headers: CORS_HEADERS });
          }

          if (toolName === "evaluate_and_route_corridor") {
            const out = await evaluateCorridor(args.waypoints, args.alt_m, args.drone_mass_kg, args.max_wind_limit_ms);
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] }
            }), { headers: CORS_HEADERS });
          }

          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Tool '${toolName}' not found` }
          }), { status: 404, headers: CORS_HEADERS });
        }

        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: `Unsupported method '${method}'` }
        }), { status: 400, headers: CORS_HEADERS });

      } catch (err) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32700, message: `Parse error: ${err.message}` }
        }), { status: 500, headers: CORS_HEADERS });
      }
    }

    return new Response(JSON.stringify({ error: "Endpoint not found" }), { status: 404, headers: CORS_HEADERS });
  }
};
