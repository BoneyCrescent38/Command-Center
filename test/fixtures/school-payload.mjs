const course = {
  id: "course-analog",
  code: "TSE2270-1 26H",
  name: "Analog elektronikk",
  semester: "Høst 2026",
  workMode: "Campus",
  inWeeklyPlan: true,
  fixedSessions: 1,
  status: "Aktiv",
  note: "Kun aktiv lab torsdag",
  tone: "analog",
  color: "#7c9cff",
};

const deadlines = [
  { id: "DL-OVERDUE", courseId: course.id, title: "Forfalt rapport", type: "assignment", typeLabel: "Oppgave", startDate: "2026-08-20", dueDate: "2026-08-23", priority: "medium", status: "open", estimatedHours: 3, progress: 0, note: "Start her", createdAt: "2026-08-10T10:00:00Z", updatedAt: "2026-08-20T10:00:00Z" },
  { id: "DL-HIGH", courseId: course.id, title: "Labforberedelse", type: "lab", typeLabel: "Lab", startDate: "2026-08-24", dueDate: "2026-08-27", priority: "high", status: "in_progress", estimatedHours: 2, progress: 50, note: "", createdAt: "2026-08-20T10:00:00Z", updatedAt: "2026-08-24T10:00:00Z" },
  { id: "DL-DONE", courseId: course.id, title: "Ferdig øving", type: "assignment", typeLabel: "Oppgave", startDate: null, dueDate: "2026-08-25", priority: "low", status: "done", estimatedHours: null, progress: 100, note: null, createdAt: "2026-08-10T10:00:00Z", updatedAt: "2026-08-24T10:00:00Z" },
];

export const schoolSnapshotFixture = {
  schemaVersion: 1,
  updatedAt: "2026-08-24T12:00:00Z",
  courses: [course],
  timetable: [{ id: "FX-006", weekday: 4, startTime: "12:15", endTime: "16:00", courseId: course.id, kind: "Lab", fixed: true, location: "Campus", active: true, note: "" }],
  deadlines,
  examPeriods: [{ id: "EXAM-1", name: "Kontperiode høst", year: 2026, startWeek: 40, endWeek: 41, active: true, status: "Foreløpig", note: "Kont" }],
  studyPlans: [{
    courseId: course.id,
    year: 2026,
    week: 35,
    goal: "Forstå ukens grunnlag",
    checkpoints: [{ id: "ANALOG-2026-W35-01", courseId: course.id, title: "Les kapittel", duration: "30 min", description: "Les og noter.", reference: "Kapittel 1", done: false, optional: false, kind: "checkpoint", date: null, order: 1 }],
  }],
  settings: { year: 2026, startDate: "2026-08-17", endDate: "2026-12-31", timezone: "Europe/Oslo" },
  source: { status: "fresh", type: "google_sheets", label: "Skole – Google Sheet live", writable: true, updatedAt: "2026-08-24T12:00:00Z", lastAttemptAt: "2026-08-24T12:00:00Z", refreshIntervalSeconds: 20, safeErrorCode: null, missingConfiguration: [], credentials: "must-not-leak" },
  credentials: "must-not-leak",
};

export const schoolWeekFixture = {
  requestedDate: "2026-08-24",
  startDate: "2026-08-24",
  endDate: "2026-08-30",
  year: 2026,
  week: 35,
  today: "2026-08-24",
  updatedAt: "2026-08-24T12:00:00Z",
  source: schoolSnapshotFixture.source,
  examPeriods: [],
  days: Array.from({ length: 7 }, (_, index) => ({
    date: "2026-08-" + String(24 + index).padStart(2, "0"),
    weekday: index + 1,
    today: index === 0,
    timetable: index === 3 ? [{ ...schoolSnapshotFixture.timetable[0], course }] : [],
    deadlines: deadlines.filter((deadline) => deadline.dueDate === "2026-08-" + String(24 + index).padStart(2, "0")).map((deadline) => ({ ...deadline, course })),
  })),
};
