// Vendor entry: exposes the TanStack Charts primitives used by the static
// TokenArena dashboard on `window.TanStackCharts`. Bundled by
// scripts/build-vendor.mjs into docs/vendor/tanstack-charts.js so the page
// stays dependency-free at runtime and works offline.
import {
  defineChart,
  mountChart,
  areaY,
  barY,
  lineY,
  stack,
  ruleY,
  colorLegend
} from '@tanstack/charts';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scalePoint } from '@tanstack/charts/scales/point';
import { tooltip } from '@tanstack/charts/tooltip';

const TanStackCharts = {
  defineChart,
  mountChart,
  areaY,
  barY,
  lineY,
  stack,
  ruleY,
  colorLegend,
  scaleBand,
  scaleLinear,
  scalePoint,
  tooltip
};

if (typeof window !== 'undefined') {
  window.TanStackCharts = TanStackCharts;
}

export default TanStackCharts;
