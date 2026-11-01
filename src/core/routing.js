import { gridDistance, gridDisk, cellToLatLng } from "h3-js";

export function findDetourPath(startH3, goalH3, blockedCellsSet) {
  const openSet = new Set([startH3]);
  const cameFrom = new Map();

  const gScore = new Map();
  gScore.set(startH3, 0);

  const fScore = new Map();
  fScore.set(startH3, gridDistance(startH3, goalH3));

  let iterations = 0;
  const MAX_ITERATIONS = 400;

  while (openSet.size > 0 && iterations < MAX_ITERATIONS) {
    iterations++;

    let current = null;
    let lowestF = Infinity;
    for (const cell of openSet) {
      const score = fScore.get(cell) ?? Infinity;
      if (score < lowestF) {
        lowestF = score;
        current = cell;
      }
    }

    if (current === goalH3) {
      const path = [current];
      while (cameFrom.has(current)) {
        current = cameFrom.get(current);
        path.unshift(current);
      }
      return {
        detour_found: true,
        h3_path: path,
        coordinates: path.map(c => {
          const [lat, lon] = cellToLatLng(c);
          return [parseFloat(lat.toFixed(5)), parseFloat(lon.toFixed(5))];
        })
      };
    }

    openSet.delete(current);
    const neighbors = gridDisk(current, 1).filter(c => c !== current);

    for (const neighbor of neighbors) {
      if (blockedCellsSet.has(neighbor)) continue;

      const tentativeG = (gScore.get(current) ?? Infinity) + 1;
      if (tentativeG < (gScore.get(neighbor) ?? Infinity)) {
        cameFrom.set(neighbor, current);
        gScore.set(neighbor, tentativeG);
        fScore.set(neighbor, tentativeG + gridDistance(neighbor, goalH3));
        openSet.add(neighbor);
      }
    }
  }

  return { detour_found: false, reason: "No viable airspace detour within iteration limit" };
}
