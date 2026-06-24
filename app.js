const STORAGE_KEY = "cafe-daniels-drink-entries-v1";
const SETTINGS_KEY = "cafe-daniels-settings-v1";
const DEFAULT_BEVERAGES = ["Bier", "Spezi", "Cola", "Wein"];
const DEFAULT_PRICES = { Bier: 3.5, Spezi: 3, Cola: 3, Wein: 4.5 };
const DEFAULT_PURCHASE_PRICES = { Bier: 1 };
const DEFAULT_WORKSPACE_NAME = "Cafe Daniel - LA -";
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
let remoteStockByBeverage = new Map();
let remoteBalance = null;
let negativeLimit = 0;
let remoteBeverageIds = new Map();
let organizations = [];
let activeOrganizationId = localStorage.getItem("cafe-daniels-active-org") || "";
let organizationGroups = [];
let organizationMembers = [];
let remoteStatusMessage = "";
let adminEntries = [];
let activeStatsUser = "me";
let scannerStream = null;
let scannerFrame = 0;
let chatMessages = [];
const WORKSPACE_LIMIT = 10;
const CHAT_LIMIT = 10;
let selectedGroupId = localStorage.getItem("cafe-daniels-active-group") || "";
let memberGroupLinks = [];
let activeSettingsSection = localStorage.getItem("cafe-daniels-settings-section") || "locations";
let memberBalances = new Map();
let receivedGifts = [];
let chatMode = localStorage.getItem("cafe-daniels-chat-mode") || "group";
let chatRecipientId = localStorage.getItem("cafe-daniels-chat-recipient") || "";
let chatLiveTimer = 0;
let stockExpenses = [];
let stockFinanceByBeverage = new Map();

dateInput.value = localDateString(new Date());

function loadEntries() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored.map((entry) => ({ ...entry, beverage: entry.beverage || "Bier" })) : [];
  } catch { return []; }
}

function loadSettings() {
  const fallback = { beverages: [...DEFAULT_BEVERAGES], prices: { ...DEFAULT_PRICES }, purchasePrices: { ...DEFAULT_PURCHASE_PRICES }, deposits: 0, beerStockAdded: 0, profileName: "", profilePhoto: "", profilePhone: "", remoteInitialized: false, theme: "light" };
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (!stored) return fallback;
    const custom = Array.isArray(stored.beverages) ? stored.beverages.filter((item) => typeof item === "string" && item.trim()) : [];
    const beverages = [...new Set([...DEFAULT_BEVERAGES, ...custom])];
    const storedPrices = stored.prices && typeof stored.prices === "object" ? stored.prices : {};
    const storedPurchasePrices = stored.purchasePrices && typeof stored.purchasePrices === "object" ? stored.purchasePrices : {};
    return {
      beverages,
      prices: Object.fromEntries(beverages.map((name) => [name, Number(storedPrices[name]) > 0 ? Number(storedPrices[name]) : (DEFAULT_PRICES[name] || 3.5)])),
      purchasePrices: Object.fromEntries(beverages.map((name) => [name, Number(storedPurchasePrices[name]) >= 0 ? Number(storedPurchasePrices[name]) : (DEFAULT_PURCHASE_PRICES[name] || 0)])),
      deposits: Number(stored.deposits) || 0,
      beerStockAdded: Number(stored.beerStockAdded) || 0,
      profileName: typeof stored.profileName === "string" ? stored.profileName : "",
      profilePhoto: typeof stored.profilePhoto === "string" ? stored.profilePhoto : "",
      profilePhone: typeof stored.profilePhone === "string" ? stored.profilePhone : "",
      remoteInitialized: Boolean(stored.remoteInitialized),
      theme: stored.theme === "dark" ? "dark" : "light"
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

function applyTheme() {
  document.body.dataset.theme = settings.theme || "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", settings.theme === "dark" ? "#071827" : "#f7fbff");
  document.querySelectorAll("[data-theme-choice]").forEach((button) => button.classList.toggle("is-active", button.dataset.themeChoice === settings.theme));
}

function activeMembership() {
  return organizations.find((item) => item.organization_id === activeOrganizationId);
}

function activeGroupId() {
  const available = availableGroupsForCurrentUser();
  if (selectedGroupId && available.some((group) => group.id === selectedGroupId)) return selectedGroupId;
  return available[0]?.id || activeMembership()?.group_id || organizationMembers.find((member) => member.user_id === currentUser?.id)?.group_id || null;
}

function memberGroupIds(userId) {
  const linked = memberGroupLinks.filter((link) => link.user_id === userId).map((link) => link.group_id);
  const member = organizationMembers.find((item) => item.user_id === userId);
  return [...new Set([...linked, member?.group_id].filter(Boolean))];
}

function memberName(userId) {
  const member = organizationMembers.find((item) => item.user_id === userId);
  return member?.profile?.display_name || (userId === currentUser?.id ? settings.profileName : "") || userId || "Unbekannt";
}

function availableGroupsForCurrentUser() {
  if (isAdmin) return organizationGroups;
  const ids = memberGroupIds(currentUser?.id);
  return organizationGroups.filter((group) => ids.includes(group.id));
}

function visibleOrganizations() {
  const unique = [];
  const seen = new Set();
  const active = organizations.find((item) => item.organization_id === activeOrganizationId);
  if (active) {
    unique.push(active);
    seen.add((active.organizations?.name || active.organization_id).toLocaleLowerCase("de"));
  }
  for (const item of organizations) {
    const key = (item.organizations?.name || item.organization_id).toLocaleLowerCase("de");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  const limited = unique.slice(0, WORKSPACE_LIMIT);
  if (activeOrganizationId && !limited.some((item) => item.organization_id === activeOrganizationId)) {
    const active = organizations.find((item) => item.organization_id === activeOrganizationId);
    if (active) return [active, ...limited.slice(0, WORKSPACE_LIMIT - 1)];
  }
  return limited;
}

function totalSpent() { return entries.reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0); }
function accountBalance() { return remoteBalance === null ? settings.deposits - totalSpent() : remoteBalance - entries.filter((entry) => entry.pending).reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0); }
function beerConsumed() { return entries.filter((entry) => entry.beverage === "Bier").reduce((sum, entry) => sum + entry.quantity, 0); }
function beerStock() { return remoteBeerStock === null ? settings.beerStockAdded - beerConsumed() : remoteBeerStock - entries.filter((entry) => entry.pending && entry.beverage === "Bier").reduce((sum, entry) => sum + entry.quantity, 0); }
function currentBeverageStock(name) {
  const pending = entries.filter((entry) => entry.pending && entry.beverage === name).reduce((sum, entry) => sum + entry.quantity, 0);
  if (remoteStockByBeverage.has(name)) return remoteStockByBeverage.get(name) - pending;
  if (name === "Bier") return beerStock();
  return 0;
}
function allowedSpendingBalance() { return accountBalance() + (Number(negativeLimit) || 0); }

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

function openProfileSettings() {
  activeSettingsSection = "general";
  localStorage.setItem("cafe-daniels-settings-section", activeSettingsSection);
  document.querySelector("#profile-popover").hidden = true;
  setActiveTab("settings");
  renderSettingsSections();
  setTimeout(() => document.querySelector("#profile-settings-card")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
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

function canDeleteEntry(entry) {
  if (!entry) return false;
  if (currentUser && isAdmin) return true;
  return Date.now() - new Date(entry.createdAt).getTime() <= 5 * 60 * 1000;
}

function financeRangeEntries(period) {
  const source = isAdmin ? adminEntries : entries;
  const now = new Date();
  const today = localDateString(now);
  if (period === "day") return source.filter((entry) => entry.date === today);
  const range = periodRange(period);
  return source.filter((entry) => {
    const date = new Date(`${entry.date}T12:00:00`);
    return date >= range.start && date < range.end;
  });
}

function inFinancePeriod(dateValue, period) {
  if (period === "day") return dateValue === localDateString(new Date());
  const range = periodRange(period);
  const date = new Date(`${dateValue}T12:00:00`);
  return date >= range.start && date < range.end;
}

function financeSummary(period) {
  const summary = financeRangeEntries(period).reduce((summary, entry) => {
    const income = entry.quantity * entry.unitPrice;
    summary.quantity += entry.quantity;
    summary.income += income;
    return summary;
  }, { quantity: 0, income: 0, expense: 0 });
  const expenseSource = stockExpenses.length ? stockExpenses : financeRangeEntries(period).map((entry) => ({ date: entry.date, expense: entry.quantity * (settings.purchasePrices?.[entry.beverage] || 0) }));
  summary.expense = expenseSource.filter((item) => inFinancePeriod(item.date, period)).reduce((sum, item) => sum + item.expense, 0);
  return summary;
}

function stockFillSummary(period) {
  return stockExpenses.filter((item) => inFinancePeriod(item.date, period)).reduce((summary, item) => {
    summary.quantity += item.quantity;
    summary.expense += item.expense;
    return summary;
  }, { quantity: 0, expense: 0 });
}

function latestStockFill(name) {
  return stockExpenses
    .filter((item) => item.beverage === name)
    .sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date))[0] || null;
}

function renderBeverageChoices() {
  const selected = beverageInput.value || "Bier";
  beverageInput.innerHTML = settings.beverages.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join("");
  beverageInput.value = settings.beverages.includes(selected) ? selected : settings.beverages[0];
  document.querySelector("#fixed-unit-price").textContent = currency(settings.prices[beverageInput.value] || 0);
  const currentStock = document.querySelector("#current-beverage-stock");
  if (currentStock) currentStock.textContent = `${currentBeverageStock(beverageInput.value)} Stk.`;
}

function renderProfile() {
  const photo = pendingProfilePhoto || settings.profilePhoto;
  const profileEmail = currentUser?.email || "";
  const profilePhone = settings.profilePhone || currentProfile?.phone || "";
  document.querySelector("#profile-name-display").textContent = settings.profileName || "nicht eingerichtet";
  if (document.activeElement !== document.querySelector("#profile-name")) document.querySelector("#profile-name").value = settings.profileName || "";
  const emailInput = document.querySelector("#profile-email");
  const phoneInput = document.querySelector("#profile-phone");
  if (emailInput && document.activeElement !== emailInput) emailInput.value = profileEmail;
  if (phoneInput && document.activeElement !== phoneInput) phoneInput.value = profilePhone;
  document.querySelector("#popup-profile-name").textContent = settings.profileName || "Nicht eingerichtet";
  document.querySelector("#popup-profile-email").textContent = profileEmail || "Keine E-Mail";
  document.querySelector("#popup-profile-phone").textContent = profilePhone || "Keine Telefonnummer";
  for (const [imageId, fallbackId] of [["profile-photo-display", "profile-fallback-icon"], ["settings-profile-photo", "settings-profile-fallback"], ["popup-profile-photo", "popup-profile-fallback"]]) {
    const image = document.querySelector(`#${imageId}`);
    const fallback = document.querySelector(`#${fallbackId}`);
    image.hidden = !photo;
    fallback.hidden = Boolean(photo);
    if (photo) image.src = photo;
    else if (fallbackId === "profile-fallback-icon") fallback.textContent = (settings.profileName || currentUser?.email || "?").trim().slice(0, 1).toUpperCase();
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
  if (message.includes("row-level security") && message.includes("org_beverages")) return "Die Supabase-RLS-Korrektur muss einmal im SQL Editor ausgeführt werden.";
  return message;
}

async function loadRemoteState() {
  if (!currentUser || !activeOrganizationId) return;
  const membership = organizations.find((item) => item.organization_id === activeOrganizationId);
  isAdmin = membership?.role === "admin";
  negativeLimit = Number(membership?.organizations?.max_negative_balance) || 0;
  let [firstProfileResult, firstBeverageResult, consumptionResult, depositResult, groupResult, memberResult] = await Promise.all([
    supabaseClient.from("profiles").select("display_name,phone").eq("id", currentUser.id).single(),
    supabaseClient.from("org_beverages").select("id,name,price,purchase_price,active").eq("organization_id", activeOrganizationId).eq("active", true).order("name"),
    supabaseClient.from("org_consumptions").select("id,client_id,quantity,unit_price,consumed_at,gift_to_user,org_beverages(id,name)").eq("organization_id", activeOrganizationId).eq("user_id", currentUser.id).order("consumed_at", { ascending: false }),
    supabaseClient.from("org_deposits").select("amount,gift_from_user,gift_quantity,note,created_at").eq("organization_id", activeOrganizationId).eq("user_id", currentUser.id),
    supabaseClient.from("app_groups").select("id,name").eq("organization_id", activeOrganizationId).order("name"),
    supabaseClient.from("memberships").select("user_id,group_id,role").eq("organization_id", activeOrganizationId)
  ]);
  const beverageResult = firstBeverageResult.error?.message?.includes("purchase_price")
    ? await supabaseClient.from("org_beverages").select("id,name,price,active").eq("organization_id", activeOrganizationId).eq("active", true).order("name")
    : firstBeverageResult;
  const profileResult = firstProfileResult.error?.message?.includes("phone")
    ? await supabaseClient.from("profiles").select("display_name").eq("id", currentUser.id).single()
    : firstProfileResult;
  if (consumptionResult.error?.message?.includes("gift_to_user")) {
    consumptionResult = await supabaseClient.from("org_consumptions").select("id,client_id,quantity,unit_price,consumed_at,org_beverages(id,name)").eq("organization_id", activeOrganizationId).eq("user_id", currentUser.id).order("consumed_at", { ascending: false });
  }
  if (depositResult.error?.message?.includes("gift_from_user")) {
    depositResult = await supabaseClient.from("org_deposits").select("amount").eq("organization_id", activeOrganizationId).eq("user_id", currentUser.id);
  }
  let stockMovementResult = await supabaseClient.from("org_stock_movements").select("quantity,purchase_price,created_at,org_beverages(name,purchase_price)").eq("organization_id", activeOrganizationId);
  if (stockMovementResult.error?.message?.includes("purchase_price")) {
    stockMovementResult = await supabaseClient.from("org_stock_movements").select("quantity,created_at,org_beverages(name,purchase_price)").eq("organization_id", activeOrganizationId);
  }
  const firstError = [profileResult, beverageResult, consumptionResult, depositResult, groupResult, memberResult, stockMovementResult].find((result) => result.error)?.error;
  if (firstError) throw firstError;

  currentProfile = profileResult.data;
  if (currentProfile?.display_name) settings.profileName = currentProfile.display_name;
  settings.profilePhone = currentProfile?.phone || settings.profilePhone || "";
  organizationGroups = groupResult.data;
  organizationMembers = memberResult.data;
  const memberGroupResult = await supabaseClient.from("org_member_groups").select("user_id,group_id").eq("organization_id", activeOrganizationId);
  memberGroupLinks = memberGroupResult.error ? organizationMembers.filter((member) => member.group_id).map((member) => ({ user_id: member.user_id, group_id: member.group_id })) : memberGroupResult.data;
  if (organizationMembers.length) {
    const profileList = await supabaseClient.from("profiles").select("id,display_name").in("id", organizationMembers.map((item) => item.user_id));
    if (!profileList.error) organizationMembers = organizationMembers.map((item) => ({ ...item, profile: profileList.data.find((profile) => profile.id === item.user_id) }));
  }
  chatMessages = [];
  const groupId = activeGroupId();
  if (groupId) {
    selectedGroupId = groupId;
    localStorage.setItem("cafe-daniels-active-group", groupId);
  }
  if (groupId) {
    let chatQuery = supabaseClient.from("org_chat_messages").select("id,user_id,recipient_id,group_id,message,message_type,media_type,media_data,created_at").eq("organization_id", activeOrganizationId).eq("group_id", groupId).order("created_at", { ascending: false }).limit(CHAT_LIMIT);
    if (chatMode === "direct" && chatRecipientId) {
      chatQuery = chatQuery.or(`and(user_id.eq.${currentUser.id},recipient_id.eq.${chatRecipientId}),and(user_id.eq.${chatRecipientId},recipient_id.eq.${currentUser.id})`);
    } else {
      chatQuery = chatQuery.is("recipient_id", null);
    }
    let chatResult = await chatQuery;
    if (chatResult.error?.message?.includes("recipient_id") || chatResult.error?.message?.includes("message_type")) {
      chatResult = await supabaseClient.from("org_chat_messages").select("id,user_id,group_id,message,created_at").eq("organization_id", activeOrganizationId).eq("group_id", groupId).order("created_at", { ascending: false }).limit(CHAT_LIMIT);
    }
    if (!chatResult.error) chatMessages = chatResult.data.reverse();
  }
  remoteBeverageIds = new Map(beverageResult.data.map((item) => [item.name, item.id]));
  settings.beverages = beverageResult.data.map((item) => item.name);
  settings.prices = Object.fromEntries(beverageResult.data.map((item) => [item.name, Number(item.price)]));
  settings.purchasePrices = Object.fromEntries(beverageResult.data.map((item) => [item.name, Number(item.purchase_price) || 0]));
  stockExpenses = stockMovementResult.data
    .filter((item) => Number(item.quantity) > 0)
    .map((item) => {
      const beverage = item.org_beverages?.name || "";
      const unit = Number(item.purchase_price) || Number(item.org_beverages?.purchase_price) || settings.purchasePrices[beverage] || 0;
      return { date: item.created_at.slice(0, 10), createdAt: item.created_at, beverage, quantity: Number(item.quantity) || 0, unit, expense: (Number(item.quantity) || 0) * unit };
    });

  const pending = entries.filter((entry) => entry.pending);
  let legacy = entries.filter((entry) => entry.legacy);
  if (!settings.remoteInitialized) {
    legacy = entries.filter((entry) => !entry.pending && !entry.remote).map((entry) => ({ ...entry, legacy: true }));
    settings.remoteInitialized = true;
  }
  const remoteEntries = consumptionResult.data.map((item) => ({ id: item.client_id, remoteId: item.id, remote: true, date: item.consumed_at.slice(0, 10), beverage: item.org_beverages.name, quantity: item.quantity, unitPrice: Number(item.unit_price), createdAt: item.consumed_at, giftToUser: item.gift_to_user || "" }));
  receivedGifts = depositResult.data.filter((item) => item.gift_from_user).map((item) => ({ id: `${item.created_at}-${item.gift_from_user}`, date: item.created_at.slice(0, 10), beverage: "Bier", quantity: Number(item.gift_quantity) || 1, amount: Number(item.amount), createdAt: item.created_at, fromUser: item.gift_from_user }));
  entries = [...pending, ...remoteEntries, ...legacy];
  remoteBalance = depositResult.data.reduce((sum, item) => sum + Number(item.amount), 0) - remoteEntries.reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0);
  const balanceResult = await supabaseClient.rpc("get_member_balances", { p_org: activeOrganizationId });
  memberBalances = balanceResult.error ? new Map() : new Map(balanceResult.data.map((item) => [item.user_id, Number(item.balance) || 0]));
  adminEntries = [];
  if (isAdmin) {
    let adminConsumption = await supabaseClient.from("org_consumptions").select("id,client_id,user_id,quantity,unit_price,consumed_at,gift_to_user,org_beverages(id,name)").eq("organization_id", activeOrganizationId).order("consumed_at", { ascending: false });
    if (adminConsumption.error?.message?.includes("gift_to_user")) {
      adminConsumption = await supabaseClient.from("org_consumptions").select("id,client_id,user_id,quantity,unit_price,consumed_at,org_beverages(id,name)").eq("organization_id", activeOrganizationId).order("consumed_at", { ascending: false });
    }
    if (!adminConsumption.error) {
      adminEntries = adminConsumption.data.map((item) => ({ id: item.client_id, remoteId: item.id, remote: true, userId: item.user_id, date: item.consumed_at.slice(0, 10), beverage: item.org_beverages.name, quantity: item.quantity, unitPrice: Number(item.unit_price), createdAt: item.consumed_at, giftToUser: item.gift_to_user || "" }));
    }
  }
  stockFinanceByBeverage = new Map();
  for (const name of settings.beverages) {
    const latestFill = latestStockFill(name);
    const expenses = latestFill ? latestFill.expense : 0;
    const source = isAdmin ? adminEntries : entries;
    const income = source
      .filter((entry) => entry.beverage === name && (!latestFill || entry.date >= latestFill.date))
      .reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0);
    stockFinanceByBeverage.set(name, { expenses, income, balance: income - expenses, latestFill });
  }
  const beerId = remoteBeverageIds.get("Bier");
  remoteStockByBeverage = new Map();
  for (const [name, beverageId] of remoteBeverageIds.entries()) {
    const stockResult = await supabaseClient.rpc("get_org_stock", { p_org: activeOrganizationId, p_beverage: beverageId });
    if (!stockResult.error) remoteStockByBeverage.set(name, Number(stockResult.data) || 0);
  }
  remoteBeerStock = beerId ? (remoteStockByBeverage.get("Bier") || 0) : null;
  persistSettings(); persistEntries(); render(); renderOrganizationAdmin(); renderTeam();
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

async function fetchMemberships() {
  let result = await supabaseClient.from("memberships").select("organization_id,group_id,role,organizations(id,name,max_negative_balance)").eq("user_id", currentUser.id);
  if (result.error?.message?.includes("max_negative_balance")) {
    result = await supabaseClient.from("memberships").select("organization_id,group_id,role,organizations(id,name)").eq("user_id", currentUser.id);
  }
  return result;
}

async function loadOrganizations({ autoCreate = true } = {}) {
  let result = await fetchMemberships();
  if (result.error) throw result.error;
  organizations = result.data;
  const acceptedKey = `cafe-daniels-accepted-${INVITE_TOKEN}`;
  if (INVITE_TOKEN && !localStorage.getItem(acceptedKey)) {
    const accepted = await supabaseClient.rpc("accept_invitation", { p_token: INVITE_TOKEN });
    if (accepted.error) throw accepted.error;
    localStorage.setItem(acceptedKey, "1");
    localStorage.removeItem("cafe-daniels-invite");
    result = await fetchMemberships();
    if (result.error) throw result.error;
    organizations = result.data;
  }
  if (!organizations.length) {
    try {
      const cachedOrganization = JSON.parse(localStorage.getItem("cafe-daniels-created-org") || "null");
      if (cachedOrganization?.id && cachedOrganization.userId === currentUser.id) organizations = [{ organization_id: cachedOrganization.id, group_id: null, role: "admin", organizations: cachedOrganization }];
    } catch { localStorage.removeItem("cafe-daniels-created-org"); }
  }
  if (!organizations.length && autoCreate) {
    const workspaceName = localStorage.getItem("cafe-daniels-new-workspace") || DEFAULT_WORKSPACE_NAME;
    const created = await supabaseClient.rpc("create_workspace", { p_name: workspaceName });
    if (created.error) throw created.error;
    activeOrganizationId = created.data;
    localStorage.setItem("cafe-daniels-created-org", JSON.stringify({ id: created.data, name: workspaceName, userId: currentUser.id }));
    const reload = await fetchMemberships();
    if (reload.error) throw reload.error;
    organizations = reload.data;
    if (!organizations.length) organizations = [{ organization_id: created.data, group_id: null, role: "admin", organizations: { id: created.data, name: workspaceName } }];
  }
  if (!organizations.length) {
    activeOrganizationId = "";
    localStorage.removeItem("cafe-daniels-active-org");
    if (autoCreate) throw new Error("Noch kein Lokal vorhanden. Bitte unter Einstellungen ein Lokal erstellen.");
    return;
  }
  if (!organizations.some((item) => item.organization_id === activeOrganizationId)) activeOrganizationId = organizations[0].organization_id;
  localStorage.setItem("cafe-daniels-active-org", activeOrganizationId);
  remoteStatusMessage = "";
}

async function initializeRemote() {
  if (!REMOTE_ENABLED) return render();
  const sessionResult = await supabaseClient.auth.getSession();
  currentUser = sessionResult.data.session?.user || null;
  document.querySelector("#auth-screen").hidden = Boolean(currentUser);
  if (currentUser) {
    try { await loadOrganizations(); await loadRemoteState(); await syncPendingConsumptions(); }
    catch (error) { remoteStatusMessage = remoteErrorMessage(error); showToast(remoteStatusMessage); render(); }
  }
  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    document.querySelector("#auth-screen").hidden = Boolean(currentUser);
    if (currentUser) { try { await loadOrganizations(); await loadRemoteState(); await syncPendingConsumptions(); } catch (error) { remoteStatusMessage = remoteErrorMessage(error); showToast(remoteStatusMessage); render(); } }
  });
  startChatLiveUpdates();
}

function startChatLiveUpdates() {
  if (chatLiveTimer) clearInterval(chatLiveTimer);
  chatLiveTimer = setInterval(async () => {
    if (!currentUser || !activeOrganizationId || document.hidden) return;
    const activePanel = document.querySelector('[data-tab-panel="team"]');
    if (activePanel?.hidden) return;
    try { await loadRemoteState(); } catch { /* live update stays quiet */ }
  }, 4500);
}

function renderStatus() {
  const balance = accountBalance();
  const stock = beerStock();
  document.querySelector("#quick-balance").textContent = currency(balance);
  document.querySelector("#settings-balance").textContent = currency(balance);
  document.querySelector("#quick-stock").textContent = `${stock} Fl.`;
  document.querySelector("#settings-stock").textContent = stock;
  document.querySelector("#settings-stock-label").textContent = "Bier";
  const negativeInput = document.querySelector("#negative-limit");
  if (negativeInput && document.activeElement !== negativeInput) negativeInput.value = (Number(negativeLimit) || 0).toFixed(2).replace(".", ",");
  document.querySelector("#account-email").textContent = currentUser?.email || "Lokaler Modus";
  document.querySelector("#account-role").textContent = currentUser ? (remoteStatusMessage || (!organizations.length ? "Noch kein Lokal eingerichtet" : (isAdmin ? "Administrator · synchronisiert" : "Benutzer · synchronisiert"))) : "Keine Serververbindung";
  document.querySelector("#sync-dot").classList.toggle("online", Boolean(currentUser && navigator.onLine));
  document.querySelector("#logout-button").hidden = !currentUser;
  document.querySelectorAll("[data-admin-only]").forEach((element) => { element.hidden = REMOTE_ENABLED && !isAdmin; });
  const workspaceSelect = document.querySelector("#workspace-select");
  workspaceSelect.innerHTML = visibleOrganizations().map((item) => `<option value="${item.organization_id}">${escapeHTML(item.organizations.name)}</option>`).join("");
  workspaceSelect.value = activeOrganizationId;
  workspaceSelect.disabled = !organizations.length;
  const workspaceList = document.querySelector("#workspace-list");
  if (workspaceList) {
    workspaceList.innerHTML = visibleOrganizations().map((item) => {
      const active = item.organization_id === activeOrganizationId;
      const admin = item.role === "admin";
      return `<div class="workspace-row ${active ? "is-active" : ""}"><div><strong>${escapeHTML(item.organizations.name)}</strong><span>${active ? "Aktiv" : "Standort"} · ${admin ? "Admin" : "Mitglied"}</span></div><div class="workspace-actions"><button type="button" data-switch-workspace="${item.organization_id}" ${active ? "disabled" : ""}>Wechseln</button>${admin ? `<button class="danger-mini" type="button" data-delete-workspace="${item.organization_id}">Löschen</button>` : ""}</div></div>`;
    }).join("");
  }
}

function renderSettingsSections() {
  const allowed = new Set(["locations", "members", "beverages", "qr", "general"]);
  if (!allowed.has(activeSettingsSection)) activeSettingsSection = "locations";
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.settingsTab === activeSettingsSection);
  });
  document.querySelectorAll("[data-settings-section]").forEach((section) => {
    const adminOnly = section.hasAttribute("data-admin-only") && REMOTE_ENABLED && !isAdmin;
    section.hidden = adminOnly || section.dataset.settingsSection !== activeSettingsSection;
  });
}

function renderOrganizationAdmin() {
  document.querySelector("#groups-list").innerHTML = organizationGroups.map((group) => `<div class="settings-row"><span>${escapeHTML(group.name)}</span><button type="button" data-delete-group="${group.id}" aria-label="Gruppe löschen"><svg class="icon"><use href="#icon-trash"/></svg></button></div>`).join("");
  document.querySelector("#invite-group").innerHTML = organizationGroups.map((group) => `<option value="${group.id}">${escapeHTML(group.name)}</option>`).join("");
  document.querySelector("#member-create-group").innerHTML = organizationGroups.map((group) => `<option value="${group.id}">${escapeHTML(group.name)}</option>`).join("");
  const groupId = activeGroupId();
  const visibleMembers = isAdmin ? organizationMembers : organizationMembers.filter((member) => memberGroupIds(member.user_id).includes(groupId));
  document.querySelector("#members-section-title").textContent = isAdmin ? "Mitglieder zuordnen" : "Mitglieder deiner Gruppe";
  document.querySelector("#members-help-text").textContent = isAdmin ? "Haken bei Gruppen ordnen Mitglieder zu. Der Admin-Haken gibt Verwaltungsrechte." : "Du siehst hier nur Mitglieder, die mit dir in der aktiven Gruppe sind.";
  document.querySelector("#members-list").innerHTML = visibleMembers.map((member) => {
    const isSelf = member.user_id === currentUser?.id;
    const groups = memberGroupIds(member.user_id);
    const adminControls = `<div class="member-group-checks"><label class="admin-check"><input type="checkbox" data-member-admin="${member.user_id}" ${member.role === "admin" ? "checked" : ""} ${isSelf ? "disabled" : ""}>Admin</label>${organizationGroups.map((group) => `<label><input type="checkbox" data-member-group-user="${member.user_id}" value="${group.id}" ${groups.includes(group.id) ? "checked" : ""}>${escapeHTML(group.name)}</label>`).join("")}</div><button type="button" data-delete-member="${member.user_id}" ${isSelf ? "disabled" : ""} aria-label="Mitglied entfernen"><svg class="icon"><use href="#icon-trash"/></svg></button>`;
    const readOnlyInfo = `<div class="member-group-checks readonly-groups">${groups.map((groupId) => organizationGroups.find((group) => group.id === groupId)?.name).filter(Boolean).map((name) => `<span>${escapeHTML(name)}</span>`).join("") || "<span>Keine Gruppe</span>"}</div>`;
    return `<div class="member-row multi-member-row"><span><strong>${escapeHTML(member.profile?.display_name || member.user_id)}</strong><small>${member.role === "admin" ? "Admin" : "Mitglied"}</small></span>${isAdmin ? adminControls : readOnlyInfo}</div>`;
  }).join("") || '<p class="days-empty">Keine Mitglieder in deiner Gruppe.</p>';
}

function renderTeam() {
  const groupId = activeGroupId();
  const group = organizationGroups.find((item) => item.id === groupId);
  const availableGroups = availableGroupsForCurrentUser();
  const switcher = document.querySelector("#team-group-select");
  switcher.innerHTML = availableGroups.length ? availableGroups.map((item) => `<option value="${item.id}">${escapeHTML(item.name)}</option>`).join("") : '<option value="">Keine Gruppe</option>';
  switcher.value = groupId || "";
  switcher.disabled = availableGroups.length < 2;
  const members = groupId ? organizationMembers.filter((member) => memberGroupIds(member.user_id).includes(groupId)) : organizationMembers;
  const groupName = group?.name || (currentUser ? "Keine Gruppe zugeordnet" : "Lokaler Modus");
  document.querySelector("#team-group-name").textContent = groupName;
  document.querySelector("#team-members-list").innerHTML = members.length
    ? members.map((member) => {
      const name = member.profile?.display_name || (member.user_id === currentUser?.id ? settings.profileName : "") || member.user_id;
      const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
      return `<article class="team-member-card"><div class="member-avatar">${escapeHTML(initials)}</div><div><strong>${escapeHTML(name)}</strong><span>${member.user_id === currentUser?.id ? "Du" : "Mitglied"} · Guthaben ${currency(memberBalances.get(member.user_id) || 0)}</span></div><span class="role-pill">${member.role === "admin" ? "Admin" : "User"}</span></article>`;
    }).join("")
    : '<p class="days-empty">Noch keine Mitglieder in dieser Gruppe.</p>';
  const giveSelect = document.querySelector("#give-beer-user");
  const possibleReceivers = members.filter((member) => member.user_id !== currentUser?.id);
  giveSelect.innerHTML = possibleReceivers.length
    ? possibleReceivers.map((member) => `<option value="${member.user_id}">${escapeHTML(member.profile?.display_name || member.user_id)}</option>`).join("")
    : '<option value="">Kein anderer Benutzer</option>';
  giveSelect.disabled = !possibleReceivers.length;
  const chatModeSelect = document.querySelector("#chat-mode");
  const chatRecipientSelect = document.querySelector("#chat-recipient");
  chatModeSelect.value = chatMode;
  chatRecipientSelect.hidden = chatMode !== "direct";
  chatRecipientSelect.innerHTML = possibleReceivers.length
    ? possibleReceivers.map((member) => `<option value="${member.user_id}">${escapeHTML(member.profile?.display_name || member.user_id)}</option>`).join("")
    : '<option value="">Kein anderer Benutzer</option>';
  if (!possibleReceivers.some((member) => member.user_id === chatRecipientId)) chatRecipientId = possibleReceivers[0]?.user_id || "";
  chatRecipientSelect.value = chatRecipientId;
  chatRecipientSelect.disabled = chatMode !== "direct" || !possibleReceivers.length;

  document.querySelector("#chat-list").innerHTML = chatMessages.length
    ? chatMessages.map((message) => {
      const member = organizationMembers.find((item) => item.user_id === message.user_id);
      const name = member?.profile?.display_name || (message.user_id === currentUser?.id ? settings.profileName : "") || "Unbekannt";
      const time = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(message.created_at));
      const media = message.media_data && message.media_type?.startsWith("image/") ? `<img class="chat-media-preview" src="${message.media_data}" alt="Bild">` : message.media_data && message.media_type?.startsWith("video/") ? `<video class="chat-media-preview" src="${message.media_data}" controls playsinline></video>` : "";
      const typeLabel = message.message_type === "status" ? "Status" : "";
      return `<article class="chat-message ${message.user_id === currentUser?.id ? "is-own" : ""} ${message.message_type !== "text" ? "is-event" : ""}"><strong>${escapeHTML(name)}</strong>${typeLabel ? `<em>${typeLabel}</em>` : ""}${media}<p>${escapeHTML(message.message)}</p><time>${time}</time></article>`;
    }).join("")
    : '<p class="days-empty">Noch keine Nachrichten. Schreib die erste Runde an.</p>';
  const chatList = document.querySelector("#chat-list");
  chatList.scrollTop = chatList.scrollHeight;
}

function renderStatistics() {
  const range = periodRange(activePeriod);
  const statsSelect = document.querySelector("#stats-user-filter");
  const useAdminEntries = isAdmin && activeStatsUser !== "me";
  const sourceEntries = useAdminEntries ? (activeStatsUser === "all" ? adminEntries : adminEntries.filter((entry) => entry.userId === activeStatsUser)) : entries;
  document.querySelector("#admin-stat-filter").hidden = !isAdmin;
  document.querySelectorAll(".admin-only-stat").forEach((element) => { element.hidden = !isAdmin; });
  if (isAdmin) {
    const selected = statsSelect.value || activeStatsUser;
    statsSelect.innerHTML = `<option value="me">Nur ich</option><option value="all">Alle Benutzer</option>${organizationMembers.map((member) => `<option value="${member.user_id}">${escapeHTML(member.profile?.display_name || member.user_id)}</option>`).join("")}`;
    statsSelect.value = [...statsSelect.options].some((option) => option.value === selected) ? selected : activeStatsUser;
  }
  const periodEntries = sourceEntries.filter((entry) => { const date = new Date(`${entry.date}T12:00:00`); return date >= range.start && date < range.end; });
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

  const userTotals = new Map();
  if (isAdmin) {
    for (const entry of periodEntries) {
      const value = userTotals.get(entry.userId) || { quantity: 0, cost: 0 };
      value.quantity += entry.quantity;
      value.cost += entry.quantity * entry.unitPrice;
      userTotals.set(entry.userId, value);
    }
    document.querySelector("#user-breakdown").innerHTML = userTotals.size
      ? [...userTotals.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([userId, value]) => {
        const member = organizationMembers.find((item) => item.user_id === userId);
        return `<div class="user-stat-row"><div><strong>${escapeHTML(member?.profile?.display_name || userId || "Unbekannt")}</strong><span>${value.quantity} Getränke</span></div><div class="breakdown-values"><strong>${currency(value.cost)}</strong><span>${Math.round(value.quantity / Math.max(drinks, 1) * 100)} %</span></div></div>`;
      }).join("")
      : '<p class="days-empty">Keine Benutzerdaten im Zeitraum.</p>';
  }

  const daysList = document.querySelector("#days-list");
  daysList.innerHTML = allDays.length ? allDays.map((day) => {
    const types = [...day.beverages.entries()].map(([name, quantity]) => `${quantity}× ${escapeHTML(name)}`).join(" · ");
    return `<button class="day-row" type="button" data-day="${day.date}"><span class="day-date"><strong>${formattedDate(day.date)}</strong><span>${types}</span></span><span class="day-values"><strong>${currency(day.cost)}</strong><span>${day.quantity} Getränke</span></span></button>`;
  }).join("") : '<p class="days-empty">Noch keine Verbrauchstage vorhanden.</p>';
}

function renderBeverageSettings() {
  document.querySelector("#beverage-settings-list").innerHTML = settings.beverages.map((name) => {
    const isFixed = name === "Bier";
    return `<div class="settings-row"><span>${escapeHTML(name)}</span><div class="beverage-setting-values"><label class="mini-label">VK</label><input class="beverage-price-input" data-price-beverage="${escapeHTML(name)}" type="text" inputmode="decimal" value="${(settings.prices[name] || 0).toFixed(2).replace(".", ",")}" aria-label="Preis für ${escapeHTML(name)}" ${REMOTE_ENABLED && !isAdmin ? "disabled" : ""}><span>€</span><label class="mini-label">EK</label><input class="beverage-price-input" data-purchase-price-beverage="${escapeHTML(name)}" type="text" inputmode="decimal" value="${(settings.purchasePrices?.[name] || 0).toFixed(2).replace(".", ",")}" aria-label="Einkaufspreis für ${escapeHTML(name)}" ${REMOTE_ENABLED && !isAdmin ? "disabled" : ""}><span>€</span>${isFixed || (REMOTE_ENABLED && !isAdmin) ? '' : `<button type="button" data-delete-beverage="${escapeHTML(name)}" aria-label="${escapeHTML(name)} löschen"><svg class="icon"><use href="#icon-trash"/></svg></button>`}</div></div>`;
  }).join("");
  const beerQr = document.querySelector("#beer-qr");
  if (beerQr && !beerQr.dataset.rendered && window.QRCode) {
    beerQr.innerHTML = "";
    new window.QRCode(beerQr, { text: document.querySelector("#beer-qr-value").value, width: 180, height: 180 });
    beerQr.dataset.rendered = "1";
  }
  const stockSelect = document.querySelector("#stock-beverage");
  if (stockSelect) stockSelect.innerHTML = settings.beverages.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join("");
  const stockPriceInput = document.querySelector("#stock-purchase-price");
  if (stockSelect && stockPriceInput && !stockPriceInput.value) stockPriceInput.value = (settings.purchasePrices?.[stockSelect.value] || 0).toFixed(2).replace(".", ",");
  const depositSelect = document.querySelector("#deposit-user");
  if (depositSelect) depositSelect.innerHTML = organizationMembers.map((member) => `<option value="${member.user_id}">${escapeHTML(member.profile?.display_name || member.user_id)}</option>`).join("");
  const stockList = document.querySelector("#stock-list");
  if (stockList) {
    const stockRows = settings.beverages.map((name) => {
      const stock = remoteStockByBeverage.has(name) ? remoteStockByBeverage.get(name) : (name === "Bier" ? beerStock() : 0);
      const finance = stockFinanceByBeverage.get(name) || { expenses: 0, income: 0, balance: 0 };
      const fillInfo = finance.latestFill ? `${finance.latestFill.quantity} Stk. am ${shortDate(finance.latestFill.date)}` : "Noch keine Füllung";
      return `<div class="stock-finance-row"><div><strong>${escapeHTML(name)}</strong><span>${stock} Stk. aktuell</span></div><div><span>Aktuelle Füllung</span><strong>${fillInfo}</strong></div><div><span>Einkauf</span><strong class="money-negative">-${currency(finance.expenses)}</strong></div><div><span>Einnahmen seit Füllung</span><strong>${currency(finance.income)}</strong></div><div><span>${finance.balance >= 0 ? "Guthaben" : "Offen"}</span><strong class="${finance.balance >= 0 ? "money-positive" : "money-negative"}">${finance.balance >= 0 ? "+" : ""}${currency(finance.balance)}</strong></div></div>`;
    }).join("");
    const historyRows = stockExpenses
      .slice()
      .sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date))
      .slice(0, 10)
      .map((item) => {
        const time = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(item.createdAt || `${item.date}T12:00:00`));
        return `<div class="stock-history-row"><div><strong>${escapeHTML(item.beverage)}</strong><span>${time}</span></div><div><strong>${item.quantity} Stk.</strong><span>EK ${currency(item.unit)} / ${currency(item.expense)}</span></div></div>`;
      }).join("");
    stockList.innerHTML = `${stockRows}<div class="breakdown-heading"><h3>Letzte Lagerfüllungen</h3></div>${historyRows || '<p class="days-empty">Noch keine Lagerfüllung gespeichert.</p>'}`;
  }
  const financeList = document.querySelector("#beverage-finance-list");
  if (financeList) {
    const periods = [["day", "Täglich"], ["week", "Wöchentlich"], ["month", "Monatlich"], ["year", "Jährlich"]];
    financeList.innerHTML = periods.map(([period, label]) => {
      const value = financeSummary(period);
      const fill = stockFillSummary(period);
      const profit = value.income - value.expense;
      return `<div class="finance-row"><strong>${label}</strong><span>${value.quantity} Getränke verkauft</span><span>${fill.quantity} Getränke eingefüllt</span><span>Einnahmen ${currency(value.income)}</span><span>Ausgaben ${currency(value.expense)}</span><span>Gewinn ${currency(profit)}</span></div>`;
    }).join("");
  }
}

function updateCalculatedPrice() {
  const quantity = Number.parseInt(quantityInput.value, 10) || 0;
  const price = settings.prices[beverageInput.value] || 0;
  document.querySelector("#fixed-unit-price").textContent = currency(price);
  document.querySelector("#calculated-price").textContent = currency(quantity * price);
  const currentStock = document.querySelector("#current-beverage-stock");
  if (currentStock) currentStock.textContent = `${currentBeverageStock(beverageInput.value)} Stk.`;
}

function render() {
  applyTheme();
  friendlyDate.textContent = formattedDate(dateInput.value);
  const dailyEntries = entries.filter((entry) => entry.date === dateInput.value).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const dailyGifts = receivedGifts.filter((entry) => entry.date === dateInput.value).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  document.querySelector("#total-quantity").textContent = dailyEntries.reduce((sum, entry) => sum + entry.quantity, 0);
  document.querySelector("#total-price").textContent = currency(dailyEntries.reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0));
  document.querySelector("#entry-count").textContent = dailyEntries.length + dailyGifts.length;

  const entryRows = dailyEntries.map((entry) => `<article class="entry-row"><div class="entry-mug"><svg class="icon"><use href="#${entry.beverage === "Bier" ? "icon-beer" : "icon-drink"}"/></svg></div><div class="entry-info"><strong>${entry.quantity}× ${escapeHTML(entry.beverage)}</strong><span>${entry.giftToUser ? `ausgegeben an ${escapeHTML(memberName(entry.giftToUser))}` : `je ${currency(entry.unitPrice)}`}</span></div><div class="entry-sum"><strong>${currency(entry.quantity * entry.unitPrice)}</strong>${canDeleteEntry(entry) ? `<button class="delete-button" type="button" data-delete-id="${entry.id}" aria-label="Eintrag löschen"><svg class="icon"><use href="#icon-trash"/></svg></button>` : ""}</div></article>`);
  const giftRows = dailyGifts.map((gift) => `<article class="entry-row gift-entry"><div class="entry-mug"><svg class="icon"><use href="#icon-beer"/></svg></div><div class="entry-info"><strong>${gift.quantity}× Bier bekommen</strong><span>von ${escapeHTML(memberName(gift.fromUser))}</span></div><div class="entry-sum"><strong>+${currency(gift.amount)}</strong></div></article>`);
  list.innerHTML = entryRows.length || giftRows.length ? [...entryRows, ...giftRows].join("") : '<div class="empty-state"><svg class="icon"><use href="#icon-drink"/></svg><p>Noch keine Getränke für diesen Tag.</p></div>';

  renderBeverageChoices();
  updateCalculatedPrice();
  renderProfile();
  renderStatus();
  renderSettingsSections();
  renderStatistics();
  renderBeverageSettings();
  renderTeam();
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 1900);
}

let lastTouchEnd = 0;
document.addEventListener("touchend", (event) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 320) event.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener("dblclick", (event) => event.preventDefault(), { passive: false });

function handleQrPayload(payload) {
  const parts = String(payload || "").trim().split(":");
  if (parts[0] !== "cafe-daniels" || parts[1] !== "beverage") return false;
  const beverage = parts[2] || "Bier";
  const quantity = Number.parseInt(parts[3] || "1", 10);
  if (!settings.beverages.includes(beverage)) {
    showToast("Getränk aus QR-Code nicht gefunden");
    return true;
  }
  beverageInput.value = beverage;
  quantityInput.value = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  updateCalculatedPrice();
  stopScanner();
  form.requestSubmit();
  return true;
}

async function startScanner() {
  if (!navigator.mediaDevices?.getUserMedia) return showToast("Kamera wird auf diesem Gerät nicht unterstützt");
  const video = document.querySelector("#qr-video");
  const canvas = document.querySelector("#qr-canvas");
  const card = document.querySelector("#scanner-card");
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = scannerStream;
    card.hidden = false;
    await video.play();
    scanFrame(video, canvas);
  } catch {
    showToast("Kamera konnte nicht geöffnet werden");
  }
}

function scanFrame(video, canvas) {
  if (!scannerStream) return;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR ? window.jsQR(image.data, image.width, image.height) : null;
    if (code?.data && handleQrPayload(code.data)) return;
  }
  scannerFrame = window.requestAnimationFrame(() => scanFrame(video, canvas));
}

function stopScanner() {
  if (scannerFrame) cancelAnimationFrame(scannerFrame);
  scannerFrame = 0;
  if (scannerStream) scannerStream.getTracks().forEach((track) => track.stop());
  scannerStream = null;
  const card = document.querySelector("#scanner-card");
  if (card) card.hidden = true;
}

document.querySelector("#decrease").addEventListener("click", () => { quantityInput.value = Math.max(1, (Number.parseInt(quantityInput.value, 10) || 1) - 1); updateCalculatedPrice(); });
document.querySelector("#increase").addEventListener("click", () => { quantityInput.value = Math.min(999, (Number.parseInt(quantityInput.value, 10) || 0) + 1); updateCalculatedPrice(); });
document.querySelector("#scan-beer-button").addEventListener("click", startScanner);
document.querySelector("#stop-scan-button").addEventListener("click", stopScanner);
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
  if (total > allowedSpendingBalance() + 0.001) return showToast("Guthaben-/Minuslimit reicht nicht aus");
  if (quantity > currentBeverageStock(beverage)) return showToast("Nicht genügend Bestand im Lager");
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
    const result = await supabaseClient.rpc("delete_org_consumption", { p_org: activeOrganizationId, p_consumption: entry.remoteId });
    if (result.error) return showToast(remoteErrorMessage(result.error));
    await loadRemoteState();
    return showToast("Eintrag gelöscht");
  }
  if (entry && Date.now() - new Date(entry.createdAt).getTime() > 5 * 60 * 1000) return showToast("Nur 5 Minuten löschbar");
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
    if (!isAdmin) return showToast("Nur Admin kann Guthaben zuweisen");
    if (!activeOrganizationId) return showToast("Bitte zuerst ein aktives Lokal erstellen");
    if (!navigator.onLine) return showToast("Einzahlung benötigt eine Verbindung");
    const targetUser = document.querySelector("#deposit-user").value;
    if (!targetUser) return showToast("Bitte Benutzer auswählen");
    const result = await supabaseClient.rpc("admin_add_user_deposit", { p_client: crypto.randomUUID(), p_org: activeOrganizationId, p_user: targetUser, p_amount: Math.round(amount * 100) / 100 });
    if (result.error) { remoteStatusMessage = remoteErrorMessage(result.error); renderStatus(); return showToast(remoteStatusMessage); }
    remoteStatusMessage = "";
    event.target.reset(); await loadRemoteState(); return showToast("Guthaben eingezahlt");
  }
  settings.deposits += Math.round(amount * 100) / 100; persistSettings(); event.target.reset(); render(); showToast("Guthaben eingezahlt");
});

document.querySelector("#negative-limit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const limit = parsePrice(document.querySelector("#negative-limit").value || "0");
  if (!Number.isFinite(limit) || limit < 0) return showToast("Bitte gültiges Minuslimit eingeben");
  if (!currentUser || !activeOrganizationId) return showToast("Bitte zuerst anmelden");
  if (!isAdmin) return showToast("Nur Admin kann das Minuslimit ändern");
  const result = await supabaseClient.rpc("set_org_negative_limit", { p_org: activeOrganizationId, p_limit: Math.round(limit * 100) / 100 });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  negativeLimit = Math.round(limit * 100) / 100;
  organizations = organizations.map((item) => item.organization_id === activeOrganizationId ? { ...item, organizations: { ...item.organizations, max_negative_balance: negativeLimit } } : item);
  await loadOrganizations({ autoCreate: false });
  await loadRemoteState();
  showToast("Minuslimit gespeichert");
});

document.querySelector("#stock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const amount = Number.parseInt(document.querySelector("#stock-amount").value, 10);
  const purchasePrice = parsePrice(document.querySelector("#stock-purchase-price").value);
  if (!Number.isInteger(amount) || amount < 1) return showToast("Bitte gültige Anzahl eingeben");
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) return showToast("Bitte gültigen Einkaufspreis eingeben");
  if (currentUser) {
    if (!isAdmin) return showToast("Nur für Administratoren");
    if (!navigator.onLine) return showToast("Lagerzugang benötigt eine Verbindung");
    const beverageName = document.querySelector("#stock-beverage").value || "Bier";
    const beverageId = remoteBeverageIds.get(beverageName);
    if (!beverageId) return showToast("Getränk erst speichern/SQL-Fix ausführen");
    const result = await supabaseClient.rpc("add_org_stock", { p_org: activeOrganizationId, p_beverage: beverageId, p_quantity: amount, p_note: "Lagerzugang", p_purchase_price: Math.round(purchasePrice * 100) / 100 });
    if (result.error) return showToast(remoteErrorMessage(result.error));
    event.target.reset(); await loadRemoteState(); return showToast("Globaler Bestand erhöht");
  }
  const beverageName = document.querySelector("#stock-beverage").value || "Bier";
  if (beverageName === "Bier") settings.beerStockAdded += amount;
  settings.purchasePrices[beverageName] = Math.round(purchasePrice * 100) / 100;
  const now = new Date();
  stockExpenses.push({ date: localDateString(now), createdAt: now.toISOString(), beverage: beverageName, quantity: amount, unit: purchasePrice, expense: amount * purchasePrice });
  persistSettings(); event.target.reset(); render(); showToast("Bestand erhöht");
});

document.querySelector("#stock-beverage").addEventListener("change", (event) => {
  const input = document.querySelector("#stock-purchase-price");
  input.value = (settings.purchasePrices?.[event.target.value] || 0).toFixed(2).replace(".", ",");
});

document.querySelector("#beverage-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#new-beverage");
  const name = input.value.trim();
  const price = parsePrice(document.querySelector("#new-beverage-price").value);
  const purchasePriceInput = document.querySelector("#new-beverage-purchase-price").value;
  const purchasePrice = purchasePriceInput.trim() ? parsePrice(purchasePriceInput) : 0;
  if (!name || !Number.isFinite(price) || price <= 0) return showToast("Name und gültigen Preis eingeben");
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) return showToast("Bitte gültigen Einkaufspreis eingeben");
  if (settings.beverages.some((item) => item.toLocaleLowerCase("de") === name.toLocaleLowerCase("de"))) return showToast("Getränk ist bereits vorhanden");
  if (currentUser) {
    if (!isAdmin) return showToast("Nur für Administratoren");
    const result = await supabaseClient.rpc("upsert_org_beverage", { p_org: activeOrganizationId, p_name: name, p_price: Math.round(price * 100) / 100, p_purchase_price: Math.round(purchasePrice * 100) / 100 });
    if (result.error) {
      if ((result.error.message || "").includes("function") || (result.error.message || "").includes("schema cache")) return showToast("Bitte aktuellen SQL-Fix in Supabase ausführen");
      return showToast(remoteErrorMessage(result.error));
    }
    event.target.reset(); await loadRemoteState(); beverageInput.value = name; updateCalculatedPrice(); return showToast("Getränk hinzugefügt");
  }
  settings.beverages.push(name); settings.prices[name] = Math.round(price * 100) / 100; settings.purchasePrices[name] = Math.round(purchasePrice * 100) / 100; persistSettings(); event.target.reset(); render(); beverageInput.value = name; updateCalculatedPrice(); showToast("Getränk hinzugefügt");
});

document.querySelector("#beverage-settings-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-beverage]");
  if (!button) return;
  if (currentUser) {
    if (!isAdmin) return showToast("Nur für Administratoren");
    const result = await supabaseClient.rpc("deactivate_org_beverage", { p_org: activeOrganizationId, p_beverage: remoteBeverageIds.get(button.dataset.deleteBeverage) });
    if (result.error) return showToast(remoteErrorMessage(result.error));
    await loadRemoteState(); return showToast("Getränk entfernt");
  }
  settings.beverages = settings.beverages.filter((name) => name !== button.dataset.deleteBeverage);
  delete settings.prices[button.dataset.deleteBeverage];
  persistSettings(); render(); showToast("Getränk entfernt");
});

document.querySelector("#beverage-settings-list").addEventListener("change", async (event) => {
  const input = event.target.closest("[data-price-beverage], [data-purchase-price-beverage]");
  if (!input) return;
  const price = parsePrice(input.value);
  const isPurchase = input.hasAttribute("data-purchase-price-beverage");
  const beverageName = input.dataset.priceBeverage || input.dataset.purchasePriceBeverage;
  if (!Number.isFinite(price) || price < 0 || (!isPurchase && price <= 0)) { renderBeverageSettings(); return showToast("Bitte gültigen Preis eingeben"); }
  if (currentUser) {
    if (!isAdmin) return showToast("Nur für Administratoren");
    const result = isPurchase
      ? await supabaseClient.rpc("update_org_beverage_purchase_price", { p_org: activeOrganizationId, p_beverage: remoteBeverageIds.get(beverageName), p_purchase_price: Math.round(price * 100) / 100 })
      : await supabaseClient.rpc("update_org_beverage_price", { p_org: activeOrganizationId, p_beverage: remoteBeverageIds.get(beverageName), p_price: Math.round(price * 100) / 100 });
    if (result.error) return showToast(remoteErrorMessage(result.error));
    await loadRemoteState(); return showToast(isPurchase ? "Einkaufspreis gespeichert" : "Globaler Preis gespeichert");
  }
  if (isPurchase) settings.purchasePrices[beverageName] = Math.round(price * 100) / 100;
  else settings.prices[beverageName] = Math.round(price * 100) / 100;
  persistSettings(); render(); updateCalculatedPrice(); showToast(isPurchase ? "Einkaufspreis gespeichert" : "Preis gespeichert");
});

document.querySelector("#profile-photo").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    pendingProfilePhoto = await resizePhoto(file);
    renderProfile();
  } catch { showToast("Bild konnte nicht verarbeitet werden"); }
});

document.querySelector("#profile-popup-open").addEventListener("click", () => {
  renderProfile();
  document.querySelector("#profile-popover").hidden = false;
});

document.querySelector("#profile-popup-close").addEventListener("click", () => {
  document.querySelector("#profile-popover").hidden = true;
});

document.querySelector("#profile-popover").addEventListener("click", (event) => {
  if (event.target.id === "profile-popover") document.querySelector("#profile-popover").hidden = true;
});

document.querySelector("#profile-edit-button").addEventListener("click", openProfileSettings);

document.querySelector("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#profile-name").value.trim();
  const email = document.querySelector("#profile-email").value.trim();
  const phone = document.querySelector("#profile-phone").value.trim();
  if (!name) return showToast("Bitte Namen eingeben");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showToast("Bitte gültige E-Mail eingeben");
  settings.profileName = name;
  settings.profilePhone = phone;
  if (pendingProfilePhoto) settings.profilePhoto = pendingProfilePhoto;
  pendingProfilePhoto = "";
  persistSettings();
  if (currentUser && navigator.onLine) {
    let result = await supabaseClient.from("profiles").update({ display_name: name, phone }).eq("id", currentUser.id);
    if (result.error?.message?.includes("phone")) {
      result = await supabaseClient.from("profiles").update({ display_name: name }).eq("id", currentUser.id);
      if (!result.error) showToast("Name gespeichert. Für Telefon bitte SQL-Fix ausführen.");
    }
    if (result.error) return showToast(remoteErrorMessage(result.error));
    if (email && email !== currentUser.email) {
      const emailResult = await supabaseClient.auth.updateUser({ email });
      if (emailResult.error) return showToast(remoteErrorMessage(emailResult.error));
      showToast("Profil gespeichert. Neue E-Mail ggf. bestätigen.");
      return render();
    }
  }
  render(); showToast("Profil gespeichert");
});

document.querySelector("#workspace-select").addEventListener("change", async (event) => {
  activeOrganizationId = event.target.value;
  localStorage.setItem("cafe-daniels-active-org", activeOrganizationId);
  remoteBeerStock = null; remoteBalance = null; negativeLimit = 0;
  try { await loadRemoteState(); await syncPendingConsumptions(); showToast("Lokal gewechselt"); }
  catch (error) { showToast(remoteErrorMessage(error)); }
});

document.querySelector("#workspace-list")?.addEventListener("click", async (event) => {
  const switchButton = event.target.closest("[data-switch-workspace]");
  if (switchButton) {
    activeOrganizationId = switchButton.dataset.switchWorkspace;
    localStorage.setItem("cafe-daniels-active-org", activeOrganizationId);
    remoteBeerStock = null; remoteBalance = null; negativeLimit = 0;
    try { await loadRemoteState(); await syncPendingConsumptions(); showToast("Lokal gewechselt"); }
    catch (error) { showToast(remoteErrorMessage(error)); }
    return;
  }
  const deleteButton = event.target.closest("[data-delete-workspace]");
  if (!deleteButton) return;
  await deleteWorkspaceById(deleteButton.dataset.deleteWorkspace);
});

document.querySelector("#workspace-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) return showToast("Bitte zuerst anmelden");
  if (!navigator.onLine) return showToast("Lokal-Erstellung benötigt eine Verbindung");
  const name = document.querySelector("#workspace-name").value.trim();
  if (!name) return showToast("Bitte einen Lokalnamen eingeben");
  const created = await supabaseClient.rpc("create_workspace", { p_name: name });
  if (created.error) { remoteStatusMessage = remoteErrorMessage(created.error); renderStatus(); return showToast(remoteStatusMessage); }
  activeOrganizationId = created.data;
  organizations = [{ organization_id: created.data, group_id: null, role: "admin", organizations: { id: created.data, name } }];
  isAdmin = true;
  localStorage.setItem("cafe-daniels-active-org", activeOrganizationId);
  localStorage.setItem("cafe-daniels-created-org", JSON.stringify({ id: created.data, name, userId: currentUser.id }));
  event.target.reset();
  try { remoteStatusMessage = ""; await loadRemoteState(); render(); showToast("Lokal erstellt – du bist Administrator"); }
  catch (error) { remoteStatusMessage = remoteErrorMessage(error); render(); showToast(remoteStatusMessage); }
});

async function deleteWorkspaceById(orgId) {
  const target = organizations.find((item) => item.organization_id === orgId);
  if (!currentUser || !target || target.role !== "admin") return showToast("Nur für Administratoren");
  const activeName = target?.organizations?.name || "Standort";
  const ok = confirm(`Lokal / Standort „${activeName}“ wirklich lÃ¶schen?\n\nAlle Mitglieder, Gruppen, GetrÃ¤nke, Lager, Guthaben, Verbrauch und Chat dieses Standorts werden gelÃ¶scht.`);
  if (!ok) return;
  const really = confirm("Bitte nochmal bestÃ¤tigen: Dieser Standort kann nicht automatisch wiederhergestellt werden.");
  if (!really) return;
  const result = await supabaseClient.rpc("delete_workspace", { p_org: orgId });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  if (activeOrganizationId === orgId) {
    localStorage.removeItem("cafe-daniels-active-org");
    activeOrganizationId = "";
  }
  try {
    await loadOrganizations(false);
    if (activeOrganizationId) await loadRemoteState();
    else {
      entries = [];
      adminEntries = [];
      organizationGroups = [];
      organizationMembers = [];
      memberGroupLinks = [];
      chatMessages = [];
      isAdmin = false;
    }
  } catch {
    entries = [];
    adminEntries = [];
    organizationGroups = [];
    organizationMembers = [];
    memberGroupLinks = [];
    chatMessages = [];
    isAdmin = false;
  }
  render();
  showToast("Standort gelÃ¶scht");
}

document.querySelector("#reset-values-button")?.addEventListener("click", async () => {
  if (!currentUser || !isAdmin || !activeOrganizationId) return showToast("Nur für Administratoren");
  const active = organizations.find((item) => item.organization_id === activeOrganizationId);
  const ok = confirm(`Alle Werte im Lokal „${active?.organizations?.name || "Aktives Lokal"}“ zurücksetzen?\n\nVerbrauch, Guthaben, Lagerbewegungen und Chat werden gelöscht. Benutzer, Gruppen, Getränke und Preise bleiben erhalten.`);
  if (!ok) return;
  const really = confirm("Bitte nochmal bestätigen: Diese Werte können nicht automatisch wiederhergestellt werden.");
  if (!really) return;
  const result = await supabaseClient.rpc("reset_workspace_values", { p_org: activeOrganizationId });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  entries = [];
  adminEntries = [];
  chatMessages = [];
  remoteBalance = null;
  negativeLimit = 0;
  remoteBeerStock = null;
  remoteStockByBeverage = new Map();
  persistEntries();
  await loadRemoteState();
  showToast("Werte zurückgesetzt");
});

document.querySelector("#group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isAdmin) return showToast("Nur für Administratoren");
  const name = document.querySelector("#new-group-name").value.trim();
  const result = await supabaseClient.rpc("create_org_group", { p_org: activeOrganizationId, p_name: name });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  event.target.reset(); await loadRemoteState(); showToast("Gruppe erstellt");
});

document.querySelector("#member-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isAdmin) return showToast("Nur für Administratoren");
  const email = document.querySelector("#member-create-email").value.trim();
  const groupId = document.querySelector("#member-create-group").value;
  if (!email || !groupId) return showToast("E-Mail und Gruppe angeben");
  const result = await supabaseClient.rpc("add_member_by_email", { p_org: activeOrganizationId, p_email: email, p_group: groupId });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  event.target.reset();
  await loadRemoteState();
  showToast("Mitglied hinzugefügt");
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
  document.querySelector("#mail-invite").href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Einladung zu Cafe Daniel - LA -")}&body=${encodeURIComponent(`Du wurdest eingeladen. Öffne diesen Link:\n\n${link}`)}`;
  showToast("Einladung erstellt");
});

document.querySelector("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) return showToast("Bitte zuerst anmelden");
  if (!activeOrganizationId) return showToast("Kein aktives Lokal");
  const input = document.querySelector("#chat-message");
  const message = input.value.trim();
  const groupId = activeGroupId();
  if (!message) return;
  if (!groupId) return showToast("Keine Gruppe zugeordnet");
  const result = await sendChatMessage(message, "text");
  if (result.error) return showToast(remoteErrorMessage(result.error));
  input.value = "";
  await loadRemoteState();
  setActiveTab("team");
});

async function sendChatMessage(message, type = "text", mediaType = null, mediaData = null) {
  const groupId = activeGroupId();
  const recipient = chatMode === "direct" ? chatRecipientId : null;
  if (chatMode === "direct" && !recipient) return { error: { message: "Bitte Empfänger auswählen" } };
  const result = await supabaseClient.rpc("send_chat_message", { p_org: activeOrganizationId, p_group: groupId, p_recipient: recipient, p_message: message, p_message_type: type, p_media_type: mediaType, p_media_data: mediaData });
  if (result.error && type === "text" && !recipient && !mediaData && ((result.error.message || "").includes("send_chat_message") || (result.error.message || "").includes("schema cache"))) {
    return supabaseClient.rpc("send_group_chat_message", { p_org: activeOrganizationId, p_group: groupId, p_message: message });
  }
  return result;
}

document.querySelector("#chat-mode").addEventListener("change", async (event) => {
  chatMode = event.target.value;
  localStorage.setItem("cafe-daniels-chat-mode", chatMode);
  await loadRemoteState();
  setActiveTab("team");
});

document.querySelector("#chat-recipient").addEventListener("change", async (event) => {
  chatRecipientId = event.target.value;
  localStorage.setItem("cafe-daniels-chat-recipient", chatRecipientId);
  await loadRemoteState();
  setActiveTab("team");
});

document.querySelector("#chat-status-button").addEventListener("click", async () => {
  const text = prompt("Status-Meldung eingeben:");
  if (!text?.trim()) return;
  const result = await sendChatMessage(text.trim(), "status");
  if (result.error) return showToast(remoteErrorMessage(result.error));
  await loadRemoteState();
});

document.querySelector("#chat-media").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 180000) { event.target.value = ""; return showToast("Datei ist zu groß. Bitte kleines Bild/kurzes Video wählen."); }
  const reader = new FileReader();
  reader.onload = async () => {
    const result = await sendChatMessage(file.type.startsWith("video/") ? "Video" : "Bild", "media", file.type, reader.result);
    event.target.value = "";
    if (result.error) return showToast(remoteErrorMessage(result.error));
    await loadRemoteState();
  };
  reader.readAsDataURL(file);
});

document.querySelector("#give-beer-decrease").addEventListener("click", () => {
  const input = document.querySelector("#give-beer-quantity");
  input.value = Math.max(1, (Number.parseInt(input.value, 10) || 1) - 1);
});

document.querySelector("#give-beer-increase").addEventListener("click", () => {
  const input = document.querySelector("#give-beer-quantity");
  input.value = Math.min(99, (Number.parseInt(input.value, 10) || 1) + 1);
});

document.querySelector("#give-beer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) return showToast("Bitte zuerst anmelden");
  if (!navigator.onLine) return showToast("Bier ausgeben benötigt Verbindung");
  const receiver = document.querySelector("#give-beer-user").value;
  const quantity = Number.parseInt(document.querySelector("#give-beer-quantity").value, 10);
  const beerId = remoteBeverageIds.get("Bier");
  const beerPrice = settings.prices.Bier || 0;
  if (!receiver) return showToast("Bitte Benutzer auswählen");
  if (!beerId || !Number.isInteger(quantity) || quantity < 1) return showToast("Bier nicht verfügbar");
  if (quantity * beerPrice > allowedSpendingBalance() + 0.001) return showToast("Guthaben-/Minuslimit reicht nicht aus");
  if (quantity > beerStock()) return showToast("Nicht genügend Bier im Lager");
  const result = await supabaseClient.rpc("give_beer_to_user", { p_client: crypto.randomUUID(), p_org: activeOrganizationId, p_to_user: receiver, p_beverage: beerId, p_quantity: quantity, p_at: `${dateInput.value}T12:00:00.000Z` });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  document.querySelector("#give-beer-quantity").value = 1;
  await loadRemoteState();
  showToast(`${quantity} Bier ausgegeben`);
});

document.querySelector("#copy-invite").addEventListener("click", async () => {
  await navigator.clipboard.writeText(document.querySelector("#invite-link").value);
  showToast("Einladungslink kopiert");
});

document.querySelector("#members-list").addEventListener("change", async (event) => {
  const adminCheckbox = event.target.closest("[data-member-admin]");
  if (adminCheckbox && isAdmin) {
    const member = organizationMembers.find((item) => item.user_id === adminCheckbox.dataset.memberAdmin);
    if (!member) return;
    const ok = confirm(`${member.profile?.display_name || member.user_id} ${adminCheckbox.checked ? "zum Admin machen" : "Admin-Rechte entfernen"}?`);
    if (!ok) { adminCheckbox.checked = !adminCheckbox.checked; return; }
    const result = await supabaseClient.rpc("set_member_admin_role", { p_org: activeOrganizationId, p_user: adminCheckbox.dataset.memberAdmin, p_admin: adminCheckbox.checked });
    if (result.error) { await loadRemoteState(); return showToast(remoteErrorMessage(result.error)); }
    await loadRemoteState(); return showToast("Admin-Rechte gespeichert");
  }
  const checkbox = event.target.closest("[data-member-group-user]");
  if (!checkbox || !isAdmin) return;
  const checked = [...document.querySelectorAll(`[data-member-group-user="${checkbox.dataset.memberGroupUser}"]:checked`)].map((item) => item.value);
  if (!checked.length) { checkbox.checked = true; return showToast("Mindestens eine Gruppe wählen"); }
  const result = await supabaseClient.rpc("set_member_groups", { p_org: activeOrganizationId, p_user: checkbox.dataset.memberGroupUser, p_groups: checked });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  await loadRemoteState(); showToast("Gruppen geändert");
});

document.querySelector("#team-group-select").addEventListener("change", async (event) => {
  selectedGroupId = event.target.value;
  localStorage.setItem("cafe-daniels-active-group", selectedGroupId);
  await loadRemoteState();
  setActiveTab("team");
});

document.querySelectorAll("[data-settings-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    activeSettingsSection = button.dataset.settingsTab;
    localStorage.setItem("cafe-daniels-settings-section", activeSettingsSection);
    renderSettingsSections();
  });
});

document.querySelector("#print-beer-qr")?.addEventListener("click", () => {
  const value = document.querySelector("#beer-qr-value").value;
  const qrCanvas = document.querySelector("#beer-qr canvas");
  const qrImg = document.querySelector("#beer-qr img");
  const qrSrc = qrCanvas?.toDataURL("image/png") || qrImg?.src || "";
  const popup = window.open("", "_blank", "width=420,height=620");
  if (!popup) return showToast("Popup zum Drucken wurde blockiert");
  popup.document.write(`<!doctype html><html><head><title>Bier QR</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}.card{border:2px solid #0b5ea8;border-radius:24px;padding:32px}h1{margin:0 0 8px;color:#0b5ea8}p{margin:0 0 24px;color:#555}img{width:260px;height:260px;image-rendering:pixelated}.code{margin-top:18px;font-size:12px;color:#777}@media print{button{display:none}.card{border:0}}</style></head><body><div class="card"><h1>Cafe Daniel - LA -</h1><p>1 Bier scannen</p>${qrSrc ? `<img src="${qrSrc}" alt="Bier QR">` : `<div>${value}</div>`}<div class="code">${value}</div><button onclick="window.print()">Drucken</button></div><script>window.onload=()=>setTimeout(()=>window.print(),250)<\/script></body></html>`);
  popup.document.close();
});

document.querySelector("#members-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-member]");
  if (!button || !isAdmin) return;
  const member = organizationMembers.find((item) => item.user_id === button.dataset.deleteMember);
  if (!member || !confirm(`${member.profile?.display_name || "Dieses Mitglied"} aus dem Lokal entfernen?`)) return;
  const result = await supabaseClient.rpc("delete_member", { p_org: activeOrganizationId, p_user: button.dataset.deleteMember });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  await loadRemoteState(); showToast("Mitglied entfernt");
});

document.querySelector("#groups-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-group]");
  if (!button || !isAdmin) return;
  const group = organizationGroups.find((item) => item.id === button.dataset.deleteGroup);
  if (!group || !confirm(`Gruppe „${group.name}“ löschen? Mitglieder bleiben im Lokal.`)) return;
  const result = await supabaseClient.rpc("delete_org_group", { p_org: activeOrganizationId, p_group: button.dataset.deleteGroup });
  if (result.error) return showToast(remoteErrorMessage(result.error));
  await loadRemoteState(); showToast("Gruppe gelöscht");
});

document.querySelector("#stats-user-filter").addEventListener("change", (event) => {
  activeStatsUser = event.target.value;
  renderStatistics();
});

document.querySelectorAll("[data-theme-choice]").forEach((button) => button.addEventListener("click", () => {
  settings.theme = button.dataset.themeChoice;
  persistSettings();
  render();
}));

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
  const workspaceName = localStorage.getItem("cafe-daniels-new-workspace") || DEFAULT_WORKSPACE_NAME;
  if (!email || password.length < 6) return document.querySelector("#auth-message").textContent = "E-Mail und mindestens 6 Zeichen Passwort eingeben.";
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
  currentUser = null; currentProfile = null; isAdmin = false; remoteBeerStock = null; remoteBalance = null; negativeLimit = 0;
  document.querySelector("#auth-screen").hidden = false;
});

window.addEventListener("online", async () => { renderStatus(); if (currentUser) { try { await loadRemoteState(); await syncPendingConsumptions(); } catch (error) { showToast(remoteErrorMessage(error)); } } });
window.addEventListener("offline", renderStatus);

if (INVITE_TOKEN) {
  localStorage.setItem("cafe-daniels-invite", INVITE_TOKEN);
  document.querySelector("#auth-copy").textContent = "Du wurdest eingeladen. Erstelle ein Konto oder melde dich an, um der vorgesehenen Gruppe beizutreten.";
}

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js"));
render();
initializeRemote();
