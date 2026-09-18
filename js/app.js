import { loadAirports, lookupAirport } from "./airports.js";
import { buildManualFlight, lookupFlight, displayTime, normalizeFlightNumber } from "./api.js";
import { deleteFlight, getAllFlights, saveFlight } from "./db.js";
import { escapeHtml } from "./util.js";
import { activateGlobe, deactivateGlobe, updateGlobe } from "./globe.js";
import { initAuth, onAuthChange, sendMagicLink, signOut } from "./auth.js";

const views = {
  add: document.getElementById("view-add"),
  list: document.getElementById("view-list"),
  globe: document.getElementById("view-globe"),
};

const tabs = document.querySelectorAll(".tab");
const form = document.getElementById("lookup-form");
const flightNumberInput = document.getElementById("flight-number");
const flightDateInput = document.getElementById("flight-date");
const dateTrigger = document.getElementById("date-trigger");
const calendar = document.getElementById("calendar");
const calTitle = document.getElementById("cal-title");
const calDays = document.getElementById("cal-days");
const calPrev = document.getElementById("cal-prev");
const calNext = document.getElementById("cal-next");
const lookupStatus = document.getElementById("lookup-status");
const preview = document.getElementById("flight-preview");
const addTitle = document.getElementById("add-title");
const addSubtitle = document.getElementById("add-subtitle");
const flightList = document.getElementById("flight-list");
const listEmpty = document.getElementById("list-empty");
const listCount = document.getElementById("list-count");

const loginView = document.getElementById("view-login");
const loginForm = document.getElementById("login-form");
const loginEmailInput = document.getElementById("login-email");
const loginStatus = document.getElementById("login-status");
const accountBar = document.getElementById("account-bar");
const signOutButton = document.getElementById("sign-out");
const topbar = document.querySelector(".topbar");
const mainEl = document.querySelector("main");

let pendingFlight = null;

function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

function parseISODate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(iso) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parseISODate(iso));
}

function daysBeforeToday(isoDate) {
  const selected = parseISODate(isoDate);
  const today = parseISODate(todayISO());
  return Math.round((today - selected) / 86400000);
}

let calendarMonth = parseISODate(todayISO());
calendarMonth.setDate(1);

function setFlightDate(iso, { close = true } = {}) {
  flightDateInput.value = iso;
  dateTrigger.textContent = formatDisplayDate(iso);
  calendarMonth = parseISODate(iso);
  calendarMonth.setDate(1);
  renderCalendar();
  if (close) closeCalendar();
}

function renderCalendar() {
  const selected = flightDateInput.value;
  const today = todayISO();
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  calTitle.textContent = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(calendarMonth);

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

  calDays.replaceChildren();
  for (let i = 0; i < 42; i += 1) {
    const dayNumber = i - firstDay + 1;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cal-day";

    let date;
    if (dayNumber < 1) {
      date = new Date(year, month - 1, prevMonthDays + dayNumber);
      button.classList.add("is-muted");
    } else if (dayNumber > daysInMonth) {
      date = new Date(year, month + 1, dayNumber - daysInMonth);
      button.classList.add("is-muted");
    } else {
      date = new Date(year, month, dayNumber);
    }

    const iso = formatISODate(date);
    button.textContent = String(date.getDate());
    button.dataset.date = iso;
    if (iso === today) button.classList.add("is-today");
    if (iso === selected) button.classList.add("is-selected");
    button.addEventListener("click", () => setFlightDate(iso));
    calDays.appendChild(button);
  }
}

function openCalendar() {
  calendar.hidden = false;
  dateTrigger.setAttribute("aria-expanded", "true");
  renderCalendar();
}

function closeCalendar() {
  calendar.hidden = true;
  dateTrigger.setAttribute("aria-expanded", "false");
}

function setPrompt(title, subtitle) {
  addTitle.textContent = title;
  addSubtitle.textContent = subtitle;
}

function syncSearchButton() {
  document.getElementById("search-flight").hidden = !flightNumberInput.value.trim();
}

function formatDisplayTime(hhmm) {
  if (!hhmm) return "Add time";
  const [hour, minute] = hhmm.split(":").map(Number);
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = ((hour + 11) % 12) + 1;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function parseTimeParts(hhmm) {
  if (!hhmm) return { hour12: 12, minute: 0, period: "am" };
  const [hour, minute] = hhmm.split(":").map(Number);
  return {
    hour12: ((hour + 11) % 12) + 1,
    minute,
    period: hour >= 12 ? "pm" : "am",
  };
}

function toHHMM(hour12, minute, period) {
  let hour = hour12 % 12;
  if (period === "pm") hour += 12;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function closeAllPickers() {
  closeCalendar();
  document.querySelectorAll(".time-panel").forEach((panel) => {
    panel.hidden = true;
  });
  document.querySelectorAll("[data-time-id]").forEach((trigger) => {
    trigger.setAttribute("aria-expanded", "false");
  });
}

function bindTimePicker(trigger, hiddenInput, panel) {
  const hoursWrap = panel.querySelector(".time-hours");
  const minsWrap = panel.querySelector(".time-mins");
  const periodButtons = panel.querySelectorAll(".period");
  const clearButton = panel.querySelector("[data-clear]");
  const state = parseTimeParts(hiddenInput.value);

  function writeValue() {
    hiddenInput.value = toHHMM(state.hour12, state.minute, state.period);
    trigger.textContent = formatDisplayTime(hiddenInput.value);
    trigger.classList.remove("is-empty");
    renderCells();
  }

  function renderCells() {
    hoursWrap.replaceChildren();
    for (let hour = 1; hour <= 12; hour += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "time-cell";
      button.textContent = String(hour);
      if (hiddenInput.value && hour === state.hour12) button.classList.add("is-selected");
      button.addEventListener("click", () => {
        state.hour12 = hour;
        writeValue();
      });
      hoursWrap.appendChild(button);
    }

    minsWrap.replaceChildren();
    for (let minute = 0; minute < 60; minute += 5) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "time-cell";
      button.textContent = String(minute).padStart(2, "0");
      if (hiddenInput.value && minute === state.minute) button.classList.add("is-selected");
      button.addEventListener("click", () => {
        state.minute = minute;
        writeValue();
      });
      minsWrap.appendChild(button);
    }

    periodButtons.forEach((button) => {
      button.classList.toggle("is-selected", Boolean(hiddenInput.value) && button.dataset.period === state.period);
    });
  }

  periodButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.period = button.dataset.period;
      writeValue();
    });
  });

  clearButton.addEventListener("click", () => {
    hiddenInput.value = "";
    trigger.textContent = "Add time";
    trigger.classList.add("is-empty");
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  });

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    const willOpen = panel.hidden;
    closeAllPickers();
    if (willOpen) {
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      renderCells();
    }
  });

  trigger.classList.toggle("is-empty", !hiddenInput.value);
  trigger.textContent = formatDisplayTime(hiddenInput.value);
}

function timeFieldMarkup(id, label) {
  return `
    <label class="field">
      ${label}
      <button type="button" class="picker-trigger is-empty" data-time-id="${id}" aria-expanded="false">Add time</button>
      <input id="${id}" type="hidden" value="" />
      <div class="picker-panel time-panel" data-panel="${id}" hidden>
        <div class="cal-header">
          <button type="button" class="period" data-period="am">AM</button>
          <p class="cal-title">Time</p>
          <button type="button" class="period" data-period="pm">PM</button>
        </div>
        <span class="time-label">Hour</span>
        <div class="time-hours"></div>
        <span class="time-label">Minute</span>
        <div class="time-mins"></div>
        <button type="button" class="btn-text" data-clear>Clear</button>
      </div>
    </label>
  `;
}

function setView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.hidden = key !== name;
  });
  tabs.forEach((tab) => {
    const active = tab.dataset.view === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  if (name === "add" && preview.hidden) {
    setPrompt("Add a flight", "Enter the flight number and date");
  }
  if (name === "globe") {
    activateGlobe();
  } else {
    deactivateGlobe();
  }
}

function setStatus(message, type = "") {
  lookupStatus.textContent = message;
  lookupStatus.className = `status ${type}`.trim();
}

function formatAirport(name, iata, icao) {
  const code = iata || icao;
  if (name && code) return `${name} (${code})`;
  return name || code || "—";
}

function statusLabel(status) {
  if (!status) return "Unknown";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function detailsMarkup(flight) {
  const rows = [
    ["Airline", flight.airlineName],
    ["Flight number", flight.flightNumber],
    ["Date", flight.flightDate],
    ["Origin", formatAirport(flight.departureAirport, flight.departureIata, flight.departureIcao)],
    ["Destination", formatAirport(flight.arrivalAirport, flight.arrivalIata, flight.arrivalIcao)],
    ["Scheduled departure", displayTime(flight.scheduledDeparture)],
    ["Actual departure", displayTime(flight.actualDeparture)],
    ["Scheduled arrival", displayTime(flight.scheduledArrival)],
    ["Actual arrival", displayTime(flight.actualArrival)],
    ["Aircraft", flight.aircraftType || "—"],
    ["Registration", flight.aircraftRegistration || "—"],
    ["Status", statusLabel(flight.status)],
  ];

  return rows
    .map(
      ([label, value]) => `
        <div class="detail-row">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>`
    )
    .join("");
}

function renderPreview(flight) {
  pendingFlight = flight;
  preview.hidden = false;
  setPrompt("Save this flight?", "Review the details, then add it to your log");
  preview.innerHTML = `
    <dl class="details">${detailsMarkup(flight)}</dl>
    <button type="button" class="btn primary" id="save-flight">Add flight</button>
  `;
  preview.querySelector("#save-flight").addEventListener("click", onSave);
}

async function onSave() {
  if (!pendingFlight) return;
  const button = document.getElementById("save-flight");
  if (button) button.disabled = true;
  try {
    await saveFlight(pendingFlight);
  } catch (error) {
    if (button) button.disabled = false;
    setStatus(error.message || "Couldn't save that flight. Try again.", "error");
    return;
  }
  setStatus("Saved to My Flights.", "ok");
  pendingFlight = null;
  preview.hidden = true;
  preview.innerHTML = "";
  await renderList();
  setPrompt("Add a flight", "Enter the flight number and date");
  setView("list");
}

function flightCard(flight) {
  const origin = flight.departureIata || flight.departureIcao || "—";
  const destination = flight.arrivalIata || flight.arrivalIcao || "—";
  const route = `${origin} → ${destination}`;
  const article = document.createElement("article");
  article.className = "flight-card";
  article.innerHTML = `
    <button type="button" class="flight-summary" aria-expanded="false">
      <span class="flight-date">${escapeHtml(flight.flightDate)}</span>
      <span class="flight-title">${escapeHtml(flight.airlineName)} ${escapeHtml(flight.flightNumber)}</span>
      <span class="flight-route">${escapeHtml(route)}</span>
      <span class="badge">${escapeHtml(statusLabel(flight.status))}</span>
    </button>
    <div class="flight-extra" hidden>
      <dl class="details">${detailsMarkup(flight)}</dl>
      <button type="button" class="btn danger" data-delete="${flight.id}">Delete</button>
    </div>
  `;

  const summary = article.querySelector(".flight-summary");
  const extra = article.querySelector(".flight-extra");
  summary.addEventListener("click", () => {
    const open = extra.hidden;
    extra.hidden = !open;
    summary.setAttribute("aria-expanded", String(open));
    article.classList.toggle("is-open", open);
  });

  article.querySelector("[data-delete]").addEventListener("click", async () => {
    const ok = window.confirm("Delete this flight from your passport?");
    if (!ok) return;
    try {
      await deleteFlight(flight.id);
    } catch (error) {
      window.alert(error.message || "Couldn't delete that flight. Try again.");
      return;
    }
    await renderList();
  });

  return article;
}

async function renderList() {
  let flights;
  try {
    flights = await getAllFlights();
  } catch (error) {
    console.error(error);
    flightList.replaceChildren();
    listEmpty.textContent = "Couldn't load your flights. Check your connection and try again.";
    listEmpty.hidden = false;
    listCount.hidden = true;
    return;
  }
  listEmpty.textContent = "No flights added yet";
  flightList.replaceChildren();
  const empty = flights.length === 0;
  listEmpty.hidden = !empty;
  listCount.hidden = empty;
  listCount.textContent = flights.length === 1 ? "1 flight" : `${flights.length} flights`;
  flights.forEach((flight) => flightList.appendChild(flightCard(flight)));
  updateGlobe(flights);
}

function notFoundMessage(flightDate) {
  if (daysBeforeToday(flightDate) > 2) {
    return "Flight data only available for the last 2 days. Please manually enter flight information.";
  }
  return "Flight not found. Please manually enter flight information.";
}

function renderManualSave(flightNumber, flightDate, airlineName) {
  pendingFlight = null;
  preview.hidden = false;
  setPrompt("Enter flight details", "Airports are required. Times are optional.");
  preview.innerHTML = `
    <form id="manual-form" class="stack">
      <label class="field">
        Origin airport
        <input id="origin-code" name="origin" inputmode="text" autocapitalize="characters" placeholder="SFO" maxlength="4" required />
      </label>
      <label class="field">
        Destination airport
        <input id="dest-code" name="destination" inputmode="text" autocapitalize="characters" placeholder="AUS" maxlength="4" required />
      </label>
      <p id="airport-hint" class="hint"></p>
      <div class="time-grid">
        ${timeFieldMarkup("sched-dep", "Scheduled departure")}
        ${timeFieldMarkup("actual-dep", "Actual departure")}
        ${timeFieldMarkup("sched-arr", "Scheduled arrival")}
        ${timeFieldMarkup("actual-arr", "Actual arrival")}
      </div>
      <button class="btn primary" type="submit">Add flight</button>
    </form>
  `;

  const manualForm = preview.querySelector("#manual-form");
  const originInput = preview.querySelector("#origin-code");
  const destInput = preview.querySelector("#dest-code");
  const airportHint = preview.querySelector("#airport-hint");

  ["sched-dep", "actual-dep", "sched-arr", "actual-arr"].forEach((id) => {
    bindTimePicker(
      preview.querySelector(`[data-time-id="${id}"]`),
      preview.querySelector(`#${id}`),
      preview.querySelector(`[data-panel="${id}"]`)
    );
  });

  function describe(code) {
    const info = lookupAirport(code, code);
    if (!info) return "";
    const tag = info.iata || info.icao;
    return `${info.name} (${tag})`;
  }

  function updateHint() {
    const origin = describe(originInput.value.trim());
    const dest = describe(destInput.value.trim());
    airportHint.textContent = [origin, dest].filter(Boolean).join(" → ");
  }

  originInput.addEventListener("input", updateHint);
  destInput.addEventListener("input", updateHint);

  manualForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const flight = buildManualFlight({
        flightNumber,
        flightDate,
        origin: originInput.value.trim(),
        destination: destInput.value.trim(),
        status: "landed",
        airlineName,
        scheduledDeparture: preview.querySelector("#sched-dep").value,
        actualDeparture: preview.querySelector("#actual-dep").value,
        scheduledArrival: preview.querySelector("#sched-arr").value,
        actualArrival: preview.querySelector("#actual-arr").value,
      });
      pendingFlight = flight;
      await onSave();
    } catch (error) {
      setStatus(error.message || "Could not save that flight.", "error");
    }
  });

  setStatus(notFoundMessage(flightDate), "error");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  preview.hidden = true;
  preview.innerHTML = "";
  pendingFlight = null;

  const flightNumber = normalizeFlightNumber(flightNumberInput.value);
  const flightDate = flightDateInput.value;

  if (!flightNumber || !flightDate) {
    setStatus("Enter a flight number and date.", "error");
    return;
  }

  if (daysBeforeToday(flightDate) > 2) {
    renderManualSave(flightNumber, flightDate, "");
    return;
  }

  setPrompt("Looking up…", "Checking AviationStack for this flight");
  setStatus("Looking up flight…");
  form.querySelector("#search-flight").disabled = true;

  try {
    const result = await lookupFlight(flightNumber, flightDate);
    if (result.notFound) {
      renderManualSave(flightNumber, flightDate, result.airlineName);
      return;
    }
    setStatus("");
    renderPreview(result.flight);
  } catch (error) {
    setPrompt("Add a flight", "Enter the flight number and date");
    setStatus(error.message || "Lookup failed.", "error");
  } finally {
    form.querySelector("#search-flight").disabled = false;
  }
});

flightNumberInput.addEventListener("input", syncSearchButton);

dateTrigger.addEventListener("click", (event) => {
  event.preventDefault();
  const willOpen = calendar.hidden;
  closeAllPickers();
  if (willOpen) openCalendar();
});

calPrev.addEventListener("click", () => {
  calendarMonth.setMonth(calendarMonth.getMonth() - 1);
  renderCalendar();
});

calNext.addEventListener("click", () => {
  calendarMonth.setMonth(calendarMonth.getMonth() + 1);
  renderCalendar();
});

document.addEventListener("click", (event) => {
  const openPanel = document.querySelector(".picker-panel:not([hidden])");
  if (!openPanel) return;
  if (openPanel.contains(event.target)) return;
  if (event.target.closest(".picker-trigger")) return;
  closeAllPickers();
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

let appInitialized = false;

function showApp() {
  loginView.hidden = true;
  accountBar.hidden = false;
  topbar.hidden = false;
  mainEl.hidden = false;

  if (!appInitialized) {
    appInitialized = true;
    setFlightDate(todayISO(), { close: true });
    closeCalendar();
    syncSearchButton();
    setView("add");
    loadAirports();
    renderList();
  }
}

function showLogin() {
  appInitialized = false;
  // Don't leave the previous user's flights in the DOM or on the globe.
  flightList.replaceChildren();
  updateGlobe([]);
  loginView.hidden = false;
  accountBar.hidden = true;
  topbar.hidden = true;
  mainEl.hidden = true;
}

function setLoginStatus(message, type = "") {
  loginStatus.textContent = message;
  loginStatus.className = `status ${type}`.trim();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = loginEmailInput.value.trim();
  if (!email) return;

  const button = loginForm.querySelector("button");
  button.disabled = true;
  setLoginStatus("Sending…");

  try {
    await sendMagicLink(email);
    setLoginStatus("Check your email for a sign-in link.", "ok");
  } catch (error) {
    setLoginStatus(error.message || "Couldn't send the link. Try again.", "error");
  } finally {
    button.disabled = false;
  }
});

signOutButton.addEventListener("click", () => signOut());

onAuthChange((session) => {
  if (session) {
    showApp();
  } else {
    showLogin();
  }
});
initAuth();
