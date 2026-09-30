"use strict";
// Local, deterministic component specimens. No network, account or analytics calls.
const icons = {
  "usage": "<path d=\"M3 20h18M6 16v-4m6 4V5m6 11V8\"/>",
  "models": "<path d=\"m3 8 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 18l9 5 9-5\" transform=\"translate(0 -1)\"/>",
  "leaderboard": "<path d=\"M3 20V11h6v9m0 0V4h6v16m0 0v-6h6v6M2 20h20\"/>",
  "limits": "<path d=\"M7 20a9 9 0 1 1 10 0M12 12l5-5\"/><circle cx=\"12\" cy=\"12\" r=\"1\" fill=\"currentColor\" stroke=\"none\"/>",
  "traces": "<path d=\"M5 17h5l5-6h5M4 11h5l5-5h4\"/><circle cx=\"3\" cy=\"17\" r=\"2\"/><circle cx=\"20\" cy=\"6\" r=\"2\"/>",
  "sessions": "<path d=\"M8 3h12v15H8zM4 7v15h12M11 7h6m-6 4h6\"/>",
  "widgets": "<rect x=\"2.5\" y=\"4\" width=\"19\" height=\"16\" rx=\"2\"/><path d=\"M13 4v16M6 15v-3m3 3V9m7-1h3m-3 4h3\"/>",
  "notch": "<path d=\"M3 19V6a2 2 0 0 1 2-2h3v2a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V4h3a2 2 0 0 1 2 2v13M8 20h8\"/>",
  "connect": "<path d=\"m9 8 3-3a5 5 0 0 1 7 7l-3 3M15 16l-3 3a5 5 0 0 1-7-7l3-3m0 7 8-8\"/>",
  "privacy": "<path d=\"m12 2 8 4v6c0 5-4 8-8 10-4-2-8-5-8-10V6l8-4Z\"/><circle cx=\"12\" cy=\"11\" r=\"1.5\" fill=\"currentColor\" stroke=\"none\"/><path d=\"M12 12.5V15\"/>",
  "settings": "<path d=\"M3 5h3m4 0h11M3 12h10m4 0h4M3 19h5m4 0h9\"/><circle cx=\"8\" cy=\"5\" r=\"2\"/><circle cx=\"15\" cy=\"12\" r=\"2\"/><circle cx=\"10\" cy=\"19\" r=\"2\"/>",
  "engine": "<rect x=\"5\" y=\"5\" width=\"14\" height=\"14\" rx=\"2\"/><path d=\"M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3M8 12h8\"/><path d=\"M9 10a3 3 0 0 1 6 0m-6 4a3 3 0 0 0 6 0\"/>"
};
const iconGrid = document.querySelector("#icon-grid");
for (const [name, paths] of Object.entries(icons)) {
  const link = document.createElement("a");
  link.href = "assets/icons/" + name + ".svg";
  link.download = name + ".svg";
  link.className = "icon-cell";
  link.setAttribute("aria-label", "Download " + name + " SVG");
  link.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg><span>' + name[0].toUpperCase() + name.slice(1) + '</span>';
  iconGrid.append(link);
}
const themeButton = document.querySelector("#theme");
themeButton.addEventListener("click", () => {
  const dark = document.body.dataset.theme !== "dark";
  document.body.dataset.theme = dark ? "dark" : "light";
  themeButton.setAttribute("aria-pressed", String(dark));
  themeButton.textContent = dark ? "Light mode" : "Dark mode";
});
const periods = {
  day: { total: 24.8, count: 24, label: "today", unit: "Hour", caption: "Illustrative hourly tokens, millions" },
  week: { total: 148.6, count: 7, label: "this week", unit: "Day", caption: "Illustrative daily tokens, millions" },
  month: { total: 612.4, count: 30, label: "this month", unit: "Day", caption: "Illustrative daily tokens, millions" }
};
function renderPeriod(key) {
  const period = periods[key];
  const weights = Array.from({ length: period.count }, (_, i) => 8 + ((i * 13 + i * i * 3) % 31));
  const sum = weights.reduce((a, b) => a + b, 0);
  let remaining = Math.round(period.total * 100);
  const samples = weights.map((w, i) => {
    const total = i === weights.length - 1 ? remaining : Math.round(period.total * 100 * w / sum);
    remaining -= total;
    const input = Math.round(total * (.6 + (i % 4) * .04));
    return { total, input, output: total - input };
  });
  const chart = document.querySelector("#sample-chart");
  chart.replaceChildren();
  const max = Math.max(...samples.map(s => s.total));
  const rows = document.querySelector("#chart-rows");
  rows.replaceChildren();
  samples.forEach((s, i) => {
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.style.height = (s.total / max * 100) + "%";
    bar.setAttribute("aria-hidden", "true");
    const input = document.createElement("i");
    input.style.height = (s.input / s.total * 100) + "%";
    const output = document.createElement("b");
    output.style.height = (s.output / s.total * 100) + "%";
    bar.append(input, output);
    chart.append(bar);
    const row = document.createElement("tr");
    [period.unit + " " + (i + 1), (s.input / 100).toFixed(2), (s.output / 100).toFixed(2)].forEach((value, col) => {
      const cell = document.createElement(col === 0 ? "th" : "td");
      if (col === 0) cell.scope = "row";
      cell.textContent = value;
      row.append(cell);
    });
    rows.append(row);
  });
  document.querySelector("#sample-total").textContent = period.total + "M";
  document.querySelector("#sample-period").textContent = "tokens " + period.label;
  document.querySelector("#chart-caption").textContent = period.caption;
  chart.setAttribute("aria-label", "Sample token use: " + period.total + " million tokens " + period.label + ". Exact sample values are available in the adjacent table.");
  document.querySelectorAll("[data-period]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.period === key)));
}
document.querySelectorAll("[data-period]").forEach(button => button.addEventListener("click", () => renderPeriod(button.dataset.period)));
renderPeriod("day");
document.querySelector(".small-link").addEventListener("click", () => {
  document.querySelector("#chart-data").open = true;
});
const action = document.querySelector("#sample-action");
const actionStatus = document.querySelector("#action-status");
action.addEventListener("click", () => {
  action.textContent = "Preview complete";
  action.disabled = true;
  actionStatus.textContent = "Success state previewed. No data was sent.";
});
document.querySelector("#sample-reset").addEventListener("click", () => {
  action.textContent = "Preview action";
  action.disabled = false;
  actionStatus.textContent = "Ready to preview. No account is connected.";
});
const notch = document.querySelector("#notch-demo");
const reduce = document.querySelector("#reduce-motion");
const motionStatus = document.querySelector("#motion-status");
const systemReduced = window.matchMedia("(prefers-reduced-motion: reduce)");
for (let i = 0; i < 24; i++) {
  const bar = document.createElement("span");
  bar.style.height = (18 + (i * 17 + i * i * 3) % 77) + "%";
  document.querySelector(".notch-bars").append(bar);
}
function updateReduced() {
  const reduced = reduce.checked || systemReduced.matches;
  document.body.dataset.reduced = String(reduced);
  if (reduced) {
    notch.classList.remove("play");
    motionStatus.textContent = "Reduced motion: the open state appears immediately.";
  } else {
    motionStatus.textContent = "Ready. Opening settles in 420 ms.";
  }
}
reduce.addEventListener("change", updateReduced);
systemReduced.addEventListener("change", updateReduced);
document.querySelector("#replay").addEventListener("click", () => {
  updateReduced();
  if (document.body.dataset.reduced === "true") return;
  notch.classList.remove("play");
  void notch.offsetWidth;
  notch.classList.add("play");
  motionStatus.textContent = "Opening from the screen edge.";
});
notch.addEventListener("animationend", event => {
  if (event.target === notch) motionStatus.textContent = "Open. Motion has settled.";
});
updateReduced();
