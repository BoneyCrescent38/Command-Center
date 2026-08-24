const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);

export function createPlaceholderModule(config) {
  return {
    id: config.id,
    mount({ root, setHeader }) {
      setHeader(config.title, { label: config.signal, tone: "neutral" });
      root.innerHTML =
        '<section class="placeholder-view">' +
          '<article class="placeholder-card">' +
            '<p class="eyebrow">' + escapeHtml(config.eyebrow) + '</p>' +
            '<h2>' + escapeHtml(config.title) + '</h2>' +
            '<p>' + escapeHtml(config.description) + '</p>' +
            '<div class="placeholder-orbit" aria-hidden="true"><span></span><span></span><span></span></div>' +
            '<div class="placeholder-signal"><span class="status-dot neutral"></span>' + escapeHtml(config.signal) + '</div>' +
          '</article>' +
        '</section>';
    },
    unmount() {},
  };
}