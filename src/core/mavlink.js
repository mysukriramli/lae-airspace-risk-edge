export function exportToMavlinkPlan(waypoints, cruiseAltAglM = 60, cruiseSpeedMs = 15.0) {
  const missionItems = waypoints.map((wp, index) => ({
    autoContinue: true,
    command: 16, // MAV_CMD_NAV_WAYPOINT
    frame: 3,    // MAV_FRAME_GLOBAL_RELATIVE_ALT
    params: [0, 0, 0, null, wp[0], wp[1], cruiseAltAglM],
    type: "SimpleItem",
    doJumpId: index + 1
  }));

  return {
    fileType: "Plan",
    version: 1,
    groundStation: "LAE-Airspace-Risk-Edge",
    mission: {
      cruiseSpeed: cruiseSpeedMs,
      hoverSpeed: 5,
      items: missionItems,
      plannedHomePosition: [waypoints[0][0], waypoints[0][1], cruiseAltAglM],
      vehicleType: 2 // Multirotor
    }
  };
}
