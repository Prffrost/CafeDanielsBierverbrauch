const STORAGE_KEY = "cafe-daniels-drink-entries-v1";
const SETTINGS_KEY = "cafe-daniels-settings-v1";
const DEFAULT_BEVERAGES = ["Bier", "Spezi", "Cola", "Wein"];
const DEFAULT_PRICES = { Bier: 3.5, Spezi: 3, Cola: 3, Wein: 4.5 };
const SUPABASE_CONFIG = window.CAFE_DANIELS_SUPABASE || {};
const REMOTE_ENABLED = Boolean(SUPABASE_CONFIG.url && SUPABASE_CONFIG.publishableKey && window.supabase);
const supabaseClient = REMOTE_ENABLED ? window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey) : null;
const INVITE_TOKEN = new URLSearchParams(window.location.search).get("invite") || localStorage.getItem("cafe-daniels-invite") || "";
const AUTH_REDIRECT_URL = `${new URL("./", window.location.href).href}${INVITE_TOKEN ? `?invite=${encodeURIComponent(INVITE_TOKEN)}` : ""}`;

const dateInput = document.querySelector("#selected-date");
const friendlyDate = document.querySelector("#friendly-date");
const beverageInput = document.querySelector("#beverage");
const quantityInput = document.querySelector("#quantity");
const form = document.querySelector("#entry-form");
const list = document.querySelector("#entry-list");
const toast = document.querySelector("#toast");

let entries = loadEntries();
let settings = loadSettings();
let toastTimer;
let pendingProfilePhoto = "";
let activePeriod = "week";
let currentUser = null;
let currentProfile = null;
let isAdmin = false;
let remoteBeerStock = null;
let remoteBalance = null;
let remoteBeverageIds = new Map();
let organizations = [];
let activeOrganizationId = localStorage.getItem("cafe-daniels-active-org") || "";
let organizationGroups = [];
let organizationMembers = [];

dateInput.value = localDateString(new Date());

function loadEntries() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored.map((entry) => ({ ...entry, beverage: entry.beverage || "Bier" })) : [];
  } catch { return []; }
}

function loadSettings() {
  const fallback = { beverages: [...DEFAULT_BEVERAGES], prices: { ...DEFAULT_PRICES }, deposits: 0, beerStockAdded: 0, profileName: "", profilePhoto: "", remoteInitialized: false };
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (!stored) return fallback;
    const custom = Array.isArray(stored.beverages) ? stored.beverages.filter((item) => typeof item === "string" && item.trim()) : [];
    const beverages = [...new Set([...DEFAULT_BEVERAGES, ...custom])];
    const storedPrices = stored.prices && typeof stored.prices === "object" ? stored.prices : {};
    return {
      beverages,
      prices: Object.fromEntries(beverages.map((name) => [name, Number(storedPrices[name]) > 0 ? Number(storedPrices[name]) : (DEFAULT_PRICES[name] || 3.5)])),
      deposits: Number(stored.deposits) || 0,
      beerStockAdded: Number(stored.beerStockAdded) || 0,
      profileName: typeof stored.profileName === "string" ? stored.profileName : "",
      profilePhoto: typeof stored.profilePhoto === "string" ? stored.profilePhoto : "",
      remoteInitialized: Boolean(stored.remoteInitialized)
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
function accountBalance() { return remoteBalance === null ? settings.deposits - totalSpent() : remoteBalance - entries.filter((entry) => entry.pending).reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0); }
function beerConsumed() { return entries.filter((entry) => entry.beverage === "Bier").reduce((sum, entry) => sum + entry.quantity, 0); }
function beerStock() { return remoteBeerStock === null ? settings.beerStockAdded - beerConsumed() : remoteBeerStock - entries.filter((entry) => entry.pending && entry.beverage === "Bier").reduce((sum, entry) => sum + entry.quantity, 0); }

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

function groupEntriesByDay(sourceEntries = entries) {
  const grouped = new Map();
  for (const entry of sourceEntries) {
    const day = grouped.get(entry.date) || { date: entry.date, quantity: 0, cost: 0, entries: 0, beverages: new Map() };
    day.quantity += entry.quantity;
    day.cost += entry.quantity * entry.unitPrice;
    day.entries += 1;
    day.beverages.set(entry.beverage, (day.beverages.get(entry.beverage) || 0) + entry.quantity);
    grouped.set(entry.date, day);
  }
  return [...grouped.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function periodRange(period) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const start = new Date(now);
  const end = new Date(now);
  if (period === "week") {
    start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    end.setTime(start.getTime()); end.setDate(start.getDate() + 7);
  } else if (period === "month") {
    start.setDate(1);
    end.setFullYear(start.getFullYear(), start.getMonth() + 1, 1);
  } else {
    start.setMonth(0, 1);
    end.setFullYear(start.getFullYear() + 1, 0, 1);
  }
  const dateFormat = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: period === "year" ? "numeric" : undefined });
  const caption = period === "year" ? `${start.getFullYear()}` : `${dateFormat.format(start)} – ${dateFormat.format(new Date(end.getTime() - 86_400_000))}`;
  return { start, end, caption };
}

function chartGroups(periodEntries, range) {
  const groups = [];
  if (activePeriod === "year") {
    for (let month = 0; month < 12; month += 1) groups.push({ key: month, label: new Intl.DateTimeFormat("de-DE", { month: "short" }).format(new Date(range.start.getFullYear(), month, 1)), quantity: 0 });
    for (const entry of periodEntries) groups[new Date(`${entry.date}T12:00:00`).getMonth()].quantity += entry.quantity;
  } else {
    const cursor = new Date(range.start);
    while (cursor < range.end) { groups.push({ key: localDateString(cursor), label: activePeriod === "week" ? new Intl.DateTimeFormat("de-DE", { weekday: "short" }).format(cursor) : new Intl.DateTimeFormat("de-DE", { day: "2-digit" }).format(cursor), quantity: 0 }); cursor.setDate(cursor.getDate() + 1); }
    const lookup = new Map(groups.map((group) => [group.key, group]));
    for (const entry of periodEntries) if (lookup.has(entry.date)) lookup.get(entry.date).quantity += entry.quantity;
  }
  return groups;
}

function renderBeverageChoices() {
  const selected = beverageInput.value || "Bier";
  beverageInput.innerHTML = settings.beverages.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join("");
  beverageInput.value = settings.beverages.includes(selected) ? selected : settings.beverages[0];
  document.querySelector("#fixed-unit-price").textContent = currency(settings.prices[beverageInput.value] || 0);
}

function renderProfile() {
  const photo = pendingProfilePhoto || settings.profilePhoto;
  document.querySelector("#profile-name-display").textContent = settings.profileName || "nicht eingerichtet";
  if (document.activeElement !== document.querySelector("#profile-name")) document.querySelector("#profile-name").value = settings.profileName || "";
  for (const [imageId, fallbackId] of [["profile-photo-display", "profile-fallback-icon"], ["settings-profile-photo", "settings-profile-fallback"]]) {
    const image = document.querySelector(`#${imageId}`);
    const fallback = document.querySelector(`#${fallbackId}`);
    image.hidden = !photo;
    fallback.hidden = Boolean(photo);
    if (photo) image.src = photo;
  }
}

function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const maximum = 512;
        const scale = Math.min(1, maximum / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function remoteErrorMessage(error) {
  const message = error?.message || "Synchronisierung fehlgeschlagen";
  if (message.includes("Guthaben")) return "Guthaben reicht nicht aus";
  if (message.includes("Lagerbestand")) return "Lagerbestand reicht nicht aus";
  return message;
}

async function loadRemoteState() {
  if (!currentUser || !activeOrganizationId) return;
  const membership = organizations.find((item) => item.organization_id === activeOrganizationId);
  isAdmin = membership?.role === "admin";
  const [profileResult, beverageResult, consumptionResult, depositResult, groupResult, memberResult] = await Promise.all([
    supabaseClient.from("profiles").select("display_name").eq("id", currentUser.id).single(),
    supabaseClient.from("org_beverages").select("id,name,price,active").eq("organization_id", activeOrganizationId).eq("active", true).order("name"),
    supabaseClient.from("org_consumptions").select("id,client_id,quantity,unit_price,consumed_at,org_beverages(id,name)").eq("organization_id", activeOrganizationId).eq("user_id", currentUser.id).order("consumed_at", { ascending: false }),
    supabaseClient.from("org_deposits").select("amount").eq("organization_id", activeOrganizationId).eq("user_id", currentUser.id),
    supabaseClient.from("app_groups").select("id,name").eq("organization_id", activeOrganizationId).order("name"),
    supabaseClient.from("memberships").select("user_id,group_id,role").eq("organization_id", activeOrganizationId)
  ]);
  const firstError = [profileResult, beverageResult, consumptionResult, depositResult, groupResult, memberResult].find((result) => result.error)?.error;
  if (firstError) throw firstError;

  currentProfile = profileResult.data;
  if (currentProfile?.display_name) settings.profileName = currentProfile.display_name;
  organizationGroups = groupResult.data;
  organizationMembers = memberResult.data;
  if (organizationMembers.length) {
    const profileList = await supabaseClient.from("profiles").select("id,display_name").in("id", organizationMembers.map((item) => item.user_id));
    if (!profileList.error) organizationMembers = organizationMembers.map((item) => ({ ...item, profile: profileList.data.find((profile) => profile.id === item.user_id) }));
  }
  remoteBeverageIds = new Map(beverageResult.data.map((item) => [item.name, item.id]));
  settings.beverages = beverageResult.data.map((item) => item.name);
  settings.prices = Object.fromEntries(beverageResult.data.map((item) => [item.name, Number(item.price)]));

  const pending = entries.filter((entry) => entry.pending);
  let legacy = entries.filter((entry) => entry.legacy);
  if (!settings.remoteInitialized) {
    legacy = entries.filter((entry) => !entry.pending && !entry.remote).map((entry) => ({ ...entry, legacy: true }));
    settings.remoteInitialized = true;
  }
  const remoteEntries = consumptionResult.data.map((item) => ({ id: item.client_id, remoteId: item.id, remote: true, date: item.consumed_at.slice(0, 10), beverage: item.org_beverages.name, quantity: item.quantity, unitPrice: Number(item.unit_price), createdAt: item.consumed_at }));
  entries = [...pending, ...remoteEntries, ...legacy];
  remoteBalance = depositResult.data.reduce((sum, item) => sum + Number(item.amount), 0) - remoteEntries.reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0);
  const beerId = remoteBeverageIds.get("Bier");
  if (beerId) {
    const stockResult = await supabaseClient.rpc("get_org_stock", { p_org: activeOrganizationId, p_beverage: beerId });
    if (stockResult.error) throw stockResult.error;
    remoteBeerStock = Number(stockResult.data) || 0;
  }
  persistSettings(); persistEntries(); render(); renderOrganizationAdmin();
}

async function syncPendingConsumptions() {
  if (!currentUser || !navigator.onLine) return;
  const pending = entries.filter((entry) => entry.pending);
  for (const entry of pending) {
    const beverageId = remoteBeverageIds.get(entry.beverage);
    if (!beverageId) continue;
    const result = await supabaseClient.rpc("record_org_consumption", { p_client: entry.id, p_org: activeOrganizationId, p_beverage: beverageId, p_quantity: entry.quantity, p_at: `${entry.date}T12:00:00.000Z` });
    if (result.error) { showToast(remoteErrorMessage(result.error)); return; }
    entries = entries.filter((item) => item.id !== entry.id);
  }
  persistEntries();
  await loadRemoteState();
}

async function loadOrganizations() {
  let result = await supabaseClient.from("memberships").select("organization_id,group_id,role,organizations(id,name)").eq("user_id", currentUser.id);
  if (result.error) throw result.error;
  organizations = result.data;
  const acceptedKey = `cafe-daniels-accepted-${INVITE_TOKEN}`;
  if (INVITE_TOKEN && !localStorage.getItem(acceptedKey)) {
    const accepted = await supabaseClient.rpc("accept_invitation", { p_token: INVITE_TOKEN });
    if (accepted.error) throw accepted.error;
    localStorage.setItem(acceptedKey, "1");
    localStorage.removeItem("cafe-daniels-invite");
    result = await supabaseClient.from("memberships").select("organization_id,group_id,role,organizations(id,name)").eq("user_id", currentUser.id);
    if (result.error) throw result.error;
    organizations = result.data;
  }
  if (!organizations.length) {
    const workspaceName = localStorage.getItem("cafe-daniels-new-workspace") || `${settings.profileName || "Mein"} Bereich`;
    const created = await supabaseClient.rpc("create_workspace", { p_name: workspaceName });
    if (created.error) throw created.error;
    const reload = await supabaseClient.from("memberships").select("organization_id,group_id,role,organizations(id,name)").eq("user_id", currentUser.id);
    if (reload.error) throw reload.error;
    organizations = reload.data;
  }
  if (!organizations.length) throw new Error("Noch kein Bereich vorhanden. Bitte unter Einstellungen einen Bereich erstellen.");
  if (!organizations.some((item) => item.organization_id === activeOrganizationId)) activeOrganizationId = organizations[0].organization_id;
  localStorage.setItem("cafe-daniels-active-org", activeOrganizationId);
}

async function initializeRemote() {
  if (!REMOTE_ENABLED) return render();
  const sessionResult = await supabaseClient.auth.getSession();
  currentUser = sessionResult.data.session?.user || null;
  document.querySelector("#auth-screen").hidden = Boolean(currentUser);
  if (currentUser) {
    try { await loadOrganizations(); await loadRemoteState(); await syncPendingConsumptions(); }
    catch (error) { showToast(remoteErrorMessage(error)); render(); }
  }
  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    document.querySelector("#auth-screen").hidden = Boolean(currentUser);
    if (currentUser) { try { await loadOrganizations(); await loadRemoteState(); await syncPendingConsumptions(); } catch (error) { showToast(remoteErrorMessage(error)); } }
  });
}

function renderStatus() {
  const balance = accountBalance();
  const stock = beerStock();
  document.querySelector("#quick-balance").textContent = currency(balance);
  document.querySelector("#settings-balance").textContent = currency(balance);
  document.querySelector("#quick-stock").textContent = `${stock} Fl.`;
  document.querySelector("#settings-stock").textContent = stock;
  document.querySelector("#account-email").textContent = currentUser?.email || "Lokaler Modus";
  document.querySelector("#account-role").textContent = currentUser ? (!organizations.length ? "Noch kein Bereich eingerichtet" : (isAdmin ? "Administrator · synchronisiert" : "Benutzer · synchronisiert")) : "Keine Serververbindung";
  document.querySelector("#sync-dot").classList.toggle("online", Boolean(currentUser && navigator.onLine));
  document.querySelector("#logout-button").hidden = !currentUser;
  document.querySelectorAll("[data-admin-only]").forEach((element) => { element.hidden = REMOTE_ENABLED && !isAdmin; });
  const workspaceSelect = document.querySelector("#workspace-select");
  workspaceSelect.innerHTML = organizations.map((item) => `<option value="${item.organization_id}">${escapeHTML(item.organizations.name)}</option>`).join("");
  workspaceSelect.value = activeOrganizationId;
  workspaceSelect.disabled = !organizations.length;
}

function renderOrganizationAdmin() {
  document.querySelector("#groups-list").innerHTML = organizationGroups.map((group) => `<div class="settings-row"><span>${escapeHTML(group.name)}</span><small>Gruppe</small></div>`).join("");
  document.querySelector("#invite-group").innerHTML = organizationGroups.map((group) => `<option value="${group.id}">${escapeHTML(group.name)}</option>`).join("");
  document.querySelector("#members-list").innerHTML = organizationMembers.map((member) => `<div class="member-row"><span>${escapeHTML(member.profile?.display_name || member.user_id)}${member.role === "admin" ? " · Admin" : ""}</span><select data-member-user="${member.user_id}" ${member.role === "admin" ? "disabled" : ""}>${organizationGroups.map((group) => `<option value="${group.id}" ${group.id === member.group_id ? "selected" : ""}>${escapeHTML(group.name)}</option>`).join("")}</select></div>`).join("");
}

function renderStatistics() {
  const range = periodRange(activePeriod);
  const periodEntries = entries.filter((entry) => { const date = new Date(`${entry.date}T12:00:00`); return date >= range.start && date < range.end; });
  const days = groupEntriesByDay(periodEntries);
  const allDays = groupEntriesByDay();
  const drinks = days.reduce((sum, day) => sum + day.quantity, 0);
  const cost = days.reduce((sum, day) => sum + day.cost, 0);
  document.querySelector("#period-caption").textContent = range.caption;
  document.querySelector("#stat-days").textContent = days.length;
  document.querySelector("#stat-drinks").textContent = drinks;
  document.querySelector("#stat-cost").textContent = currency(cost);
  document.querySelector("#stat-average").textContent = days.length ? new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(drinks / days.length) : "0,0";

  const chartDays = chartGroups(periodEntries, range);
  const chart = document.querySelector("#consumption-chart");
  const maximum = Math.max(...chartDays.map((day) => day.quantity), 1);
  chart.innerHTML = chartDays.map((day) => `<div class="chart-column" title="${day.label}: ${day.quantity} Getränke"><span class="chart-value">${day.quantity || ""}</span><div class="chart-track"><div class="chart-bar" style="height:${day.quantity ? Math.max(7, (day.quantity / maximum) * 100) : 0}%"></div></div><span class="chart-label">${day.label}</span></div>`).join("");

  const totals = new Map();
  for (const entry of periodEntries) {
    const value = totals.get(entry.beverage) || { quantity: 0, cost: 0 };
    value.quantity += entry.quantity;
    value.cost += entry.quantity * entry.unitPrice;
    totals.set(entry.beverage, value);
  }
  document.querySelector("#beverage-breakdown").innerHTML = totals.size
    ? [...totals.entries()].sort((a, b) => b[1].quantity - a[1].quantity).map(([name, value]) => `<div class="breakdown-row"><div><strong>${escapeHTML(name)}</strong><span>${value.quantity} Getränke</span></div><div class="breakdown-values"><strong>${currency(value.cost)}</strong><span>${Math.round(value.quantity / Math.max(drinks, 1) * 100)} %</span></div></div>`).join("")
    : '<p class="days-empty">Noch keine Verbrauchsdaten.</p>';

  const daysList = document.querySelector("#days-list");
  daysList.innerHTML = allDays.length ? allDays.map((day) => {
    const types = [...day.beverages.entries()].map(([name, quantity]) => `${quantity}× ${escapeHTML(name)}`).join(" · ");
    return `<button class="day-row" type="button" data-day="${day.date}"><span class="day-date"><strong>${formattedDate(day.date)}</strong><span>${types}</span></span><span class="day-values"><strong>${currency(day.cost)}</strong><span>${day.quantity} Getränke</span></span></button>`;
  }).join("") : '<p class="days-empty">Noch keine Verbrauchstage vorhanden.</p>';
}

function renderBeverageSettings() {
  document.querySelector("#beverage-settings-list").innerHTML = settings.beverages.map((name) => {
    const isDefault = DEFAULT_BEVERAGES.includes(name);
    return `<div class="settings-row"><span>${escapeHTML(name)}</span><div class="beverage-setting-values"><input class="beverage-price-input" data-price-beverage="${escapeHTML(name)}" type="text" inputmode="decimal" value="${settings.prices[name].toFixed(2).replace(".", ",")}" aria-label="Preis für ${escapeHTML(name)}" ${REMOTE_ENABLED && !isAdmin ? "disabled" : ""}><span>€</span>${isDefault || (REMOTE_ENABLED && !isAdmin) ? '' : `<button type="button" data-delete-beverage="${escapeHTML(name)}" aria-label="${escapeHTML(name)} löschen"><svg class="icon"><use href="#icon-trash"/></svg></button>`}</div></div>`;
  }).join("");
}

function updateCalculatedPrice() {
  const quantity = Number.parseInt(quantityInput.value, 10) || 0;
  const price = settings.prices[beverageInput.value] || 0;
  document.querySelector("#fixed-unit-price").textContent = currency(price);
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
  updateCalculatedPrice();
  renderProfile();
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
beverageInput.addEventListener("change", updateCalculatedPrice);
dateInput.addEventListener("change", render);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const quantity = Number.parseInt(quantityInput.value, 10);
  const beverage = beverageInput.value;
  const unitPrice = settings.prices[beverage];
  const total = quantity * unitPrice;
  if (!Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(unitPrice) || unitPrice <= 0) return showToast("Bitte gültige Werte eingeben");
  if (total > accountBalance() + 0.001) return showToast("Guthaben reicht nicht aus");
  if (beverage === "Bier" && quantity > beerStock()) return showToast("Nicht genügend Bier im Lager");
  const newEntry = { id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, date: dateInput.value, beverage, quantity, unitPrice: Math.round(unitPrice * 100) / 100, createdAt: new Date().toISOString() };
  if (currentUser && navigator.onLine) {
    const result = await supabaseClient.rpc("record_org_consumption", { p_client: newEntry.id, p_org: activeOrganizationId, p_beverage: remoteBeverageIds.get(beverage), p_quantity: quantity, p_at: `${dateInput.value}T12:00:00.000Z` });
    if (result.error) return showToast(remoteErrorMessage(result.error));
    await loadRemoteState();
  } else {
    entries.push({ ...newEntry, pending: Boolean(REMOTE_ENABLED) });
    persistEntries();
  }
  quantityInput.value = 1;
  render(); showToast(currentUser && navigator.onLine ? "Eintrag synchronisiert" : "Offline gespeichert");
});

list.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-id]");
  if (!button) return;
  const entry = entries.find((item) => item.id === button.dataset.deleteId);
  if (entry?.remoteId && currentUser && navigator.onLine) {
    const result = await supabaseClient.from("org_consumptions").delete().eq("id", entry.remoteId);
    if (result.error) return showToast(remoteErrorMessage(result.error));
    await loadRemoteState();
    return showToast("Eintrag gelöscht");
  }
  entries = entries.filter((entry) => entry.id !== button.dataset.deleteId);
  persistEntries(); render(); showToast("Eintrag gelöscht");
});

document.querySelector("#days-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-day]");
  if (!row) return;
  dateInput.value = row.dataset.day; render(); setActiveTab("entry");
});

document.querySelector("#deposit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const amount = parsePrice(document.querySelector("#deposit-amount").value);
  if (!Number.isFinite(amount) || amount <= 0) return showToast("Bitte gültigen Betrag eingeben");
  if (currentUser) {
    if (!activeOrganizationId) return showToast("Bitte zuerst einen aktiven Bereich erstellen");
    if (!navigator.onLine) return showToast("Einzahlung benötigt eine Verbindung");
    const result = await supabaseClient.from("org_deposits").insert({ client_id: crypto.randomUUID(), organization_id: activeOrganizationId, user_id: currentUser.id, amount: Math.round(amount * 100) / 100 });
    if (result.error) return showToast(remoteErrorMessage(result.error));
    event.target.reset(); await loadRemoteState(); return showToast("Guthaben eingezahlt");
  }
  settings.deposits += Math.round(amount * 100) / 100; persistSettings(); event.target.reset(); render(); showToast("Guthaben eingezahlt");
});

document.querySelector("#stock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const amount = Number.parseInt(document.querySelector("#stock-amount").value, 10);
  if (!Number.isInteger(amount) || amount < 1) return showToast("Bitte gültige Anzahl eingeben");
  if (currentUser) {
    if (!isAdmin) return showToast("Nur für Administratoren");
    if (!navigator.onLine) return showToast("Lagerzugang benötigt eine Verbindung");
    const result = await supabaseClient.from("org_stock_movements").insert({ organization_id: activeOrganizationId, beverage_id: remoteBeverageIds.get("Bier"), quantity: amount, note: "Lagerzugang", created_by: currentUser.id });
    if (result.error) return showToast(remoteErrorMessage(result.error));
    event.target.reset(); await loadRemoteState(); return showToast("Globaler Bestand erhöht");
  }
  settings.beerStockAdded += amount; persistSettings(); event.target.reset(); render(); showToast("Bierbestand erhöht");
});

document.querySelector("#beverage-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#new-beverage");
  const name = input.value.trim();
  const price = parsePrice(document.querySelector("#new-beverage-price").value);
  if (!name || !Number.isFinite(price) || price <= 0) return showToast("Name und gültigen Preis eingeben");
  if (settings.beverages.some((item) => item.toLocaleLowerCase("de") === name.toLocaleLowerCase("de"))) return showToast("Getränk ist bereits vorhanden");
  if (currentUser) {
    if (!isAdmin) return showToast("Nur für Administratoren");
    const result = await supabaseClient.from("org_beverages").insert({ organization_id: activeOrganizationId, name, price: Math.round(price * 100) / 100 });
    if (result.error) return showToast(remoteErrorMessage(result.error));
    event.target.reset(); await loadRemoteState(); beverageInput.value = name; updateCalculatedPrice(); return showToast("Getränk hinzugefügt");
  }
  settings.beverages.push(name); settings.prices[name] = Math.round(price * 100) / 100; persistSettings(); event.target.reset(); render(); beverageInput.value = name; updateCalculatedPrice(); showToast("Getränk hinzugefügt");
});

document.querySelector("#beverage-settings-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-beverage]");
  if (!button) return;
  if (currentUser) {
    if (!isAdmin) return showToast("Nur für Administratoren");
    const result = await supabaseClient.from("org_beverages").update({ active: false }).eq("id", remoteBeverageIds.get(button.dataset.deleteBeverage));
    if (result.error) return showToast(remoteErrorMessage(result.error));
    await loadRemoteState(); return showToast("Getränk entfernt");
  }
  settings.beverages = settings.beverages.filter((name) => name !== button.dataset.deleteBeverage);
  delete settings.prices[button.dataset.deleteBeverage];
  persistSettings(); render(); showToast("Getränk entfernt");
});

document.querySelector("#beverage-settings-list").addEventListener("change", async (event) => {
  const input = event.target.closest("[data-price-beverage]");
  if (!input) return;
  const price = parsePrice(input.value);
  if (!Number.isFinite(price) || price <= 0) { renderBeverageSettings(); return showToast("Bitte gültigen Preis eingeben"); }
  if (currentUser) {
    if (!isAdmin) return showToast("Nur für Administratoren");
    const result = await supabaseClient.from("org_beverages").update({ price: Math.round(price * 100) / 100 }).eq("id", remoteBeverageIds.get(input.dataset.priceBeverage));
    if (result.error) return showToast(remoteErrorMessage(result.error));
    await loadRemoteState(); return showToast("Globaler Preis gespeichert");
  }
  settings.prices[input.dataset.priceBeverage] = Math.round(price * 100) / 100;
  persistSettings(); render(); updateCalculatedPrice(); showToast("Preis gespeichert");
});

document.querySelector("#profile-photo").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    pendingProfilePhoto = await resizePhoto(file);
    renderProfile();
  } catch { showToast("Bild konnte nicht verarbeitet werden"); }
});

document.querySelector("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#profile-name").value.trim();
  if (!name) return showToast("Bitte Namen eingeben");
  settings.profileName = name;
  if (pendingProfilePhoto) settings.profilePhoto = pendingProfilePhoto;
  pendingProfilePhoto = "";
  persistSettings();
  if (currentUser && navigator.onLine) {
    const result = await supabaseClient.from("profiles").update({ display_name: name }).eq("id", currentUser.id);
    if (result.error) return showToast(remoteErrorMessage(result.error));
  }
  render(); showToast("Profil gespeichert");
});

document.querySelector("#workspace-select").addEventListener("change", async (event) => {
  activeOrganizationId = event.target.value;
  localStorage.setItem("cafe-daniels-active-org", activeOrganizationId);
  remoteBeerStock = null; remoteBalance = null;
  try { await loadRemoteState(); await syncPendingConsumptions(); showToast("Bereich gewechselt"); }
  catch (error) { showToast(remoteErrorMessage(error)); }
});

document.querySelector("#workspace-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) return showToast("Bitte zuerst anmelden");
  if (!navigator.onLine) return showToast("Bereichserstellung benötigt eine Verbindung");
  const name = document.querySelector("#workspace-name").value.trim();
  if (!name) return showToast("Bitte einen Bereichsnamen eingeben");
  const created = await supabaseClient.rpc("create_workspace", { p_name: name });
  if (created.error) return showToast(remoteErrorMessage(created.error));
  activeOrganizationId = created.data;
  localStorage.setItem("cafe-daniels-active-org", activeOrganizationId);
  event.target.reset();
  try { await loadOrganizations(); await loadRemoteState(); render(); showToast("Bereich erstellt – du bist Administrator"); }
  catch (error) { showToast(remoteErrorMessage(error)); }
});

document.querySelector("#group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isAdmin) return showToast("Nur für Administratoren");
  const name = document.querySelector("#new-group-name").value.trim();
  const result = await supabaseClient.from("app_groups").insert({ organization_id: activeOrganizationId, name });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  event.target.reset(); await loadRemoteState(); showToast("Gruppe erstellt");
});

document.querySelector("#invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const groupId = document.querySelector("#invite-group").value;
  const email = document.querySelector("#invite-email").value.trim();
  const result = await supabaseClient.rpc("create_invitation", { p_org: activeOrganizationId, p_group: groupId, p_email: email || null });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  const link = `${new URL("./", window.location.href).href}?invite=${encodeURIComponent(result.data.token)}`;
  document.querySelector("#invite-result").hidden = false;
  document.querySelector("#invite-link").value = link;
  const qr = document.querySelector("#invite-qr"); qr.innerHTML = "";
  if (window.QRCode) new window.QRCode(qr, { text: link, width: 180, height: 180 });
  document.querySelector("#mail-invite").href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Einladung zu Cafe Daniels")}&body=${encodeURIComponent(`Du wurdest eingeladen. Öffne diesen Link:\n\n${link}`)}`;
  showToast("Einladung erstellt");
});

document.querySelector("#copy-invite").addEventListener("click", async () => {
  await navigator.clipboard.writeText(document.querySelector("#invite-link").value);
  showToast("Einladungslink kopiert");
});

document.querySelector("#members-list").addEventListener("change", async (event) => {
  const select = event.target.closest("[data-member-user]");
  if (!select || !isAdmin) return;
  const result = await supabaseClient.from("memberships").update({ group_id: select.value }).eq("organization_id", activeOrganizationId).eq("user_id", select.dataset.memberUser);
  if (result.error) return showToast(remoteErrorMessage(result.error));
  await loadRemoteState(); showToast("Gruppe geändert");
});

document.querySelectorAll("[data-period]").forEach((button) => button.addEventListener("click", () => {
  activePeriod = button.dataset.period;
  document.querySelectorAll("[data-period]").forEach((item) => item.classList.toggle("is-active", item === button));
  renderStatistics();
}));

document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.tab)));
document.querySelectorAll("[data-open-tab]").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.openTab)));

document.querySelector("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.querySelector("#auth-email").value.trim();
  const password = document.querySelector("#auth-password").value;
  const result = await supabaseClient.auth.signInWithPassword({ email, password });
  document.querySelector("#auth-message").textContent = result.error ? remoteErrorMessage(result.error) : "Anmeldung erfolgreich";
});

document.querySelector("#register-button").addEventListener("click", async () => {
  const email = document.querySelector("#auth-email").value.trim();
  const password = document.querySelector("#auth-password").value;
  const displayName = document.querySelector("#auth-display-name").value.trim() || email.split("@")[0];
  const workspaceName = document.querySelector("#auth-workspace").value.trim();
  if (!email || password.length < 6) return document.querySelector("#auth-message").textContent = "E-Mail und mindestens 6 Zeichen Passwort eingeben.";
  if (!INVITE_TOKEN && !workspaceName) return document.querySelector("#auth-message").textContent = "Bitte einen Namen für deinen Bereich eingeben.";
  settings.profileName = displayName; persistSettings();
  if (INVITE_TOKEN) localStorage.setItem("cafe-daniels-invite", INVITE_TOKEN);
  else localStorage.setItem("cafe-daniels-new-workspace", workspaceName);
  const result = await supabaseClient.auth.signUp({ email, password, options: { emailRedirectTo: AUTH_REDIRECT_URL, data: { display_name: displayName } } });
  document.querySelector("#auth-message").textContent = result.error ? remoteErrorMessage(result.error) : "Konto erstellt. Bitte E-Mail bestätigen und danach anmelden.";
});

document.querySelector("#resend-button").addEventListener("click", async () => {
  const email = document.querySelector("#auth-email").value.trim();
  if (!email) return document.querySelector("#auth-message").textContent = "Bitte zuerst deine E-Mail eingeben.";
  const result = await supabaseClient.auth.resend({ type: "signup", email, options: { emailRedirectTo: AUTH_REDIRECT_URL } });
  document.querySelector("#auth-message").textContent = result.error ? remoteErrorMessage(result.error) : "Neue Bestätigungs-E-Mail wurde versendet.";
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  currentUser = null; currentProfile = null; isAdmin = false; remoteBeerStock = null; remoteBalance = null;
  document.querySelector("#auth-screen").hidden = false;
});

window.addEventListener("online", async () => { renderStatus(); if (currentUser) { try { await loadRemoteState(); await syncPendingConsumptions(); } catch (error) { showToast(remoteErrorMessage(error)); } } });
window.addEventListener("offline", renderStatus);

if (INVITE_TOKEN) {
  localStorage.setItem("cafe-daniels-invite", INVITE_TOKEN);
  document.querySelector("#auth-copy").textContent = "Du wurdest eingeladen. Erstelle ein Konto oder melde dich an, um der vorgesehenen Gruppe beizutreten.";
  document.querySelector("#auth-workspace").closest(".field-group").hidden = true;
}

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js"));
render();
initializeRemote();
