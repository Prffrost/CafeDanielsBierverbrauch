const STORAGE_KEY = "cafe-daniels-drink-entries-v1";

const dateInput = document.querySelector("#selected-date");
const friendlyDate = document.querySelector("#friendly-date");
const quantityInput = document.querySelector("#quantity");
const priceInput = document.querySelector("#unit-price");
const form = document.querySelector("#entry-form");
const list = document.querySelector("#entry-list");
const toast = document.querySelector("#toast");

let entries = loadEntries();
let toastTimer;

dateInput.value = localDateString(new Date());

function localDateString(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function loadEntries() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function persistEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function parsePrice(value) {
  const normalized = String(value).trim().replace(/\s/g, "").replace(",", ".");
  return Number.parseFloat(normalized);
}

function currency(value) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(value);
}

function formattedDate(value) {
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  }).format(new Date(`${value}T12:00:00`));
}

function updateCalculatedPrice() {
  const quantity = Number.parseInt(quantityInput.value, 10) || 0;
  const price = parsePrice(priceInput.value) || 0;
  document.querySelector("#calculated-price").textContent = currency(quantity * price);
}

function render() {
  friendlyDate.textContent = formattedDate(dateInput.value);
  const dailyEntries = entries
    .filter((entry) => entry.date === dateInput.value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const totalQuantity = dailyEntries.reduce((sum, entry) => sum + entry.quantity, 0);
  const totalPrice = dailyEntries.reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0);

  document.querySelector("#total-quantity").textContent = totalQuantity;
  document.querySelector("#total-price").textContent = currency(totalPrice);
  document.querySelector("#entry-count").textContent = dailyEntries.length;

  if (dailyEntries.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <span aria-hidden="true">🍺</span>
        <p>Noch keine Getränke für diesen Tag.<br>Der erste Eintrag wartet schon.</p>
      </div>`;
    return;
  }

  list.innerHTML = dailyEntries.map((entry) => `
    <article class="entry-row">
      <div class="entry-mug" aria-hidden="true">🍺</div>
      <div class="entry-info">
        <strong>${entry.quantity} ${entry.quantity === 1 ? "Getränk" : "Getränke"}</strong>
        <span>je ${currency(entry.unitPrice)}</span>
      </div>
      <div class="entry-sum">
        <strong>${currency(entry.quantity * entry.unitPrice)}</strong>
        <button class="delete-button" type="button" data-delete-id="${entry.id}" aria-label="Eintrag löschen">Löschen</button>
      </div>
    </article>`).join("");
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 1800);
}

document.querySelector("#decrease").addEventListener("click", () => {
  quantityInput.value = Math.max(1, (Number.parseInt(quantityInput.value, 10) || 1) - 1);
  updateCalculatedPrice();
});

document.querySelector("#increase").addEventListener("click", () => {
  quantityInput.value = Math.min(999, (Number.parseInt(quantityInput.value, 10) || 0) + 1);
  updateCalculatedPrice();
});

quantityInput.addEventListener("input", updateCalculatedPrice);
priceInput.addEventListener("input", updateCalculatedPrice);
dateInput.addEventListener("change", render);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const quantity = Number.parseInt(quantityInput.value, 10);
  const unitPrice = parsePrice(priceInput.value);

  if (!Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(unitPrice) || unitPrice <= 0) {
    showToast("Bitte gültige Werte eingeben");
    return;
  }

  entries.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    date: dateInput.value,
    quantity,
    unitPrice: Math.round(unitPrice * 100) / 100,
    createdAt: new Date().toISOString()
  });
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
  persistEntries();
  render();
  showToast("Eintrag gelöscht");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js"));
}

updateCalculatedPrice();
render();

