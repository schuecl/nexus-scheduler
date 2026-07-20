import { escapeHtml } from "./escapeHtml.js";

export interface ChartRow {
  label: string;
  value: number;
}

const CHART_WIDTH = 260;
const EMPTY_CHART_HEIGHT = 96;
const SLICE_OPACITIES = [0.96, 0.78, 0.62, 0.48, 0.36, 0.26];

function normalizedRows(rows: ChartRow[]): ChartRow[] {
  return rows.map(({ label, value }) => ({
    label,
    value: Number.isFinite(value) && value > 0 ? value : 0,
  }));
}

function displayLabel(label: string, maxLength = 18): string {
  const compact = label.trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function emptyChart(ariaLabel: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHART_WIDTH} ${EMPTY_CHART_HEIGHT}" role="img" aria-label="${escapeHtml(ariaLabel)}">
  <rect width="${CHART_WIDTH}" height="${EMPTY_CHART_HEIGHT}" rx="6" fill="#f5f6f7" />
  <text x="${CHART_WIDTH / 2}" y="${EMPTY_CHART_HEIGHT / 2}" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="10" fill="#666">No data in this period.</text>
</svg>`;
}

function opacity(index: number): number {
  return SLICE_OPACITIES[index % SLICE_OPACITIES.length] ?? 1;
}

function formatValue(value: number): string {
  return value.toLocaleString("en-US");
}

export function barChart(
  inputRows: ChartRow[],
  primaryColor: string,
  ariaLabel = "Bar chart",
): string {
  const rows = normalizedRows(inputRows);
  const maxValue = Math.max(0, ...rows.map(({ value }) => value));
  if (maxValue === 0) return emptyChart(ariaLabel);

  const rowHeight = 22;
  const height = 24 + rows.length * rowHeight;
  const barX = 78;
  const plotWidth = 132;
  const fill = escapeHtml(primaryColor);
  const rowMarkup = rows
    .map(({ label, value }, index) => {
      const y = 24 + index * rowHeight;
      const width = value === 0 ? 0 : Math.max(1, (value / maxValue) * plotWidth);
      return `<g>
    <title>${escapeHtml(label)}: ${formatValue(value)}</title>
    <text x="70" y="${y}" text-anchor="end" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="8.5" fill="#333">${escapeHtml(displayLabel(label))}</text>
    <rect x="${barX}" y="${y - 6}" width="${plotWidth}" height="12" rx="2" fill="#e8eaed" />
    ${value > 0 ? `<rect x="${barX}" y="${y - 6}" width="${width.toFixed(2)}" height="12" rx="2" fill="${fill}" fill-opacity="${opacity(index)}" />` : ""}
    <text x="218" y="${y}" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="8.5" font-weight="700" fill="#222">${formatValue(value)}</text>
  </g>`;
    })
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHART_WIDTH} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
  ${rowMarkup}
</svg>`;
}

function pointOnCircle(cx: number, cy: number, radius: number, angle: number): [number, number] {
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

function slicePath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const [startX, startY] = pointOnCircle(cx, cy, radius, startAngle);
  const [endX, endY] = pointOnCircle(cx, cy, radius, endAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${cx} ${cy}`,
    `L ${startX.toFixed(3)} ${startY.toFixed(3)}`,
    `A ${radius} ${radius} 0 ${largeArc} 1 ${endX.toFixed(3)} ${endY.toFixed(3)}`,
    "Z",
  ].join(" ");
}

export function pieChart(
  inputRows: ChartRow[],
  primaryColor: string,
  ariaLabel = "Pie chart",
): string {
  const rows = normalizedRows(inputRows);
  const total = rows.reduce((sum, { value }) => sum + value, 0);
  if (total === 0) return emptyChart(ariaLabel);

  const height = Math.max(126, 32 + rows.length * 18);
  const cx = 58;
  const cy = height / 2;
  const radius = 43;
  const fill = escapeHtml(primaryColor);
  const positiveRows = rows.filter(({ value }) => value > 0);
  let startAngle = -Math.PI / 2;

  const singleRow = positiveRows[0];
  let slices: string;
  if (positiveRows.length === 1 && singleRow) {
    slices = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}" fill-opacity="${opacity(rows.indexOf(singleRow))}">
    <title>${escapeHtml(singleRow.label)}: ${formatValue(singleRow.value)} (100%)</title>
  </circle>`;
  } else {
    slices = positiveRows
      .map((row) => {
        const endAngle = startAngle + (row.value / total) * Math.PI * 2;
        const path = slicePath(cx, cy, radius, startAngle, endAngle);
        startAngle = endAngle;
        const index = rows.indexOf(row);
        const percent = Math.round((row.value / total) * 100);
        return `<path d="${path}" fill="${fill}" fill-opacity="${opacity(index)}">
    <title>${escapeHtml(row.label)}: ${formatValue(row.value)} (${percent}%)</title>
  </path>`;
      })
      .join("\n  ");
  }

  const legend = rows
    .map(({ label, value }, index) => {
      const y = 26 + index * 18;
      const percent = Math.round((value / total) * 100);
      return `<g>
    <rect x="118" y="${y - 7}" width="9" height="9" rx="1" fill="${fill}" fill-opacity="${opacity(index)}" />
    <text x="133" y="${y}" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="8.5" fill="#333">${escapeHtml(displayLabel(label, 15))}</text>
    <text x="252" y="${y}" text-anchor="end" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="8.5" font-weight="700" fill="#222">${formatValue(value)} (${percent}%)</text>
  </g>`;
    })
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHART_WIDTH} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
  ${slices}
  ${legend}
</svg>`;
}
