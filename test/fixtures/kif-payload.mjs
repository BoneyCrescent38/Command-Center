export const kifPayloadFixture = {
  items: [
    { nr: 12, done: false, area: "Admin", point: "Oppdater lagoppsettet", status: "Må sjekkes", statusCode: "needs_check", priority: "Høy", priorityCode: "high", version: "V3.0.1", comment: "Kontroller lagringen på mobil", rowNumber: 99, privateNote: "must-not-leak" },
    { nr: "3", done: false, area: "Bredde", point: "Forenkle øvelsesvelgeren", status: "Pågår", statusCode: "in_progress", priority: "Middels", priorityCode: "medium", version: "V3.0.1", comment: "Avventer siste touch-test" },
    { nr: "8", done: false, area: "Admin", point: "Gjenstående tekstjustering", status: "Gjenstår", statusCode: "remaining", priority: "Lav", priorityCode: "low", version: "V3.0.1", comment: "" },
    { nr: "2", done: true, area: "Security", point: "Sikre eksport", status: "Ferdig", statusCode: "done", priority: "Høy", priorityCode: "high", version: "V3.0.0", comment: "Verifisert" },
  ],
  stats: { open: 3, inProgress: 1, needsCheck: 1, remaining: 1, done: 1, total: 4 },
  source: { type: "google_sheets", status: "fresh", label: "KIF Masterliste – live", writable: true, lastSuccessAt: "2026-08-25T12:00:00.000Z", lastAttemptAt: "2026-08-25T12:00:00.000Z", refreshIntervalSeconds: 20, safeErrorCode: null, credentials: "must-not-leak" },
  snapshotVersion: "private-upstream-version",
};

export const staleKifPayloadFixture = {
  ...kifPayloadFixture,
  source: { ...kifPayloadFixture.source, status: "stale", label: "KIF Masterliste – siste gyldige snapshot", writable: false, safeErrorCode: "cached_snapshot" },
};
