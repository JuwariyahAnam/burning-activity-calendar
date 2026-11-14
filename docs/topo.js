// Decode a TopoJSON MultiPolygon/Polygon collection into polygons of [lon, lat] rings.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
export function topoRings(topo, name) {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
  const arcs = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
  });
  const ring = (ids) => {
    const out = [];
    ids.forEach((i, k) => {
      const a = i < 0 ? [...arcs[~i]].reverse() : arcs[i];
      out.push(...(k ? a.slice(1) : a));
    });
    return out;
  };
  const polys = [];
  const walk = (g) => {
    if (g.type === "GeometryCollection") g.geometries.forEach(walk);
    else if (g.type === "Polygon") polys.push(g.arcs.map(ring));
    else if (g.type === "MultiPolygon") g.arcs.forEach((p) => polys.push(p.map(ring)));
  };
  walk(topo.objects[name]);
  return polys;
}
