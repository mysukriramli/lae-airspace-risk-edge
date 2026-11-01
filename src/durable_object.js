import { evaluateTrajectoryConformance } from "./conformance.js";

export class AirspaceCorridorDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.reservations = new Map();
    this.activeMissions = new Map();

    this.ctx.blockConcurrencyWhile(async () => {
      const storedRes = await this.ctx.storage.get("reservations");
      if (storedRes) this.reservations = new Map(JSON.parse(storedRes));
      const storedMissions = await this.ctx.storage.get("activeMissions");
      if (storedMissions) this.activeMissions = new Map(JSON.parse(storedMissions));
    });
  }

  cleanExpired() {
    const now = Date.now();
    let modified = false;

    for (const [key, record] of this.reservations.entries()) {
      if (record.expiresAt < now) {
        this.reservations.delete(key);
        modified = true;
      }
    }

    for (const [missionId, mission] of this.activeMissions.entries()) {
      if (new Date(mission.window_end).getTime() < now) {
        this.activeMissions.delete(missionId);
        modified = true;
      }
    }

    if (modified) {
      this.ctx.storage.put("reservations", JSON.stringify(Array.from(this.reservations.entries())));
      this.ctx.storage.put("activeMissions", JSON.stringify(Array.from(this.activeMissions.entries())));
    }
  }

  async handleReservation(body) {
    this.cleanExpired();
    const { cells, alt_m, time_start_utc, time_end_utc, mission_id, priority_tier, waypoints } = body;

    const startTime = new Date(time_start_utc).getTime();
    const endTime = new Date(time_end_utc).getTime();
    const altBin = Math.floor(alt_m / 30) * 30;

    for (const cell of cells) {
      for (let t = startTime; t <= endTime; t += 30000) {
        const slotBin = Math.floor(t / 30000) * 30000;
        const key = `${cell}:${altBin}:${slotBin}`;
        const existing = this.reservations.get(key);

        if (existing && existing.missionId !== mission_id) {
          return {
            conflict: true,
            conflicting_mission: existing.missionId,
            cell,
            altitude_bin: `${altBin}-${altBin + 30}m`,
            time_slot_utc: new Date(slotBin).toISOString()
          };
        }
      }
    }

    for (const cell of cells) {
      for (let t = startTime; t <= endTime; t += 30000) {
        const slotBin = Math.floor(t / 30000) * 30000;
        const key = `${cell}:${altBin}:${slotBin}`;
        this.reservations.set(key, {
          missionId: mission_id,
          priorityTier: priority_tier || "COMMERCIAL_LOGISTICS",
          expiresAt: endTime + 60000
        });
      }
    }

    this.activeMissions.set(mission_id, {
      mission_id,
      alt_m,
      waypoints,
      window_start: time_start_utc,
      window_end: time_end_utc,
      last_known_position: null,
      conformance_state: "CLEARED_PREFLIGHT"
    });

    await this.ctx.storage.put("reservations", JSON.stringify(Array.from(this.reservations.entries())));
    await this.ctx.storage.put("activeMissions", JSON.stringify(Array.from(this.activeMissions.entries())));

    return { conflict: false, allocated_slots: cells.length };
  }

  async handleTelemetry(body) {
    this.cleanExpired();
    const { mission_id, lat, lon, alt_agl_m, timestamp_utc } = body;
    const mission = this.activeMissions.get(mission_id);

    if (!mission) {
      return {
        status: "MISSION_NOT_FOUND",
        error: `No active 4D reservation found for mission ID '${mission_id}'. Launch without clearance violates UTM protocol.`
      };
    }

    const evaluation = evaluateTrajectoryConformance(lat, lon, alt_agl_m, mission.waypoints, mission.alt_m);
    mission.last_known_position = { lat, lon, alt_agl_m, timestamp_utc };
    mission.conformance_state = evaluation.conformance_status;

    await this.ctx.storage.put("activeMissions", JSON.stringify(Array.from(this.activeMissions.entries())));

    return {
      mission_id,
      conformance_evaluation: evaluation,
      telemetry_recorded_at: timestamp_utc
    };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/reserve") {
      const body = await request.json();
      const res = await this.handleReservation(body);
      return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/telemetry") {
      const body = await request.json();
      const res = await this.handleTelemetry(body);
      return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "DO Action Not Found" }), { status: 404 });
  }
}
