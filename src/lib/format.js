// Pure formatting helpers shared by the views in src/main.js.

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function rankForPercent(percent) {
  if (percent === 100) return "Atlas Archivist";
  if (percent >= 75) return "Galactic Cartographer";
  if (percent >= 50) return "Seasoned Traveller";
  return "Pathfinder";
}
