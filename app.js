const STORAGE_KEY = "cafe-daniels-drink-entries-v1";
const SETTINGS_KEY = "cafe-daniels-settings-v1";
const DEFAULT_BEVERAGES = ["Bier", "Spezi", "Cola", "Wein"];

const dateInput = document.querySelector("#selected-date");
const friendlyDate = document.querySelector("#friendly-date");
const beverageInput = document.querySelector("#beverage");
const quantityInput = document.querySelector("#quantity");
const priceInput = document.querySelector("#unit-price");
const form = document.querySelector("#entry-form");
const list = document.querySelector("#entry-list");
const toast = document.querySelector("#toast");

let entries = loadEntries();
let settings = loadSettings();
let toastTimer;

dateInput.value = localDateString(new Date());

function loadEntries() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored.map((entry) => ({ ...entry, beverage: entry.beverage || "Bier" })) : [];
  } catch { return []; }
}

function loadSettings() {
  const fallback = { beverages: [...DEFAULT_BEVERAGES], deposits: 0, beerStockAdded: 0 };
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (!stored) return fallback;
    const custom = Array.isArray(stored.beverages) ? stored.beverages.filter((item) => typeof item === "string" && item.trim()) : [];
    return {
      beverages: [...new Set([...DEFAULT_BEVERAGES, ...custom])],
      deposits: Number(stored.deposits) || 0,
      beerStockAdded: Number(stored.beerStockAdded) || 0
    };
  } catch { return fallback; }
}

function persistEntries() { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); }
function persistSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

function localDateString(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function parsePrice(value) {
  return Number.parseFloat(String(value).trim().replace(/\s/g, "").replace(",", "."));
}

function currency(value) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(value);
}

function formattedDate(value) {
  return new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function shortDate(value) {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" }).format(new Date(`${value}T12:00:00`));
}

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function totalSpent() { return entries.reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0); }
function accountBalance() { return settings.deposits - totalSpent(); }
function beerConsumed() { return entries.filter((entry) => entry.beverage === "Bier").reduce((sum, entry) => sum + entry.quantity, 0); }
function beerStock() { return settings.beerStockAdded - beerConsumed(); }

function setActiveTab(tabName) {
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    const active = panel.dataset.tabPanel === tabName;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function groupEntriesByDay() {
  const grouped = new Map();
  for (const entry of entries) {
    const day = grouped.get(entry.date) || { date: entry.date, quantity: 0, cost: 0, entries: 0, beverages: new Map() };
    day.quantity += entry.quantity;
    day.cost += entry.quantity * entry.unitPrice;
    day.entries += 1;
    day.beverages.set(entry.beverage, (day.beverages.get(entry.beverage) || 0) + entry.quantity);
    grouped.set(entry.date, day);
  }
  return [...grouped.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function renderBeverageChoices() {
  const selected = beverageInput.value || "Bier";
  beverageInput.innerHTML = settings.beverages.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join("");
  beverageInput.value = settings.beverages.includes(selected) ? selected : settings.beverages[0];
}

function renderStatus() {
  const balance = accountBalance();
  const stock = beerStock();
  document.querySelector("#quick-balance").textContent = currency(balance);
  document.querySelector("#settings-balance").textContent = currency(balance);
  document.querySelector("#quick-stock").textContent = `${stock} Fl.`;
  document.querySelector("#settings-stock").textContent = stock;
}

function renderStatistics() {
  const days = groupEntriesByDay();
  const drinks = days.reduce((sum, day) => sum + day.quantity, 0);
  const cost = days.reduce((sum, day) => sum + day.cost, 0);
  document.querySelector("#stat-days").textContent = days.length;
  document.querySelector("#stat-drinks").textContent = drinks;
  document.querySelector("#stat-cost").textContent = currency(cost);
  document.querySelector("#stat-average").textContent = days.length ? new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(drinks / days.length) : "0,0";

  const chartDays = days.slice(0, 7).reverse();
  const chart = document.querySelector("#consumption-chart");
  if (!chartDays.length) {
    chart.innerHTML = '<p class="chart-empty">Die Statistik erscheint nach deinem ersten Eintrag.</p>';
  } else {
    const maximum = Math.max(...chartDays.map((day) => day.quantity), 1);
    chart.innerHTML = chartDays.map((day) => `<div class="chart-column" title="${escapeHTML(formattedDate(day.date))}: ${day.quantity} Getränke"><span class="chart-value">${day.quantity}</span><div class="chart-track"><div class="chart-bar" style="height:${Math.max(7, (day.quantity / maximum) * 100)}%"></div></div><span class="chart-label">${shortDate(day.date)}</span></div>`).join("");
  }

  const totals = new Map();
  for (const entry of entries) {
    const value = totals.get(entry.beverage) || { quantity: 0, cost: 0 };
    value.quantity += entry.quantity;
    value.cost += entry.quantity * entry.unitPrice;
    totals.set(entry.beverage, value);
  }
  document.querySelector("#beverage-breakdown").innerHTML = totals.size
    ? [...totals.entries()].sort((a, b) => b[1].quantity - a[1].quantity).map(([name, value]) => `<div class="breakdown-row"><div><strong>${escapeHTML(name)}</strong><span>${value.quantity} Getränke</span></div><div class="breakdown-values"><strong>${currency(value.cost)}</strong><span>${Math.round(value.quantity / Math.max(drinks, 1) * 100)} %</span></div></div>`).join("")
    : '<p class="days-empty">Noch keine Verbrauchsdaten.</p>';

  const daysList = document.querySelector("#days-list");
  daysList.innerHTML = days.length ? days.map((day) => {
    const types = [...day.beverages.entries()].map(([name, quantity]) => `${quantity}× ${escapeHTML(name)}`).join(" · ");
    return `<button class="day-row" type="button" data-day="${day.date}"><span class="day-date"><strong>${formattedDate(day.date)}</strong><span>${types}</span></span><span class="day-values"><strong>${currency(day.cost)}</strong><span>${day.quantity} Getränke</span></span></button>`;
  }).join("") : '<p class="days-empty">Noch keine Verbrauchstage vorhanden.</p>';
}

function renderBeverageSettings() {
  document.querySelector("#beverage-settings-list").innerHTML = settings.beverages.map((name) => {
    const isDefault = DEFAULT_BEVERAGES.includes(name);
    return `<div class="settings-row"><span>${escapeHTML(name)}</span>${isDefault ? '<small>Standard</small>' : `<button type="button" data-delete-beverage="${escapeHTML(name)}" aria-label="${escapeHTML(name)} löschen"><svg class="icon"><use href="#icon-trash"/></svg></button>`}</div>`;
  }).join("");
}

function updateCalculatedPrice() {
  const quantity = Number.parseInt(quantityInput.value, 10) || 0;
  const price = parsePrice(priceInput.value) || 0;
  document.querySelector("#calculated-price").textContent = currency(quantity * price);
}

function render() {
  friendlyDate.textContent = formattedDate(dateInput.value);
  const dailyEntries = entries.filter((entry) => entry.date === dateInput.value).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  document.querySelector("#total-quantity").textContent = dailyEntries.reduce((sum, entry) => sum + entry.quantity, 0);
  document.querySelector("#total-price").textContent = currency(dailyEntries.reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0));
  document.querySelector("#entry-count").textContent = dailyEntries.length;

  list.innerHTML = dailyEntries.length ? dailyEntries.map((entry) => `<article class="entry-row"><div class="entry-mug"><svg class="icon"><use href="#${entry.beverage === "Bier" ? "icon-beer" : "icon-drink"}"/></svg></div><div class="entry-info"><strong>${entry.quantity}× ${escapeHTML(entry.beverage)}</strong><span>je ${currency(entry.unitPrice)}</span></div><div class="entry-sum"><strong>${currency(entry.quantity * entry.unitPrice)}</strong><button class="delete-button" type="button" data-delete-id="${entry.id}" aria-label="Eintrag löschen"><svg class="icon"><use href="#icon-trash"/></svg></button></div></article>`).join("") : '<div class="empty-state"><svg class="icon"><use href="#icon-drink"/></svg><p>Noch keine Getränke für diesen Tag.</p></div>';

  renderBeverageChoices();
  renderStatus();
  renderStatistics();
  renderBeverageSettings();
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 1900);
}

document.querySelector("#decrease").addEventListener("click", () => { quantityInput.value = Math.max(1, (Number.parseInt(quantityInput.value, 10) || 1) - 1); updateCalculatedPrice(); });
document.querySelector("#increase").addEventListener("click", () => { quantityInput.value = Math.min(999, (Number.parseInt(quantityInput.value, 10) || 0) + 1); updateCalculatedPrice(); });
quantityInput.addEventListener("input", updateCalculatedPrice);
priceInput.addEventListener("input", updateCalculatedPrice);
dateInput.addEventListener("change", render);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const quantity = Number.parseInt(quantityInput.value, 10);
  const unitPrice = parsePrice(priceInput.value);
  const beverage = beverageInput.value;
  const total = quantity * unitPrice;
  if (!Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(unitPrice) || unitPrice <= 0) return showToast("Bitte gültige Werte eingeben");
  if (total > accountBalance() + 0.001) return showToast("Guthaben reicht nicht aus");
  if (beverage === "Bier" && quantity > beerStock()) return showToast("Nicht genügend Bier im Lager");
  entries.push({ id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, date: dateInput.value, beverage, quantity, unitPrice: Math.round(unitPrice * 100) / 100, createdAt: new Date().toISOString() });
  persistEntries();
  quantityInput.value = 1;
  updateCalculatedPrice();
  render();
  showToast("Eintrag gespeichert");
});

list.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-id]");
  if (!button) return;
  entries = entries.filter((entry) => entry.id !== button.dataset.deleteId);
  persistEntries(); render(); showToast("Eintrag gelöscht");
});

document.querySelector("#days-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-day]");
  if (!row) return;
  dateInput.value = row.dataset.day; render(); setActiveTab("entry");
});

document.querySelector("#deposit-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const amount = parsePrice(document.querySelector("#deposit-amount").value);
  if (!Number.isFinite(amount) || amount <= 0) return showToast("Bitte gültigen Betrag eingeben");
  settings.deposits += Math.round(amount * 100) / 100;
  persistSettings(); event.target.reset(); render(); showToast("Guthaben eingezahlt");
});

document.querySelector("#stock-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const amount = Number.parseInt(document.querySelector("#stock-amount").value, 10);
  if (!Number.isInteger(amount) || amount < 1) return showToast("Bitte gültige Anzahl eingeben");
  settings.beerStockAdded += amount;
  persistSettings(); event.target.reset(); render(); showToast("Bierbestand erhöht");
});

document.querySelector("#beverage-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#new-beverage");
  const name = input.value.trim();
  if (!name) return;
  if (settings.beverages.some((item) => item.toLocaleLowerCase("de") === name.toLocaleLowerCase("de"))) return showToast("Getränk ist bereits vorhanden");
  settings.beverages.push(name); persistSettings(); input.value = ""; render(); beverageInput.value = name; showToast("Getränk hinzugefügt");
});

document.querySelector("#beverage-settings-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-beverage]");
  if (!button) return;
  settings.beverages = settings.beverages.filter((name) => name !== button.dataset.deleteBeverage);
  persistSettings(); render(); showToast("Getränk entfernt");
});

document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.tab)));
document.querySelectorAll("[data-open-tab]").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.openTab)));

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js"));
updateCalculatedPrice();
render();
