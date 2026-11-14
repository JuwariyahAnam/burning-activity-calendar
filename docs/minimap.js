// Place close-up: opens when a state or district is clicked. The place is drawn as
// its own shape, with red dots where fires were detected; redder and brighter =
// more intense fire (mean fire radiative power), bigger = more detections.
// AI disclosure: drafted with Claude (Anthropic); reviewed by the team.
import { fmt, showTip, hideTip } from "./viz.js";
import { fit, setupCanvas, ringsBox } from "./map.js";
import { loadHotspots, aggregate, intensity, drawDots, redGradient } from "./hotspots.js";

export function createMiniMap(panel, meta, districts, rows, { onToggle, onShow } = {}) {
  const $ = (sel) => panel.querySelector(sel);
  const canvas = $("canvas");
  const D = districts.districts;
  D.forEach((x) => (x.box ||= ringsBox(x.rings)));
  // place: { title, rings, ids (Set of district ids), districtId (or null) }
  let hot = null, place = null, mode = "latest", years = [0, 9999];
  let ctx, W, H, proj, dots = [];

  const ringPath = (rings) => {
    const p = new Path2D();
    for (const r of rings) r.forEach(([lon, lat], i) => {
      const [x, y] = proj.px(lat, lon);
      i ? p.lineTo(x, y) : p.moveTo(x, y);
    });
    return p;
  };

  function render() {
    if (!place) return;
    ({ ctx, W, H } = setupCanvas(canvas));
    const b = place.box;
    const padLat = (b[2] - b[0]) * 0.06, padLon = (b[3] - b[1]) * 0.06;
    proj = fit([b[0] - padLat, b[1] - padLon, b[2] + padLat, b[3] + padLon], W, H,
               { l: 12, r: 12, t: 12, b: 12 });
    ctx.clearRect(0, 0, W, H);
    // neighbouring districts as faint shapes, the district itself solid
    ctx.lineJoin = "round";
    D.forEach((x, i) => {
      if (place.ids.has(i) || x.box[2] < b[0] - 0.5 || x.box[0] > b[2] + 0.5 ||
          x.box[3] < b[1] - 0.5 || x.box[1] > b[3] + 0.5) return;
      const p = ringPath(x.rings);
      ctx.fillStyle = "#0b1830"; ctx.fill(p, "evenodd");
      ctx.strokeStyle = "rgba(160,190,240,0.25)"; ctx.lineWidth = 0.8; ctx.stroke(p);
    });
    const own = ringPath(place.rings);
    ctx.fillStyle = "#17305a"; ctx.fill(own, "evenodd");
    if (place.ids.size > 1) {                         // districts inside a state
      ctx.strokeStyle = "rgba(170,205,255,0.25)"; ctx.lineWidth = 0.7;
      for (const i of place.ids) ctx.stroke(ringPath(D[i].rings));
    }

    const [yA, yB] = mode === "latest" ? [years[1], years[1]] : years;
    const { dots: list, hasFrp, unit } = aggregate(meta, hot, rows, districts.cellDistrict,
                                                   { y0: yA, y1: yB, ids: place.ids });
    const t = intensity(list, hasFrp);
    const nMax = Math.max(1, ...list.map((s) => s.n));
    const [ax] = proj.px(0, 0), [bx] = proj.px(0, list[0]?.size || 0.02);
    const rMax = Math.max(2, Math.min((bx - ax) * 0.55, 8));
    dots = list.map((s) => {
      const [x, y] = proj.px(s.lat, s.lon);
      return { ...s, x, y, t: t(s), r: Math.max(1.4, rMax * (0.45 + 0.55 * Math.sqrt(s.n / nMax))) };
    });
    ctx.save(); ctx.clip(own, "evenodd");                 // dots stay inside the district shape
    drawDots(ctx, dots);
    ctx.restore();
    ctx.strokeStyle = "#eef3fb"; ctx.lineWidth = 1.8; ctx.stroke(own);

    const total = list.reduce((s, x) => s + x.n, 0);
    const span = yA === yB ? `${yA}` : `${yA}–${yB}`;
    const sensor = !hot ? "10 km grid cells"
      : yB < meta.hotspots.switchYear ? "MODIS 1 km detections"
      : yA >= meta.hotspots.switchYear ? "VIIRS 375 m detections"
      : `MODIS before ${meta.hotspots.switchYear}, VIIRS after`;
    $(".mini-sub").textContent = `${span}. ${sensor}.`;
    $(".mini-stats").innerHTML = list.length
      ? `<b>${fmt(total)}</b> ${unit === "detections" ? "fire detections" : "fire-days"} at <b>${fmt(list.length)}</b> places` +
        (hasFrp ? `. Most intense: <b>${fmt(Math.max(...list.map((s) => s.frp)), 0)} MW</b> on average.` : ".")
      : `No fires detected in ${span}.`;
    $(".mini-legend").innerHTML = hasFrp
      ? `<span>Lower</span><span class="bar" style="background:${redGradient}"></span><span>Higher fire intensity</span><span class="muted">Bigger dot: more detections</span>`
      : `<span>Fewer</span><span class="bar" style="background:${redGradient}"></span><span>More fire-days</span>`;
    $(".mini-legend").title = hasFrp ? "Intensity is the mean fire radiative power (FRP) of the detections at each place, in megawatts." : "";
  }

  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 1e9;
    for (const d of dots) {
      const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (dd < bd && dd <= Math.max(d.r, 6) ** 2) { bd = dd; best = d; }
    }
    if (!best) return hideTip();
    showTip(e, `<div class="t">${best.lat.toFixed(3)}°N, ${best.lon.toFixed(3)}°E</div>` +
      `<div class="r"><span>${hot ? "Detections" : "Fire-days"}</span><b>${fmt(best.n)}</b></div>` +
      (Number.isFinite(best.frp) ? `<div class="r"><span>Average intensity</span><b>${fmt(best.frp, 1)} MW</b></div>` : ""));
  });
  canvas.addEventListener("pointerleave", hideTip);
  $(".mini-close").addEventListener("click", () => api.close());
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") api.close(); });
  $(".mini-years").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.v;
    $(".mini-years").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    render();
  });
  new ResizeObserver(() => { if (!panel.hidden) render(); }).observe(panel);

  $(".mini-go")?.addEventListener("click", () => { if (place) onShow?.(place); });
  const api = {
    // a district by id
    open(id, yearSpan) {
      const d = D[id];
      return api.openPlace({ title: `${d.name}${d.state ? `, ${d.state}` : ""}`, rings: d.rings,
                             ids: new Set([id]), districtId: id }, yearSpan);
    },
    // a state by name: all its districts
    openState(name, yearSpan) {
      const st = districts.states.find((s) => s.name === name);
      const ids = new Set(D.filter((d) => d.state === name).map((d) => d.id));
      if (!st || !ids.size) return;
      return api.openPlace({ title: name, rings: st.rings, ids, districtId: null }, yearSpan);
    },
    async openPlace(p, yearSpan) {
      place = { ...p, box: ringsBox(p.rings) }; years = yearSpan;
      $(".mini-title").textContent = p.title;
      $(".mini-years").querySelector('[data-v="latest"]').textContent = `${yearSpan[1]}`;
      $(".mini-years").querySelector('[data-v="span"]').textContent = `${yearSpan[0]}–${yearSpan[1]}`;
      panel.hidden = false;
      onToggle?.(panel.offsetWidth);
      $(".mini-close").focus({ preventScroll: true });
      hot = await loadHotspots(meta);
      render();
    },
    setYears(yearSpan) { years = yearSpan; if (!panel.hidden && place) api.openPlace(place, yearSpan); },
    close() { if (panel.hidden) return; panel.hidden = true; place = null; hideTip(); onToggle?.(0); },
    get isOpen() { return !panel.hidden; },
  };
  return api;
}
