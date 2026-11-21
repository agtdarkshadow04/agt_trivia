/**
 * A category's recent results as a small trend line (#72), drawn as inline SVG
 * on My scores. The scale is fixed, 0 % at the bottom and 100 % at the top, so
 * every line reads the same way; the points are evenly spaced, oldest first.
 */

export interface TrendPoint { x: number; y: number }

/** The points of a line in a `width` × `height` box with `padding` on every side; none for fewer than 2 results. */
export function trendPoints(percents: readonly number[], width = 120, height = 36, padding = 3): TrendPoint[] {
  if (percents.length < 2) return [];
  const step = (width - 2 * padding) / (percents.length - 1);
  return percents.map((percent, index) => {
    const clamped = Math.min(100, Math.max(0, percent));
    return { x: round(padding + index * step), y: round(padding + ((100 - clamped) / 100) * (height - 2 * padding)) };
  });
}

/** The SVG `points` attribute of a polyline. */
export function pointsAttribute(points: readonly TrendPoint[]) {
  return points.map(({ x, y }) => `${x},${y}`).join(' ');
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
