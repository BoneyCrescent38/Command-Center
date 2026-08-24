const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || "Skolehandlingen kunne ikke fullføres");
    error.code = body?.code || "school_request_failed";
    error.status = response.status;
    throw error;
  }
  return body;
};

const osloToday = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
};

const addDays = (value, amount) => {
  const date = new Date(String(value) + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};

const daysFrom = (from, to) => Math.round((Date.parse(to + "T12:00:00Z") - Date.parse(from + "T12:00:00Z")) / 86_400_000);

const formatDate = (value, options = {}) => {
  if (!value || Number.isNaN(Date.parse(value))) return "Ikke satt";
  return new Intl.DateTimeFormat("nb-NO", {
    day: "numeric",
    month: "short",
    ...(options.weekday ? { weekday: "short" } : {}),
  }).format(new Date(value + (value.length === 10 ? "T12:00:00Z" : "")));
};

const deadlineStatus = (value) => ({ open: "Åpen", in_progress: "Pågår", done: "Ferdig" })[value] || value || "Åpen";
const deadlinePriority = (value) => ({ high: "Høy", medium: "Normal", low: "Lav" })[value] || value || "Normal";
const deadlineType = (value) => ({ assignment: "Oppgave", exam: "Eksamen", lab: "Lab", project: "Prosjekt", reading: "Lesing", other: "Annet" })[value] || value || "Annet";
const priorityRank = (value) => ({ high: 0, medium: 1, low: 2 })[value] ?? 3;

export function sortSchoolDeadlines(deadlines = [], today = osloToday()) {
  return deadlines
    .filter((item) => item?.status !== "done" && item?.dueDate)
    .slice()
    .sort((left, right) => {
      const leftDays = daysFrom(today, left.dueDate);
      const rightDays = daysFrom(today, right.dueDate);
      const leftOverdue = leftDays < 0 ? 0 : 1;
      const rightOverdue = rightDays < 0 ? 0 : 1;
      return leftOverdue - rightOverdue
        || left.dueDate.localeCompare(right.dueDate)
        || priorityRank(left.priority) - priorityRank(right.priority)
        || Number(right.status === "in_progress") - Number(left.status === "in_progress")
        || String(left.title).localeCompare(String(right.title), "nb-NO");
    });
}

export function nextSchoolAction(snapshot = {}, today = osloToday()) {
  const deadline = sortSchoolDeadlines(snapshot.deadlines, today)[0] || null;
  if (!deadline) return { deadline: null, reason: "Ingen åpne frister" };
  const difference = daysFrom(today, deadline.dueDate);
  if (difference < 0) return { deadline, reason: "Forfalt med " + Math.abs(difference) + " d" };
  if (difference === 0) return { deadline, reason: "Forfaller i dag" };
  if (difference <= 7) return { deadline, reason: "Frist om " + difference + " d" };
  if (deadline.priority === "high") return { deadline, reason: "Høy prioritet" };
  if (deadline.status === "in_progress") return { deadline, reason: "Allerede påbegynt" };
  return { deadline, reason: "Nærmeste åpne frist" };
}

const sourceState = (source = {}) => {
  if (source.status === "fresh" && source.writable === true) return { tone: "ok", label: "Live · kan redigeres" };
  if (source.status === "stale") return { tone: "warning", label: "Cache · kun lesing" };
  if (source.status === "preview") return { tone: "warning", label: "Preview · kun lesing" };
  return { tone: "error", label: "Skole utilgjengelig" };
};

const courseMap = (snapshot) => new Map((snapshot?.courses || []).map((course) => [course.id, course]));

const nextActivity = (week, now = new Date()) => {
  if (!week?.days?.length) return null;
  const today = osloToday(now);
  const currentTime = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  return week.days
    .flatMap((day) => (day.timetable || []).map((entry) => ({ ...entry, date: day.date })))
    .filter((entry) => entry.date > today || (entry.date === today && entry.endTime >= currentTime))
    .sort((left, right) => (left.date + left.startTime).localeCompare(right.date + right.startTime))[0] || null;
};

const optionMarkup = (items, selected, label) => items.map((item) =>
  '<option value="' + escapeHtml(item.id) + '"' + (item.id === selected ? " selected" : "") + '>' + escapeHtml(label(item)) + '</option>'
).join("");

let rootNode = null;
let setHeaderState = null;
let schoolSnapshot = null;
let schoolWeek = null;
let selectedWeekDate = osloToday();
let refreshTimer = null;
let messageTimer = null;
let pendingMutation = false;
let lastError = "";

const setBusy = (busy, label = "") => {
  pendingMutation = busy;
  if (!rootNode) return;
  const view = rootNode.querySelector(".school-view");
  if (view) view.setAttribute("aria-busy", String(busy));
  rootNode.querySelectorAll("[data-mutation]").forEach((button) => {
    button.disabled = busy || schoolSnapshot?.source?.writable !== true;
  });
  const toast = rootNode.querySelector(".school-toast");
  if (toast && label) {
    toast.textContent = label;
    toast.dataset.tone = "neutral";
    toast.hidden = false;
  }
};

const flash = (message, tone = "ok") => {
  if (!rootNode) return;
  clearTimeout(messageTimer);
  const toast = rootNode.querySelector(".school-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;
  messageTimer = setTimeout(() => { if (toast.isConnected) toast.hidden = true; }, 4_000);
};

const renderDay = (day) => {
  const activities = (day.timetable || []).slice(0, 2);
  const deadlines = day.deadlines || [];
  return '<div class="school-day' + (day.today ? " is-today" : "") + '">' +
    '<div class="school-day-date"><strong>' + escapeHtml(formatDate(day.date, { weekday: true }).split(" ")[0]) + '</strong><span>' + escapeHtml(formatDate(day.date)) + '</span></div>' +
    '<div class="school-day-events">' + (activities.length
      ? activities.map((entry) => '<div><b>' + escapeHtml(entry.startTime + "–" + entry.endTime) + '</b><span>' + escapeHtml(entry.course?.name || entry.kind) + '</span></div>').join("")
      : '<span class="school-muted">Ingen faste økter</span>') + '</div>' +
    (deadlines.length ? '<span class="school-day-deadline">' + deadlines.length + ' frist</span>' : "") +
  '</div>';
};

const renderDeadline = (deadline, courses, writable) => {
  const course = courses.get(deadline.courseId) || deadline.course || {};
  const progressValues = [0, 25, 50, 75, 100];
  return '<article class="school-deadline" data-deadline-id="' + escapeHtml(deadline.id) + '" tabindex="0">' +
    '<div class="school-deadline-main"><span class="course-mark tone-' + escapeHtml(course.tone || "default") + '"></span><div><strong>' + escapeHtml(deadline.title) + '</strong><small>' + escapeHtml(course.name || "Ukjent fag") + ' · ' + escapeHtml(deadlineType(deadline.type)) + '</small></div></div>' +
    '<div class="school-deadline-meta"><b>' + escapeHtml(formatDate(deadline.dueDate)) + '</b><span>' + escapeHtml(deadlineStatus(deadline.status)) + ' · ' + escapeHtml(deadlinePriority(deadline.priority)) + '</span></div>' +
    '<div class="school-quick-progress" aria-label="Fremdrift for ' + escapeHtml(deadline.title) + '">' + progressValues.map((value) =>
      '<button type="button" data-action="deadline-progress" data-id="' + escapeHtml(deadline.id) + '" data-value="' + value + '" data-mutation' + (!writable ? " disabled" : "") + (deadline.progress === value ? ' class="is-current"' : "") + '>' + value + '</button>'
    ).join("") + '</div>' +
  '</article>';
};

const renderExamPeriod = (period, writable) => '<article class="school-exam-period" data-exam-id="' + escapeHtml(period.id) + '" tabindex="0">' +
  '<div><strong>' + escapeHtml(period.name) + '</strong><small>' + escapeHtml(period.startWeek ? "Uke " + period.startWeek + "–" + period.endWeek : "Uker ikke satt") + ' · ' + escapeHtml(period.year || "") + '</small></div>' +
  '<span class="school-state ' + (period.active ? "ok" : "neutral") + '">' + escapeHtml(period.active ? "Aktiv" : period.status || "Inaktiv") + '</span>' +
  '<button type="button" data-action="exam-edit" data-id="' + escapeHtml(period.id) + '" data-mutation' + (!writable ? " disabled" : "") + '>Endre</button>' +
'</article>';

const render = () => {
  if (!rootNode || !schoolSnapshot || !schoolWeek) return;
  const source = schoolSnapshot.source || {};
  const writable = source.writable === true;
  const courses = courseMap(schoolSnapshot);
  const action = nextSchoolAction(schoolSnapshot);
  const activity = nextActivity(schoolWeek);
  const deadlines = sortSchoolDeadlines(schoolSnapshot.deadlines).slice(0, 4);
  const sourceBadge = sourceState(source);
  setHeaderState("Skole", sourceBadge);

  rootNode.innerHTML = '<section class="school-view" aria-label="Skolekontroll">' +
    '<section class="school-now-strip">' +
      '<div class="school-now-item"><p class="eyebrow">NESTE AKTIVITET</p>' + (activity
        ? '<strong>' + escapeHtml(activity.course?.name || activity.kind) + '</strong><span>' + escapeHtml(formatDate(activity.date, { weekday: true }) + " · " + activity.startTime + "–" + activity.endTime) + '</span>'
        : '<strong>Ingen kommende økt i valgt uke</strong><span>Ukevisningen inneholder ingen senere undervisningsdata.</span>') + '</div>' +
      '<div class="school-now-item school-next-action"><p class="eyebrow">NESTE Å GJØRE</p>' + (action.deadline
        ? '<strong>' + escapeHtml(action.deadline.title) + '</strong><span>' + escapeHtml(action.reason + " · " + (courses.get(action.deadline.courseId)?.name || "Ukjent fag")) + '</span>'
        : '<strong>Ingen åpne frister</strong><span>Det finnes ingen registrerte arbeidsfrister akkurat nå.</span>') + '</div>' +
      '<div class="school-source-block"><span class="school-source ' + escapeHtml(sourceBadge.tone) + '">' + escapeHtml(sourceBadge.label) + '</span><small>' + escapeHtml(source.label || "Skole") + '</small></div>' +
    '</section>' +
    (!writable ? '<div class="school-readonly"><strong>Kun lesing:</strong> ' + escapeHtml(source.status === "unavailable" ? "Skolekilden er utilgjengelig." : "Kilden er " + source.status + "; endringer er slått av til live Sheet er tilbake.") + '</div>' : "") +
    '<div class="school-columns">' +
      '<section class="school-panel school-week-panel"><div class="school-panel-heading"><div><p class="eyebrow">AKTUELL UKE</p><h2>Uke ' + escapeHtml(schoolWeek.week) + '</h2></div><div class="school-week-nav"><button type="button" data-action="week-prev" aria-label="Forrige uke">←</button><button type="button" data-action="week-current">Denne uken</button><button type="button" data-action="week-next" aria-label="Neste uke">→</button></div></div><div class="school-week-days">' + schoolWeek.days.map(renderDay).join("") + '</div></section>' +
      '<section class="school-panel school-deadline-panel"><div class="school-panel-heading"><div><p class="eyebrow">PRIORITERT ARBEID</p><h2>Kommende frister</h2></div><div class="school-heading-actions"><span class="mini-badge warm">' + sortSchoolDeadlines(schoolSnapshot.deadlines).length + ' åpne</span><button type="button" data-action="deadline-new" data-mutation' + (!writable ? " disabled" : "") + '>+ Ny</button></div></div><div class="school-deadlines">' + (deadlines.length ? deadlines.map((deadline) => renderDeadline(deadline, courses, writable)).join("") : '<div class="school-empty">Ingen åpne frister.</div>') + '</div></section>' +
      '<section class="school-panel school-exam-panel"><div class="school-panel-heading"><div><p class="eyebrow">EKSAMEN</p><h2>Perioder</h2></div><button type="button" data-action="exam-new" data-mutation' + (!writable ? " disabled" : "") + '>+ Ny</button></div><div class="school-exam-list">' + ((schoolSnapshot.examPeriods || []).length ? schoolSnapshot.examPeriods.slice(0, 4).map((period) => renderExamPeriod(period, writable)).join("") : '<div class="school-empty">Ingen eksamensperioder.</div>') + '</div><button class="school-settings-button" type="button" data-action="settings-edit" data-mutation' + (!writable ? " disabled" : "") + '>Semester ' + escapeHtml(schoolSnapshot.settings?.year || "") + ' · innstillinger</button></section>' +
    '</div>' +
    '<div class="school-toast" role="status" hidden></div>' +
  '</section>';
};

const renderFailure = (error) => {
  if (!rootNode) return;
  const unauthorized = error?.status === 401;
  setHeaderState("Skole", { tone: "error", label: unauthorized ? "Innlogging kreves" : "Utilgjengelig" });
  rootNode.innerHTML = '<section class="center-state"><article class="offline-card"><p class="eyebrow">SKOLE</p><h2>' + (unauthorized ? "Logg inn via Dashboard" : "Skoledata er utilgjengelig") + '</h2><p>' + escapeHtml(unauthorized ? "Command Center bruker den samme sikre Dashboard-sessionen." : "Ingen data er fremstilt som live. Prøv igjen når Project Dashboard svarer.") + '</p><button type="button" data-action="school-retry">' + (unauthorized ? "Åpne Dashboard" : "Prøv igjen") + '</button></article></section>';
};

const loadSchool = async () => {
  if (!rootNode) return;
  rootNode.innerHTML = '<div class="loading-state"><span></span><p>Laster skoledata</p></div>';
  try {
    [schoolSnapshot, schoolWeek] = await Promise.all([
      requestJson("/api/school"),
      requestJson("/api/school/week?date=" + encodeURIComponent(selectedWeekDate)),
    ]);
    lastError = "";
    render();
  } catch (error) {
    lastError = error.code || "school_unavailable";
    renderFailure(error);
  }
};

const loadWeek = async (date) => {
  selectedWeekDate = date;
  try {
    schoolWeek = await requestJson("/api/school/week?date=" + encodeURIComponent(date));
    render();
  } catch (error) {
    flash(error.message, "error");
  }
};

const openDeadlineDialog = (deadline = null) => {
  const courses = schoolSnapshot.courses || [];
  const item = deadline || {
    id: "DL-CC-" + Date.now().toString(36).toUpperCase(),
    courseId: courses[0]?.id || "",
    title: "",
    type: "assignment",
    startDate: "",
    dueDate: osloToday(),
    priority: "medium",
    status: "open",
    estimatedHours: "",
    progress: 0,
    note: "",
  };
  rootNode.querySelector("dialog")?.remove();
  rootNode.insertAdjacentHTML("beforeend", '<dialog class="school-dialog"><form method="dialog" class="school-form" data-form="deadline" data-existing="' + (deadline ? "true" : "false") + '"><div class="school-dialog-heading"><div><p class="eyebrow">' + (deadline ? "REDIGER FRIST" : "NY FRIST") + '</p><h2>' + escapeHtml(deadline?.title || "Opprett skolefrist") + '</h2></div><button type="button" data-action="dialog-close" aria-label="Lukk">×</button></div><input type="hidden" name="id" value="' + escapeHtml(item.id) + '"><div class="school-form-grid"><label><span>Fag</span><select name="courseId" required>' + optionMarkup(courses, item.courseId, (course) => course.name + " · " + course.code) + '</select></label><label class="span-2"><span>Tittel</span><input name="title" maxlength="300" required value="' + escapeHtml(item.title) + '"></label><label><span>Type</span><select name="type">' + ["assignment", "exam", "lab", "project", "reading", "other"].map((value) => '<option value="' + value + '"' + (item.type === value ? " selected" : "") + '>' + deadlineType(value) + '</option>').join("") + '</select></label><label><span>Startdato</span><input type="date" name="startDate" value="' + escapeHtml(item.startDate || "") + '"></label><label><span>Frist</span><input type="date" name="dueDate" required value="' + escapeHtml(item.dueDate) + '"></label><label><span>Prioritet</span><select name="priority">' + ["high", "medium", "low"].map((value) => '<option value="' + value + '"' + (item.priority === value ? " selected" : "") + '>' + deadlinePriority(value) + '</option>').join("") + '</select></label><label><span>Status</span><select name="status">' + ["open", "in_progress", "done"].map((value) => '<option value="' + value + '"' + (item.status === value ? " selected" : "") + '>' + deadlineStatus(value) + '</option>').join("") + '</select></label><label><span>Estimert timer</span><input type="number" min="0" max="1000" step="0.5" name="estimatedHours" value="' + escapeHtml(item.estimatedHours ?? "") + '"></label><label><span>Fremdrift</span><input type="number" min="0" max="100" step="1" name="progress" value="' + escapeHtml(item.progress) + '"></label><label class="span-3"><span>Notat</span><textarea name="note" maxlength="4000">' + escapeHtml(item.note || "") + '</textarea></label></div><p class="school-dialog-error" role="alert"></p><div class="school-dialog-actions">' + (deadline ? '<button class="danger-action" type="button" data-action="deadline-delete" data-id="' + escapeHtml(item.id) + '" data-mutation>Slett</button>' : '<span></span>') + '<button type="button" data-action="dialog-close">Avbryt</button><button class="primary-action" type="submit" data-mutation>Lagre frist</button></div></form></dialog>');
  rootNode.querySelector("dialog").showModal();
};

const openExamDialog = (period = null) => {
  const item = period || { id: "EXAM-CC-" + Date.now().toString(36).toUpperCase(), name: "", year: schoolSnapshot.settings?.year || new Date().getFullYear(), startWeek: "", endWeek: "", active: true, status: "Foreløpig", note: "" };
  rootNode.querySelector("dialog")?.remove();
  rootNode.insertAdjacentHTML("beforeend", '<dialog class="school-dialog school-dialog-compact"><form method="dialog" class="school-form" data-form="exam" data-existing="' + (period ? "true" : "false") + '"><div class="school-dialog-heading"><div><p class="eyebrow">EKSAMENSPERIODE</p><h2>' + escapeHtml(period?.name || "Ny periode") + '</h2></div><button type="button" data-action="dialog-close">×</button></div><input type="hidden" name="id" value="' + escapeHtml(item.id) + '"><div class="school-form-grid"><label class="span-2"><span>Navn</span><input name="name" maxlength="160" required value="' + escapeHtml(item.name) + '"></label><label><span>År</span><input type="number" min="2020" max="2100" name="year" required value="' + escapeHtml(item.year) + '"></label><label><span>Fra uke</span><input type="number" min="1" max="53" name="startWeek" value="' + escapeHtml(item.startWeek ?? "") + '"></label><label><span>Til uke</span><input type="number" min="1" max="53" name="endWeek" value="' + escapeHtml(item.endWeek ?? "") + '"></label><label><span>Status</span><input name="status" maxlength="80" required value="' + escapeHtml(item.status) + '"></label><label class="school-check"><input type="checkbox" name="active"' + (item.active ? " checked" : "") + '><span>Aktiv periode</span></label><label class="span-3"><span>Notat</span><textarea name="note" maxlength="1000">' + escapeHtml(item.note || "") + '</textarea></label></div><p class="school-dialog-error" role="alert"></p><div class="school-dialog-actions">' + (period ? '<button class="danger-action" type="button" data-action="exam-delete" data-id="' + escapeHtml(item.id) + '" data-mutation>Slett</button>' : '<span></span>') + '<button type="button" data-action="dialog-close">Avbryt</button><button class="primary-action" type="submit" data-mutation>Lagre periode</button></div></form></dialog>');
  rootNode.querySelector("dialog").showModal();
};

const openSettingsDialog = () => {
  const settings = schoolSnapshot.settings || {};
  rootNode.querySelector("dialog")?.remove();
  rootNode.insertAdjacentHTML("beforeend", '<dialog class="school-dialog school-dialog-compact"><form method="dialog" class="school-form" data-form="settings"><div class="school-dialog-heading"><div><p class="eyebrow">SEMESTER</p><h2>Semestergrenser</h2></div><button type="button" data-action="dialog-close">×</button></div><div class="school-form-grid"><label><span>År</span><input type="number" min="2020" max="2100" name="year" required value="' + escapeHtml(settings.year || "") + '"></label><label><span>Semesterstart</span><input type="date" name="startDate" required value="' + escapeHtml(settings.startDate || "") + '"></label><label><span>Semesterslutt</span><input type="date" name="endDate" required value="' + escapeHtml(settings.endDate || "") + '"></label></div><p class="school-dialog-error" role="alert"></p><div class="school-dialog-actions"><span></span><button type="button" data-action="dialog-close">Avbryt</button><button class="primary-action" type="submit" data-mutation>Lagre semester</button></div></form></dialog>');
  rootNode.querySelector("dialog").showModal();
};

const refreshConfirmedWeek = async () => {
  schoolWeek = await requestJson("/api/school/week?date=" + encodeURIComponent(selectedWeekDate));
};

const runMutation = async (url, options, successMessage) => {
  if (pendingMutation || schoolSnapshot?.source?.writable !== true) return;
  setBusy(true, "Lagrer til Google Sheet …");
  const dialogError = rootNode.querySelector(".school-dialog-error");
  if (dialogError) dialogError.textContent = "";
  try {
    const result = await requestJson(url, options);
    schoolSnapshot = result.school;
    await refreshConfirmedWeek();
    render();
    flash(successMessage, "ok");
  } catch (error) {
    if (dialogError?.isConnected) dialogError.textContent = error.message + " (" + error.code + ")";
    else flash(error.message + " (" + error.code + ")", "error");
  } finally {
    setBusy(false);
  }
};

const onSubmit = (event) => {
  const form = event.target.closest(".school-form");
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const existing = form.dataset.existing === "true";
  if (form.dataset.form === "deadline") {
    const id = String(data.get("id"));
    const body = {
      id,
      courseId: String(data.get("courseId")),
      title: String(data.get("title")),
      type: String(data.get("type")),
      startDate: String(data.get("startDate")) || null,
      dueDate: String(data.get("dueDate")),
      priority: String(data.get("priority")),
      status: String(data.get("status")),
      estimatedHours: String(data.get("estimatedHours")) === "" ? null : Number(data.get("estimatedHours")),
      progress: Number(data.get("progress")),
      note: String(data.get("note")) || null,
    };
    runMutation(existing ? "/api/school/deadlines/" + encodeURIComponent(id) : "/api/school/deadlines", { method: existing ? "PATCH" : "POST", body }, "Fristen er lagret");
  } else if (form.dataset.form === "exam") {
    const id = String(data.get("id"));
    const body = {
      id,
      name: String(data.get("name")),
      year: Number(data.get("year")),
      startWeek: String(data.get("startWeek")) === "" ? null : Number(data.get("startWeek")),
      endWeek: String(data.get("endWeek")) === "" ? null : Number(data.get("endWeek")),
      active: data.get("active") === "on",
      status: String(data.get("status")),
      note: String(data.get("note")) || null,
    };
    runMutation(existing ? "/api/school/exam-periods/" + encodeURIComponent(id) : "/api/school/exam-periods", { method: existing ? "PATCH" : "POST", body }, "Eksamensperioden er lagret");
  } else if (form.dataset.form === "settings") {
    runMutation("/api/school/settings", { method: "PATCH", body: { year: Number(data.get("year")), startDate: String(data.get("startDate")), endDate: String(data.get("endDate")) } }, "Semestergrensene er lagret");
  }
};

const onClick = async (event) => {
  const actionNode = event.target.closest("[data-action]");
  const action = actionNode?.dataset.action;
  if (action === "week-prev") return loadWeek(addDays(schoolWeek.startDate, -7));
  if (action === "week-next") return loadWeek(addDays(schoolWeek.startDate, 7));
  if (action === "week-current") return loadWeek(osloToday());
  if (action === "deadline-new") return openDeadlineDialog();
  if (action === "exam-new") return openExamDialog();
  if (action === "settings-edit") return openSettingsDialog();
  if (action === "dialog-close") return actionNode.closest("dialog")?.close();
  if (action === "school-retry") {
    if (lastError && /auth|unauthorized/.test(lastError)) return document.querySelector('[data-app="dashboard"]')?.click();
    return loadSchool();
  }
  if (action === "deadline-progress") {
    const deadline = schoolSnapshot.deadlines.find((item) => item.id === actionNode.dataset.id);
    const progress = Number(actionNode.dataset.value);
    if (deadline) return runMutation("/api/school/deadlines/" + encodeURIComponent(deadline.id), { method: "PATCH", body: { progress, status: progress === 100 ? "done" : progress > 0 ? "in_progress" : "open" } }, deadline.title + " er oppdatert");
  }
  if (action === "deadline-delete") {
    if (window.confirm("Slett denne fristen permanent fra Google Sheet?")) return runMutation("/api/school/deadlines/" + encodeURIComponent(actionNode.dataset.id), { method: "DELETE" }, "Fristen er slettet");
    return;
  }
  if (action === "exam-edit") return openExamDialog(schoolSnapshot.examPeriods.find((item) => item.id === actionNode.dataset.id));
  if (action === "exam-delete") {
    if (window.confirm("Slett denne eksamensperioden permanent?")) return runMutation("/api/school/exam-periods/" + encodeURIComponent(actionNode.dataset.id), { method: "DELETE" }, "Eksamensperioden er slettet");
    return;
  }

  const deadlineCard = event.target.closest("[data-deadline-id]");
  if (deadlineCard && schoolSnapshot.source.writable) return openDeadlineDialog(schoolSnapshot.deadlines.find((item) => item.id === deadlineCard.dataset.deadlineId));
};

const onKeydown = (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  const deadlineCard = event.target.closest("[data-deadline-id]");
  if (deadlineCard && schoolSnapshot?.source?.writable) {
    event.preventDefault();
    openDeadlineDialog(schoolSnapshot.deadlines.find((item) => item.id === deadlineCard.dataset.deadlineId));
  }
};

export const SchoolModule = {
  id: "school",
  mount({ root, setHeader }) {
    rootNode = root;
    setHeaderState = setHeader;
    selectedWeekDate = osloToday();
    rootNode.addEventListener("click", onClick);
    rootNode.addEventListener("submit", onSubmit);
    rootNode.addEventListener("keydown", onKeydown);
    setHeaderState("Skole", { tone: "neutral", label: "Laster" });
    loadSchool();
    refreshTimer = setInterval(() => {
      if (!pendingMutation && !rootNode.querySelector("dialog[open]")) loadSchool();
    }, 20_000);
  },
  unmount() {
    clearInterval(refreshTimer);
    clearTimeout(messageTimer);
    rootNode?.removeEventListener("click", onClick);
    rootNode?.removeEventListener("submit", onSubmit);
    rootNode?.removeEventListener("keydown", onKeydown);
    rootNode = null;
    setHeaderState = null;
    schoolSnapshot = null;
    schoolWeek = null;
  },
};
