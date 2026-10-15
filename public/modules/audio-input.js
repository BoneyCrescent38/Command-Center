// Windows default input only. Device names/IDs come from the local Core Audio service.
export function mountAudioInput(container, requestJson) {
  let disposed = false;
  let state;
  let pending = false;
  let errorMessage = "";
  container.innerHTML = '<div class="spotify-input-heading"><span>Mikrofon</span><span id="spotify-input-status" role="status" aria-live="polite">Kontrollerer mikrofoner…</span></div><div class="spotify-input-devices" role="group" aria-label="Windows standardmikrofon"></div>';
  const list = container.querySelector(".spotify-input-devices");
  const label = container.querySelector("#spotify-input-status");
  const render = () => {
    if (disposed) return;
    const devices = Array.isArray(state?.devices) ? state.devices : [];
    label.textContent = errorMessage || (pending ? "Bytter mikrofon…" : state?.activeName ? "Windows standard" : devices.length ? "Ingen standard valgt" : "Ingen tilgjengelige mikrofoner");
    label.dataset.tone = errorMessage ? "error" : "neutral";
    const existing = new Map([...list.children].map((button) => [button.dataset.deviceId, button]));
    for (const device of devices) {
      let button = existing.get(device.id);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.deviceId = device.id;
        button.className = "spotify-input-device";
      }
      existing.delete(device.id);
      button.textContent = device.name;
      button.title = device.name;
      button.setAttribute("aria-label", device.name + (device.active ? " · Windows standardmikrofon" : " · Velg som Windows standardmikrofon"));
      button.setAttribute("aria-pressed", String(Boolean(device.active)));
      button.disabled = pending || !device.available;
      const position = devices.indexOf(device);
      if (list.children[position] !== button) list.insertBefore(button, list.children[position] || null);
    }
    existing.forEach((button) => button.remove());
  };
  const refresh = async () => {
    try {
      const next = await requestJson("/api/audio-input");
      if (disposed) return;
      state = next;
      errorMessage = "";
      render();
    } catch {
      if (disposed) return;
      state = { devices: [] };
      errorMessage = "Mikrofontjenesten er midlertidig utilgjengelig";
      render();
    }
  };
  const select = async (event) => {
    const button = event.target.closest("button[data-device-id]");
    if (!button || !list.contains(button) || button.disabled || pending || disposed) return;
    pending = true;
    errorMessage = "";
    render();
    try {
      const next = await requestJson("/api/audio-input/default", { method: "POST", body: JSON.stringify({ deviceId: button.dataset.deviceId }) });
      if (!disposed) state = next;
    } catch (error) {
      await refresh();
      errorMessage = error?.code === "audio_input_target_unavailable" ? "Mikrofonen er koblet fra. Velg en tilgjengelig mikrofon." : "Mikrofonbyttet kunne ikke bekreftes. Prøv igjen.";
    } finally {
      pending = false;
      render();
    }
  };
  list.addEventListener("click", select);
  const source = new EventSource("/api/audio-input/stream");
  source.addEventListener("audio-input", (event) => {
    if (disposed) return;
    try { state = JSON.parse(event.data); errorMessage = ""; render(); } catch {}
  });
  source.onerror = () => {
    state = { devices: [] };
    errorMessage = "Kobler til mikrofontjenesten…";
    render();
  };
  refresh();
  return () => { disposed = true; source.close(); list.removeEventListener("click", select); };
}
