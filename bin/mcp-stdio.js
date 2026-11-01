#!/usr/bin/env node
import { evaluatePointClearance, evaluateCorridor } from "../src/core/engine.js";

process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", async chunk => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rpc = JSON.parse(line);
      const res = await handleRpc(rpc);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: err.message } }) + "\n");
    }
  }
});

async function handleRpc({ id, method, params }) {
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "lae-airspace-risk-local", version: "3.1.0" }
      }
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "evaluate_airspace_clearance",
            description: "Evaluates single coordinate low-altitude flight clearance, wind shear, terrain AGL, and SORA GRC.",
            inputSchema: {
              type: "object",
              properties: {
                lat: { type: "number" },
                lon: { type: "number" },
                alt_m: { type: "number", default: 60 },
                drone_mass_kg: { type: "number", default: 5.5 },
                max_wind_limit_ms: { type: "number", default: 12.0 }
              },
              required: ["lat", "lon"]
            }
          },
          {
            name: "evaluate_and_route_corridor",
            description: "Evaluates full flight corridor. If blocked, provides A* H3 detour and MAVLink .plan export.",
            inputSchema: {
              type: "object",
              properties: {
                waypoints: { type: "array", items: { type: "array", items: { type: "number" } } },
                alt_m: { type: "number", default: 60 },
                drone_mass_kg: { type: "number", default: 5.5 },
                max_wind_limit_ms: { type: "number", default: 12.0 }
              },
              required: ["waypoints"]
            }
          }
        ]
      }
    };
  }

  if (method === "tools/call") {
    const args = params?.arguments || {};
    if (params?.name === "evaluate_airspace_clearance") {
      const result = await evaluatePointClearance(args.lat, args.lon, args);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
    }
    if (params?.name === "evaluate_and_route_corridor") {
      const result = await evaluateCorridor(args.waypoints, args.alt_m, args.drone_mass_kg, args.max_wind_limit_ms);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}
