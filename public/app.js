import { appRegistry } from "./app-registry.js";

const nav = document.querySelector("#app-nav");
const content = document.querySelector("#app-content");
const title = document.querySelector("#app-title");
const status = document.querySelector("#app-status");
const time = document.querySelector("#clock-time");
const date = document.querySelector("#clock-date");

let activeApp;

const setHeader = (label, state = {}) => {
  title.textContent = label;
  status.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = "status-dot " + (state.tone || "neutral");
  const text = document.createElement("span");
  text.textContent = state.label || "Klar";
  status.append(dot, text);
};

const activate = (id, updateHistory = true) => {
  const next = appRegistry.find((entry) => entry.id === id) || appRegistry[0];
  activeApp?.module.unmount?.();
  activeApp = next;

  nav.querySelectorAll("button").forEach((button) => {
    const selected = button.dataset.app === next.id;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  });

  content.replaceChildren();
  content.dataset.app = next.id;
  next.module.mount({ root: content, setHeader });

  if (updateHistory) {
    const url = new URL(window.location.href);
    url.searchParams.set("app", next.id);
    history.replaceState({ app: next.id }, "", url);
  }
  content.focus({ preventScroll: true });
};

appRegistry.forEach((entry) => {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.app = entry.id;
  button.className = "app-nav-button accent-" + entry.accent;
  button.innerHTML = '<span class="nav-glyph">' + entry.shortLabel + '</span><span>' + entry.label + '</span>';
  button.addEventListener("click", () => activate(entry.id));
  nav.append(button);
});

const updateClock = () => {
  const now = new Date();
  time.textContent = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" }).format(now);
  date.textContent = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "2-digit", month: "short" }).format(now).replace(".", "");
};
updateClock();
window.setInterval(updateClock, 15_000);

window.addEventListener("popstate", (event) => activate(event.state?.app || new URLSearchParams(location.search).get("app"), false));
activate(new URLSearchParams(location.search).get("app") || "dashboard", false);