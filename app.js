const API_BASE = "https://api.opendota.com/api";
const LOCAL_HEROES_URL = "./data/local-heroes.json";
const LOCAL_MATCHUPS_URL = "./data/local-matchups.json";
const LOCAL_MANIFEST_URL = "./data/local-manifest.json";
const LOCAL_COUNTER_REASONS_URL = "./data/counter-reasons.json";
const LOCAL_PATCH_FALLBACK = "unknown";
const HERO_IMG_BASE = "https://cdn.cloudflare.steamstatic.com";
const TEAM_ORDER = ["enemy", "ally"];
const TEAM_META = {
  enemy: { label: "Enemy team", accent: "team-panel--enemy", editable: true },
  ally: { label: "Our suggested team", accent: "team-panel--ally", editable: false },
};
const DRAFT_ROLES = [
  { label: "Hard carry", lane: "Safe lane", role: "carry" },
  { label: "Mid lane", lane: "Mid lane", role: "mid" },
  { label: "Off lane", lane: "Off lane", role: "offlane" },
  { label: "Soft support", lane: "Off lane", role: "soft-support" },
  { label: "Hard support", lane: "Safe lane", role: "hard-support" },
];
const ROLE_ORDER = ["Carry", "Support", "Initiator", "Disabler", "Nuker", "Durable", "Escape", "Pusher"];
const SLOT_COUNT = 5;

const state = {
  dataMode: window.localStorage.getItem("draftor-data-mode") || "auto",
  heroes: [],
  heroById: new Map(),
  allySlots: Array.from({ length: SLOT_COUNT }, () => null),
  enemySlots: Array.from({ length: SLOT_COUNT }, () => null),
  activeTeam: "enemy",
  activeSlot: 0,
  recommendations: [],
  suggestedPicks: Array.from({ length: SLOT_COUNT }, () => null),
  search: "",
  loadingHeroes: true,
  loadingDraft: false,
  error: "",
  matchupError: "",
  heroesSource: "opendota",
  matchupSource: "opendota",
  patch: {
    local: LOCAL_PATCH_FALLBACK,
    remote: null,
    state: "checking",
  },
  cache: {
    heroes: null,
    matchupByHeroId: new Map(),
    counterReasonsByEnemy: new Map(),
  },
};

const els = {};
const formatNumber = new Intl.NumberFormat("en-US");
let draftRequestId = 0;

init().catch((error) => {
  console.error(error);
  setStatus("Failed to boot app", "is-error");
  renderRecommendationsError("The app could not initialize. Check the console for details.");
});

async function init() {
  bindElements();
  bindEvents();
  updateDataSourceSwitch();
  renderAll();
  await Promise.all([loadHeroes(), loadPatchStatus(), loadCounterReasons()]);
}

function bindElements() {
  els.search = document.getElementById("hero-search");
  els.suggestions = document.getElementById("hero-suggestions");
  els.draftBoard = document.getElementById("draft-board");
  els.snapshot = document.getElementById("draft-snapshot");
  els.recommendations = document.getElementById("recommendations");
  els.statusPill = document.getElementById("status-pill");
  els.patchStatus = document.getElementById("patch-status");
  els.dataSourceSwitch = document.getElementById("data-source-switch");
}

function bindEvents() {
  els.search.addEventListener("input", (event) => {
    state.search = event.target.value;
    renderHeroSearch();
  });

  els.search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      state.search = "";
      els.search.value = "";
      renderHeroSearch();
      return;
    }

    if (event.key === "Enter") {
      const matches = getVisibleHeroes();
      if (matches.length) {
        selectHero(matches[0].id);
      }
    }
  });

  els.dataSourceSwitch.addEventListener("click", (event) => {
    const button = event.target.closest("[data-data-mode]");
    if (!button || button.dataset.dataMode === state.dataMode) return;
    setDataMode(button.dataset.dataMode);
  });
}

function setDataMode(mode) {
  state.dataMode = ["auto", "opendota", "local"].includes(mode) ? mode : "auto";
  window.localStorage.setItem("draftor-data-mode", state.dataMode);
  state.cache.heroes = null;
  state.cache.matchupByHeroId.clear();
  state.heroes = [];
  state.heroById = new Map();
  state.loadingHeroes = true;
  state.error = "";
  updateDataSourceSwitch();
  loadHeroes().then(() => refreshRecommendations());
}

function updateDataSourceSwitch() {
  if (!els.dataSourceSwitch) return;
  for (const button of els.dataSourceSwitch.querySelectorAll("[data-data-mode]")) {
    const isActive = button.dataset.dataMode === state.dataMode;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

async function loadHeroes() {
  state.loadingHeroes = true;
  setStatus("Loading hero data...");
  renderAll();

  try {
    const localOnly = state.dataMode === "local";
    const heroes = await fetchJSON(localOnly ? LOCAL_HEROES_URL : `${API_BASE}/heroStats`);
    applyHeroes(heroes, localOnly ? "local" : "opendota");
    state.loadingHeroes = false;
    setStatus(`Loaded ${formatNumber.format(state.heroes.length)} heroes`, "is-ready");
    renderAll();
  } catch (error) {
    console.error(error);
    if (state.dataMode === "opendota") {
      state.loadingHeroes = false;
      state.error = "OpenDota hero data is unavailable. Switch to Local or Auto mode.";
      setStatus("OpenDota unavailable", "is-error");
      renderAll();
      return;
    }

    try {
      const localHeroes = await fetchJSON(LOCAL_HEROES_URL);
      applyHeroes(localHeroes, "local");
      state.loadingHeroes = false;
      setStatus(`Loaded ${formatNumber.format(state.heroes.length)} local heroes`, "is-ready");
      renderAll();
    } catch (localError) {
      console.error(localError);
      state.loadingHeroes = false;
      state.error = "Hero data could not be loaded from OpenDota or the local fallback.";
      setStatus("Hero data unavailable", "is-error");
      renderAll();
    }
  }
}

function applyHeroes(payload, source) {
  const heroes = Array.isArray(payload) ? payload : Object.values(payload || {});
  state.heroes = heroes
    .filter((hero) => hero && hero.cm_enabled !== false)
    .map(normalizeHero)
    .sort((a, b) => a.localized_name.localeCompare(b.localized_name));
  state.heroById = new Map(state.heroes.map((hero) => [hero.id, hero]));
  state.cache.heroes = state.heroes;
  state.heroesSource = source;
}

async function loadPatchStatus() {
  try {
    const manifest = await fetchJSON(LOCAL_MANIFEST_URL);
    if (manifest?.patch) state.patch.local = String(manifest.patch);
  } catch (error) {
    console.warn("Local patch manifest could not be loaded", error);
  }

  renderPatchStatus();

  try {
    const patches = await fetchJSON(`${API_BASE}/constants/patch`);
    const latestPatch = getLatestPatch(patches);
    if (!latestPatch) throw new Error("OpenDota returned no patch version");

    state.patch.remote = latestPatch;
    state.patch.state = comparePatches(state.patch.local, latestPatch);
  } catch (error) {
    console.warn("OpenDota patch check unavailable", error);
    state.patch.state = "unverified";
  }

  renderPatchStatus();
}

async function loadCounterReasons() {
  try {
    const payload = await fetchJSON(LOCAL_COUNTER_REASONS_URL);
    const records = Array.isArray(payload?.records) ? payload.records : [];
    state.cache.counterReasonsByEnemy = new Map();
    for (const record of records) {
      const counters = new Map((record.counters || []).map((counter) => [counter.hero, counter]));
      state.cache.counterReasonsByEnemy.set(record.enemyHero, counters);
    }
  } catch (error) {
    console.warn("Local counter explanations could not be loaded", error);
  }
}

function getLatestPatch(patches) {
  if (!Array.isArray(patches)) return "";
  return patches
    .filter((entry) => entry && typeof entry.patch === "string")
    .sort((a, b) => getPatchDate(b.date) - getPatchDate(a.date))[0]?.patch || "";
}

function getPatchDate(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return Date.parse(value || "") || 0;
}

function comparePatches(localPatch, remotePatch) {
  if (!localPatch || localPatch === LOCAL_PATCH_FALLBACK) return "unverified";
  if (localPatch === remotePatch) return "current";
  return comparePatchNumbers(localPatch, remotePatch) < 0 ? "outdated" : "ahead";
}

function comparePatchNumbers(left, right) {
  const parse = (value) => {
    const match = String(value).match(/^(\d+)\.(\d+)([a-z])?$/i);
    return match ? [Number(match[1]), Number(match[2]), (match[3] || "").toLowerCase()] : [0, 0, ""];
  };
  const a = parse(left);
  const b = parse(right);
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2].localeCompare(b[2]);
}

function renderPatchStatus() {
  if (!els.patchStatus) return;

  const { local, remote, state: patchState } = state.patch;
  els.patchStatus.className = `patch-status patch-status--${patchState}`;

  if (patchState === "checking") {
    els.patchStatus.textContent = "Checking patch data...";
    return;
  }

  if (patchState === "current") {
    els.patchStatus.textContent = `Patch ${remote} · local data current`;
    return;
  }

  if (patchState === "outdated") {
    els.patchStatus.textContent = `Patch ${remote} · local data ${local}`;
    return;
  }

  if (patchState === "ahead") {
    els.patchStatus.textContent = `Local patch ${local} · live ${remote}`;
    return;
  }

  els.patchStatus.textContent = local === LOCAL_PATCH_FALLBACK
    ? "Patch version unavailable"
    : `Local patch ${local} · live version unverified`;
}

function normalizeHero(hero) {
  return {
    id: hero.id,
    name: hero.name,
    localized_name: hero.localized_name,
    img: hero.img,
    icon: hero.icon,
    primary_attr: hero.primary_attr,
    attack_type: hero.attack_type,
    roles: Array.isArray(hero.roles) ? hero.roles : [],
    searchTokens: buildSearchTokens(hero),
  };
}

function buildSearchTokens(hero) {
  const tokens = new Set();
  const internal = hero.name || "";
  addVariants(tokens, hero.localized_name || "");
  addVariants(tokens, internal.replace(/^npc_dota_hero_/, "").replaceAll("_", " "));
  addVariants(tokens, internal);
  return [...tokens];
}

function addVariants(set, value) {
  if (!value) return;
  const cleaned = value.toLowerCase();
  set.add(cleaned);
  set.add(cleaned.replace(/[-_]/g, " "));
  set.add(cleaned.replace(/[^a-z0-9]+/g, " ").trim());
}

async function loadMatchups(heroId) {
  if (state.cache.matchupByHeroId.has(heroId)) {
    return state.cache.matchupByHeroId.get(heroId);
  }

  let matchups;
  if (state.dataMode === "local") {
    const localMatchups = await fetchJSON(LOCAL_MATCHUPS_URL);
    matchups = parseLocalMatchups(localMatchups, heroId);
    state.matchupSource = "local";
    state.cache.matchupByHeroId.set(heroId, matchups);
    return matchups;
  }

  try {
    matchups = await fetchJSON(`${API_BASE}/heroes/${heroId}/matchups`);
    if (!Array.isArray(matchups)) throw new Error("OpenDota returned invalid matchup data");
    state.matchupSource = "opendota";
  } catch (error) {
    console.warn(`OpenDota matchups unavailable for hero ${heroId}`, error);
    if (state.dataMode === "opendota") throw error;
    const localMatchups = await fetchJSON(LOCAL_MATCHUPS_URL).catch(() => ({}));
    matchups = parseLocalMatchups(localMatchups, heroId);
    state.matchupSource = "local";
  }

  state.cache.matchupByHeroId.set(heroId, matchups);
  return matchups;
}

function parseLocalMatchups(payload, heroId) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[String(heroId)])) return payload[String(heroId)];

  const allRanks = payload?.ranked_hero_data;
  const allRankData = Array.isArray(allRanks) ? allRanks.find((entry) => entry.rank === 0) : null;
  const source = allRankData?.hero_data?.find((entry) => entry.hero_id === heroId);
  if (!source || !Array.isArray(source.enemy_win_rate)) return [];

  return source.enemy_win_rate
    .map((enemyWinRate, index) => {
      if (!enemyWinRate) return null;
      return {
        hero_id: source.first_other_hero_id + index,
        win_rate: 1 - enemyWinRate / 10000,
        games_played: 0,
        wins: 0,
      };
    })
    .filter(Boolean);
}

function renderAll() {
  renderDraftBoard();
  renderHeroSearch();
  renderSnapshot();
  renderRecommendations();
  renderPatchStatus();
}

function renderDraftBoard() {
  els.draftBoard.innerHTML = "";

  for (const team of TEAM_ORDER) {
    const heroes = getTeamHeroes(team);
    const editable = TEAM_META[team].editable;
    const teamPanel = document.createElement("section");
    teamPanel.className = `team-panel ${TEAM_META[team].accent} ${editable && state.activeTeam === team ? "is-active" : ""}`;
    teamPanel.innerHTML = `
      <div class="team-panel__header">
        <div>
          <p class="team-panel__label">${TEAM_META[team].label}</p>
          <h3>${editable ? `${heroes.length}/5 selected` : `${heroes.length}/5 generated`}</h3>
        </div>
        ${editable ? "" : '<span class="team-panel__generated">Best fit</span>'}
      </div>
      <div class="team-panel__slots"></div>
    `;

    const slotsEl = teamPanel.querySelector(".team-panel__slots");
    const slots = team === "ally" ? state.allySlots : state.enemySlots;

    slots.forEach((heroId, index) => {
      const hero = heroId ? state.heroById.get(heroId) : null;
      const draftRole = DRAFT_ROLES[index];
      const suggestion = team === "ally" ? state.suggestedPicks[index] : null;
      const slotButton = document.createElement("button");
      slotButton.type = "button";
      slotButton.disabled = !editable;
      slotButton.className = `team-slot ${editable && state.activeTeam === team && state.activeSlot === index ? "is-active" : ""} ${!editable ? "team-slot--generated" : ""}`;
      slotButton.innerHTML = hero
        ? `
          <img class="team-slot__icon" src="${heroImage(hero)}" alt="" />
          <div class="team-slot__body">
            <div class="team-slot__name">${escapeHTML(hero.localized_name)}</div>
            <div class="team-slot__role">${index + 1}. ${escapeHTML(draftRole.label)} · ${escapeHTML(draftRole.lane)}</div>
            <div class="team-slot__meta">${escapeHTML(hero.roles.slice(0, 2).join(" • "))}</div>
            ${suggestion ? `<div class="team-slot__reason">${escapeHTML(suggestion.explanation)}</div>` : ""}
            ${suggestion?.alternatives?.length ? `
              <div class="team-slot__alternatives">
                <span class="team-slot__alternatives-label">Alternatives</span>
                <div class="team-slot__alternative-list">
                  ${suggestion.alternatives.map((alternative) => `
                    <span class="team-slot__alternative" title="${escapeHTML(alternative.hero.localized_name)}">
                      <img src="${heroImage(alternative.hero)}" alt="${escapeHTML(alternative.hero.localized_name)}" loading="lazy" />
                    </span>
                  `).join("")}
                </div>
              </div>
            ` : ""}
          </div>
          ${editable ? '<span class="team-slot__clear" title="Clear slot">×</span>' : '<span class="team-slot__generated-mark">AI</span>'}
        `
        : `
          <div class="team-slot__empty">
            <span class="team-slot__index">${index + 1}</span>
            <span><strong>${escapeHTML(draftRole.label)}</strong><small>${escapeHTML(draftRole.lane)}</small></span>
          </div>
        `;

      slotButton.addEventListener("click", (event) => {
        if (!editable) return;
        if (hero && event.target instanceof HTMLElement && event.target.classList.contains("team-slot__clear")) {
          event.stopPropagation();
          clearSlot(team, index);
          return;
        }
        setActiveSlot(team, index);
      });

      slotsEl.appendChild(slotButton);
    });

    els.draftBoard.appendChild(teamPanel);

  }

}

function renderHeroSearch() {
  const matches = getVisibleHeroes();
  els.suggestions.innerHTML = "";

  if (state.loadingHeroes) {
    els.suggestions.innerHTML = `<div class="empty-recs">Loading the hero catalog.</div>`;
    return;
  }

  if (state.error) {
    els.suggestions.innerHTML = `<div class="error-box">${escapeHTML(state.error)}</div>`;
    return;
  }

  if (!matches.length) {
    const query = state.search.trim();
    els.suggestions.innerHTML = `<div class="empty-recs">No heroes match “${escapeHTML(query)}”.</div>`;
    return;
  }

  const groups = [
    ["str", "Strength"],
    ["agi", "Agility"],
    ["int", "Intelligence"],
    ["all", "Universal"],
  ];
  const pool = document.createElement("div");
  pool.className = "hero-pool";

  for (const [attribute, label] of groups) {
    const heroes = matches.filter((hero) => hero.primary_attr === attribute);
    if (!heroes.length) continue;

    const group = document.createElement("section");
    group.className = `hero-group hero-group--${attribute}`;
    group.innerHTML = `<h3 class="hero-group__title">${escapeHTML(label)}</h3><div class="hero-group__grid"></div>`;
    const grid = group.querySelector(".hero-group__grid");

    for (const hero of heroes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hero-grid-card";
      button.title = hero.localized_name;
      button.setAttribute("aria-label", `Select ${hero.localized_name}`);
      button.innerHTML = `<img src="${heroImage(hero)}" alt="" loading="lazy" />`;
      button.addEventListener("click", () => selectHero(hero.id));
      grid.appendChild(button);
    }
    pool.appendChild(group);
  }

  els.suggestions.appendChild(pool);
}

function renderSnapshot() {
  if (state.loadingHeroes) {
    els.snapshot.className = "draft-snapshot empty-state";
    els.snapshot.innerHTML = `
      <div>
        <p class="empty-state__eyebrow">Loading draft data</p>
        <h3>Preparing hero metadata.</h3>
        <p>Hero metadata is being loaded before the enemy draft board becomes interactive.</p>
      </div>
    `;
    return;
  }

  const allyHeroes = getTeamHeroes("ally");
  const enemyHeroes = getTeamHeroes("enemy");

  if (!allyHeroes.length && !enemyHeroes.length) {
    els.snapshot.className = "draft-snapshot empty-state";
    els.snapshot.innerHTML = `
      <div>
        <p class="empty-state__eyebrow">Waiting for the draft</p>
        <h3>Select enemy heroes to generate your five role picks.</h3>
        <p>The assistant balances counter value against the enemy lineup and synergy with your own team.</p>
      </div>
    `;
    return;
  }

  els.snapshot.className = "draft-snapshot";
  els.snapshot.innerHTML = `
    <div class="draft-snapshot__grid">
      ${renderTeamSummary("ally", allyHeroes)}
      ${renderTeamSummary("enemy", enemyHeroes)}
    </div>
    <div class="draft-snapshot__note">
      The right-side lineup is generated in role order. Counters matter, but so does making your own team function.
    </div>
  `;
}

function renderTeamSummary(team, heroes) {
  const heroChips = heroes.length
    ? heroes
        .map(
          (hero) => `
            <div class="summary-chip">
              <img class="summary-chip__icon" src="${heroImage(hero)}" alt="" />
              <div class="summary-chip__body">
                <div class="summary-chip__name">${escapeHTML(hero.localized_name)}</div>
                <div class="summary-chip__meta">${escapeHTML(hero.roles.slice(0, 2).join(" • "))}</div>
              </div>
            </div>
          `,
        )
        .join("")
    : `<div class="summary-empty">No heroes selected.</div>`;

  const tags = buildTeamTags(heroes);

  return `
    <section class="summary-team summary-team--${team}">
      <div class="summary-team__header">
        <div>
          <p class="summary-team__label">${TEAM_META[team].label}</p>
          <h3>${heroes.length}/5</h3>
        </div>
        <div class="summary-team__tags">${tags.map((tag) => `<span class="tag">${escapeHTML(tag)}</span>`).join("")}</div>
      </div>
      <div class="summary-team__list">${heroChips}</div>
    </section>
  `;
}

function renderRecommendations() {
  els.recommendations.innerHTML = "";

  if (state.loadingHeroes) {
    els.recommendations.innerHTML = `<div class="empty-recs">Loading the hero pool.</div>`;
    return;
  }

  if (state.error) {
    els.recommendations.innerHTML = `<div class="error-box">${escapeHTML(state.error)}</div>`;
    return;
  }

  const allyHeroes = getTeamHeroes("ally");
  const enemyHeroes = getTeamHeroes("enemy");

  if (!allyHeroes.length && !enemyHeroes.length) {
    els.recommendations.innerHTML = `<div class="empty-recs">Pick enemy heroes on the left to generate your five role picks.</div>`;
    return;
  }

  if (state.loadingDraft) {
    els.recommendations.innerHTML = `<div class="empty-recs">Scoring the draft board...</div>`;
    return;
  }

  if (state.matchupError) {
    els.recommendations.innerHTML = `<div class="error-box">${escapeHTML(state.matchupError)}</div>`;
    return;
  }

  if (!state.recommendations.length) {
    els.recommendations.innerHTML = `<div class="empty-recs">No recommendations available yet.</div>`;
    return;
  }

  const recommendations = state.recommendations;

  recommendations.slice(0, 12).forEach((item, index) => {
    const row = document.createElement("article");
    row.className = "recommendation";
    const breakdownTags = item.breakdown
      .filter((part) => Math.abs(part.value) >= 0.75)
      .slice(0, 4)
      .map(
        (part) =>
          `<span class="tag">${escapeHTML(part.label)} ${part.value >= 0 ? "+" : ""}${part.value.toFixed(1)}</span>`,
      )
      .join("");

    row.innerHTML = `
      <div class="recommendation__rank">${index + 1}</div>
      <div class="recommendation__hero">
        <h3 class="recommendation__name">${escapeHTML(item.hero.localized_name)}</h3>
        <p class="recommendation__reason">${escapeHTML(item.explanation)}</p>
      </div>
      <div class="recommendation__meta">
        <div class="score">${item.score.toFixed(1)}</div>
        <div class="breakdown">${breakdownTags}</div>
      </div>
    `;
    els.recommendations.appendChild(row);
  });
}

async function selectHero(heroId) {
  const hero = state.heroById.get(heroId);
  if (!hero) return;

  removeHeroFromEnemySlots(heroId);
  assignHeroToActiveSlot(heroId);
  state.search = "";
  els.search.value = "";
  renderDraftBoard();
  await refreshRecommendations();
}

function assignHeroToActiveSlot(heroId) {
  const slots = state.enemySlots;
  slots[state.activeSlot] = heroId;
  state.activeSlot = findNextEmptySlot("enemy", state.activeSlot);
}

function clearSlot(team, index) {
  if (team !== "enemy") return;
  const slots = getSlots(team);
  slots[index] = null;
  state.activeTeam = team;
  state.activeSlot = index;
  renderAll();
  refreshRecommendations();
}

function setActiveSlot(team, index) {
  if (team !== "enemy") return;
  state.activeTeam = team;
  state.activeSlot = index;
  renderDraftBoard();
  els.search.focus();
}

function removeHeroFromEnemySlots(heroId) {
  const enemyIndex = state.enemySlots.findIndex((id) => id === heroId);
  if (enemyIndex !== -1) state.enemySlots[enemyIndex] = null;
}

function getTeamHeroes(team) {
  const slots = getSlots(team);
  return slots.map((heroId) => (heroId ? state.heroById.get(heroId) : null)).filter(Boolean);
}

function getTeamAssignments(team) {
  const slots = getSlots(team);
  return slots
    .map((heroId, index) => {
      const hero = heroId ? state.heroById.get(heroId) : null;
      return hero ? { hero, draftRole: DRAFT_ROLES[index], index } : null;
    })
    .filter(Boolean);
}

function getSlots(team) {
  return team === "ally" ? state.allySlots : state.enemySlots;
}

async function refreshRecommendations() {
  const requestId = ++draftRequestId;
  const enemyHeroes = getTeamHeroes("enemy");

  if (!enemyHeroes.length) {
    state.loadingDraft = false;
    state.allySlots = Array.from({ length: SLOT_COUNT }, () => null);
    state.suggestedPicks = Array.from({ length: SLOT_COUNT }, () => null);
    state.recommendations = [];
    state.matchupError = "";
    setStatus(state.loadingHeroes ? "Loading hero data..." : "Select heroes to begin");
    renderRecommendations();
    return;
  }

  state.loadingDraft = true;
  state.matchupError = "";
  state.allySlots = Array.from({ length: SLOT_COUNT }, () => null);
  state.suggestedPicks = Array.from({ length: SLOT_COUNT }, () => null);
  state.recommendations = [];
  setStatus(`Generating a team against ${enemyHeroes.length} enemy heroes...`);
  renderAll();

  try {
    await ensureEnemyMatchupsLoaded(enemyHeroes);
    if (requestId !== draftRequestId) return;

    const generatedLineup = generateSuggestedLineup(enemyHeroes);
    state.allySlots = generatedLineup.slots;
    state.suggestedPicks = generatedLineup.picks;
    state.recommendations = buildRecommendations(getTeamHeroes("ally"), enemyHeroes);
    state.loadingDraft = false;
    setStatus(`Generated ${state.allySlots.filter(Boolean).length}/5 role picks`, "is-ready");
    renderAll();
  } catch (error) {
    console.error(error);
    if (requestId !== draftRequestId) return;

    state.loadingDraft = false;
    state.matchupError = "The team suggestion could not be generated.";
    setStatus("Suggestions unavailable", "is-error");
    renderAll();
  }
}

async function ensureEnemyMatchupsLoaded(enemyHeroes) {
  await Promise.all(enemyHeroes.map((hero) => loadMatchups(hero.id)));
}

function generateSuggestedLineup(enemyHeroes) {
  const selectedAllies = [];
  const selectedAssignments = [];
  const enemyAssignments = getTeamAssignments("enemy");
  const generatedSlots = Array.from({ length: SLOT_COUNT }, () => null);
  const generatedPicks = Array.from({ length: SLOT_COUNT }, () => null);

  for (const [index, draftRole] of DRAFT_ROLES.entries()) {
    const matchupMaps = buildMatchupMaps(enemyHeroes);
    const candidates = state.heroes
      .filter((hero) => !enemyHeroes.includes(hero) && !selectedAllies.includes(hero))
      .map((hero) => ({
        hero,
        ...scoreCandidate(hero, selectedAllies, enemyHeroes, matchupMaps, draftRole, selectedAssignments, enemyAssignments),
      }))
      .sort((a, b) => b.score - a.score || a.hero.localized_name.localeCompare(b.hero.localized_name));

    const selection = selectRoleCandidate(candidates, draftRole);
    const best = selection.candidate;
    if (best) {
      const roleCandidates = getRoleCandidatePool(candidates, draftRole);
      generatedSlots[index] = best.hero.id;
      generatedPicks[index] = {
        ...best,
        role: draftRole,
        alternatives: roleCandidates.filter((candidate) => candidate.hero.id !== best.hero.id).slice(0, 3),
        explanation: best.explanation,
      };
      selectedAllies.push(best.hero);
      selectedAssignments.push({ hero: best.hero, draftRole });
    }
  }

  const generatedIds = new Set(generatedSlots.filter(Boolean));
  for (const pick of generatedPicks) {
    if (pick) {
      pick.alternatives = pick.alternatives.filter((alternative) => !generatedIds.has(alternative.hero.id));
    }
  }

  return { slots: generatedSlots, picks: generatedPicks };
}

function getRoleCandidatePool(candidates, draftRole) {
  if (!["soft-support", "hard-support"].includes(draftRole.role)) return candidates;
  const supportCandidates = candidates.filter((candidate) => isSupportSlotCandidate(candidate.hero));
  return supportCandidates.length ? supportCandidates : candidates;
}

function selectRoleCandidate(candidates, draftRole) {
  const first = candidates[0];
  if (!first || !["soft-support", "hard-support"].includes(draftRole.role)) {
    return { candidate: first };
  }

  // Support slots are role-gated first; counter strength cannot replace the role.
  const supportCandidates = candidates.filter((candidate) => isSupportSlotCandidate(candidate.hero));
  const bestSupport = supportCandidates[0];
  if (!bestSupport) return { candidate: first };

  return { candidate: bestSupport };
}

function isSupportHero(hero) {
  return hero.roles.includes("Support");
}

function isSupportSlotCandidate(hero) {
  return isSupportHero(hero) && !hero.roles.includes("Carry");
}

function buildRecommendations(allyHeroes, enemyHeroes) {
  const pickedIds = new Set([...allyHeroes, ...enemyHeroes].map((hero) => hero.id));
  const matchupMaps = buildMatchupMaps(enemyHeroes);
  const allyAssignments = state.suggestedPicks
    .filter(Boolean)
    .map((pick) => ({ hero: pick.hero, draftRole: pick.role }));
  const enemyAssignments = getTeamAssignments("enemy");

  return state.heroes
    .filter((hero) => !pickedIds.has(hero.id))
    .map((hero) => ({
      hero,
      ...scoreCandidate(hero, allyHeroes, enemyHeroes, matchupMaps, null, allyAssignments, enemyAssignments),
    }))
    .sort((a, b) => b.score - a.score || a.hero.localized_name.localeCompare(b.hero.localized_name));
}

function buildMatchupMaps(enemyHeroes) {
  return new Map(
    enemyHeroes.map((hero) => [
      hero.id,
      new Map((state.cache.matchupByHeroId.get(hero.id) || []).map((entry) => [entry.hero_id, entry])),
    ]),
  );
}

function scoreCandidate(hero, allyHeroes, enemyHeroes, matchupMaps, draftRole = null, allyAssignments = [], enemyAssignments = []) {
  const enemyContexts = enemyAssignments.length
    ? enemyAssignments
    : enemyHeroes.map((enemyHero, index) => ({ hero: enemyHero, draftRole: DRAFT_ROLES[index] }));
  const enemySignals = enemyContexts.map(({ hero: enemyHero, draftRole: enemyRole }) => {
    const matchup = matchupMaps.get(enemyHero.id)?.get(hero.id) || { hero_id: hero.id, games_played: 0, wins: 0 };
    return {
      ...scoreAgainstEnemy(hero, enemyHero, matchup),
      weight: getEnemyCounterWeight(enemyRole),
    };
  });

  const allySignals = allyHeroes.map((allyHero) => scoreWithAlly(hero, allyHero));
  const counterAverage = weightedAverage(enemySignals, "total");
  const synergyAverage = average(allySignals.map((entry) => entry.total));
  const draftNeed = computeTeamNeed(hero, allyHeroes);
  const draftShape = computeDraftShape(hero, allyHeroes, enemyHeroes);
  const positionFit = draftRole ? computePositionFit(hero, draftRole.role) : 0;
  const laneSynergy = computeLaningSynergy(hero, draftRole, allyAssignments);
  const coverageBonus = enemySignals.length ? weightedAverage(enemySignals.map((entry) => ({ value: entry.total > 0 ? 1 : 0, weight: entry.weight })), "value") * 4 : 0;
  const synergyCoverage = allySignals.length ? (allySignals.filter((entry) => entry.total > 0).length / allySignals.length) * 3 : 0;
  const consistencyBonus = computeConsistencyBonus(enemySignals);
  const finalScore =
    counterAverage * 0.85 +
    synergyAverage * 0.75 +
    draftNeed +
    draftShape +
    positionFit +
    laneSynergy +
    coverageBonus +
    synergyCoverage +
    consistencyBonus;

  const breakdown = [
    { label: "counter", value: round(counterAverage) },
    { label: "synergy", value: round(synergyAverage) },
    { label: "need", value: round(draftNeed) },
    { label: "shape", value: round(draftShape) },
    { label: "position", value: round(positionFit) },
    { label: "lane synergy", value: round(laneSynergy) },
    { label: "coverage", value: round(coverageBonus) },
    { label: "sync", value: round(synergyCoverage) },
    { label: "consistency", value: round(consistencyBonus) },
  ];

  return {
    score: round(finalScore),
    counterWinRate: weightedWinRate(enemySignals),
    breakdown,
    explanation: buildExplanation(hero, allyHeroes, enemyHeroes, enemySignals, allySignals, breakdown, draftRole, laneSynergy, allyAssignments),
  };
}

function heroSlug(hero) {
  const slug = String(hero?.localized_name || hero?.name || "")
    .replace(/^npc_dota_hero_/, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return {
    outworld_devourer: "outworld_destroyer",
    centaur_warrunner: "centaur_bloodrunner",
  }[slug] || slug;
}

function getCounterReason(hero, enemyHeroes, enemySignals = []) {
  const candidateSlug = heroSlug(hero);
  const orderedEnemies = enemyHeroes
    .map((enemy, index) => ({ enemy, signal: enemySignals[index] }))
    .sort((a, b) => (b.signal?.total || 0) - (a.signal?.total || 0))
    .map(({ enemy }) => enemy);

  for (const enemy of orderedEnemies) {
    const counter = state.cache.counterReasonsByEnemy.get(heroSlug(enemy))?.get(candidateSlug);
    if (counter?.reasons?.length) {
      return {
        enemy,
        text: counter.reasons.join(" "),
        exact: true,
      };
    }
  }

  return null;
}

function weightedWinRate(signals) {
  const totalGames = signals.reduce((sum, signal) => sum + signal.games, 0);
  if (!totalGames) return weightedAverage(signals, "winRate");
  return signals.reduce((sum, signal) => sum + signal.wins * signal.weight, 0) /
    signals.reduce((sum, signal) => sum + signal.games * signal.weight, 0);
}

function weightedAverage(entries, valueKey) {
  const totalWeight = entries.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
  if (!totalWeight) return 0;
  return entries.reduce((sum, entry) => sum + entry[valueKey] * (entry.weight ?? 1), 0) / totalWeight;
}

function getEnemyCounterWeight(draftRole) {
  if (!draftRole) return 0.5;
  return {
    carry: 1,
    mid: 0.9,
    offlane: 0.8,
    "soft-support": 0.35,
    "hard-support": 0.25,
  }[draftRole.role] || 0.5;
}

function computeLaningSynergy(hero, draftRole, allyAssignments) {
  if (!draftRole) return 0;

  const lanePartners = allyAssignments.filter(({ draftRole: allyRole }) => {
    return (draftRole.role === "hard-support" && allyRole.role === "carry") ||
      (draftRole.role === "soft-support" && allyRole.role === "offlane") ||
      (draftRole.role === "carry" && allyRole.role === "hard-support") ||
      (draftRole.role === "offlane" && allyRole.role === "soft-support");
  });

  if (!lanePartners.length) return 0;
  return lanePartners.reduce((score, { hero: allyHero }) => score + lanePairQuality(hero, allyHero, draftRole.role), 0);
}

function lanePairQuality(hero, allyHero, role) {
  let score = 8;
  const heroRoles = new Set(hero.roles);
  const allyRoles = new Set(allyHero.roles);

  if (role === "hard-support") {
    if (heroRoles.has("Support")) score += 3;
    if (heroRoles.has("Disabler") || heroRoles.has("Nuker")) score += 2;
    if (allyRoles.has("Carry")) score += 1;
  }

  if (role === "soft-support") {
    if (heroRoles.has("Support")) score += 2;
    if (heroRoles.has("Initiator") || heroRoles.has("Disabler")) score += 3;
    if (allyRoles.has("Initiator") || allyRoles.has("Durable")) score += 1;
  }

  return score;
}

function scoreAgainstEnemy(hero, enemyHero, matchup) {
  const games = matchup?.games_played ?? 0;
  const wins = matchup?.wins ?? 0;
  const winRate = games > 0 ? wins / games : Number.isFinite(matchup?.win_rate) ? matchup.win_rate : 0.5;
  const matchupStrength = (winRate - 0.5) * 120;
  const confidence = clamp(Math.log10(games + 1) / Math.log10(101), 0, 1);
  const confidenceAdjustment = (confidence - 0.5) * 12;
  const uncertaintyPenalty = games === 0 ? 7 : Math.max(0, 12 - Math.sqrt(games)) * 0.7;
  const roleFit = computeEnemyRoleFit(hero, enemyHero);
  const laneFit = computeLaneFit(hero, enemyHero);
  const tempoFit = computeTempoFit(hero);
  const archetypeBonus = computeArchetypeBonus(hero, enemyHero);
  const total =
    matchupStrength +
    roleFit +
    laneFit +
    tempoFit +
    archetypeBonus +
    confidenceAdjustment -
    uncertaintyPenalty;

  return {
    games,
    wins,
    winRate,
    matchupStrength,
    roleFit,
    laneFit,
    tempoFit,
    archetypeBonus,
    confidenceAdjustment,
    uncertaintyPenalty,
    total,
  };
}

function scoreWithAlly(hero, allyHero) {
  const heroRoles = new Set(hero.roles);
  const allyRoles = new Set(allyHero.roles);
  let roleFit = 0;

  if (allyRoles.has("Carry")) {
    if (heroRoles.has("Disabler")) roleFit += 6.5;
    if (heroRoles.has("Initiator")) roleFit += 5;
    if (heroRoles.has("Nuker")) roleFit += 3.5;
  }

  if (allyRoles.has("Support")) {
    if (heroRoles.has("Carry")) roleFit += 3.5;
    if (heroRoles.has("Nuker")) roleFit += 2.5;
    if (heroRoles.has("Pusher")) roleFit += 2;
  }

  if (allyRoles.has("Initiator")) {
    if (heroRoles.has("Nuker")) roleFit += 4;
    if (heroRoles.has("Disabler")) roleFit += 4;
    if (heroRoles.has("Carry")) roleFit += 1.5;
  }

  if (allyRoles.has("Disabler")) {
    if (heroRoles.has("Nuker")) roleFit += 4;
    if (heroRoles.has("Carry")) roleFit += 2.5;
  }

  if (allyRoles.has("Durable")) {
    if (heroRoles.has("Nuker")) roleFit += 3;
    if (heroRoles.has("Support")) roleFit += 2;
  }

  if (allyHero.attack_type === "Melee" && hero.attack_type === "Ranged") {
    roleFit += 2;
  }

  if (allyHero.attack_type === "Ranged" && hero.attack_type === "Melee") {
    roleFit += hero.roles.includes("Initiator") || hero.roles.includes("Durable") ? 2.2 : 0.8;
  }

  const tempoFit = computeTempoFit(hero) * 0.3;
  return {
    roleFit,
    tempoFit,
    total: roleFit + tempoFit,
  };
}

function computeEnemyRoleFit(hero, enemyHero) {
  const heroRoles = new Set(hero.roles);
  const enemyRoles = new Set(enemyHero.roles);
  let score = 0;

  if (enemyRoles.has("Carry")) {
    if (heroRoles.has("Disabler")) score += 6.5;
    if (heroRoles.has("Initiator")) score += 5;
    if (heroRoles.has("Nuker")) score += 3.5;
  }

  if (enemyRoles.has("Escape")) {
    if (heroRoles.has("Disabler")) score += 7;
    if (heroRoles.has("Initiator")) score += 4.5;
  }

  if (enemyRoles.has("Durable")) {
    if (heroRoles.has("Nuker")) score += 5;
    if (heroRoles.has("Disabler")) score += 3;
  }

  if (enemyRoles.has("Support")) {
    if (heroRoles.has("Carry")) score += 3.5;
    if (heroRoles.has("Nuker")) score += 3;
  }

  if (enemyRoles.has("Pusher")) {
    if (heroRoles.has("Nuker")) score += 4.5;
    if (heroRoles.has("Initiator")) score += 3.5;
  }

  if (enemyRoles.has("Initiator")) {
    if (heroRoles.has("Escape")) score += 3;
    if (heroRoles.has("Disabler")) score += 3.5;
  }

  return score;
}

function computeLaneFit(hero, enemyHero) {
  let score = 0;
  if (enemyHero.attack_type === "Melee" && hero.attack_type === "Ranged") score += 5.5;
  if (enemyHero.attack_type === "Ranged" && hero.attack_type === "Melee") {
    score += hero.roles.includes("Initiator") || hero.roles.includes("Durable") ? 3.5 : 1.5;
  }
  if (enemyHero.primary_attr === "agi" && hero.roles.includes("Disabler")) score += 2.5;
  if (enemyHero.primary_attr === "int" && hero.roles.includes("Durable")) score += 2;
  if (enemyHero.primary_attr === "str" && hero.roles.includes("Nuker")) score += 2;
  return score;
}

function computeTempoFit(hero) {
  let score = 0;
  if (hero.roles.includes("Initiator")) score += 3.5;
  if (hero.roles.includes("Nuker")) score += 2.5;
  if (hero.roles.includes("Escape")) score += 1.5;
  if (hero.roles.includes("Pusher")) score += 1.5;
  if (hero.move_speed >= 320) score += 1.5;
  if (hero.attack_point != null && hero.attack_point <= 0.4) score += 1;
  return score;
}

function computeArchetypeBonus(hero, enemyHero) {
  let score = 0;
  const heroText = `${hero.localized_name} ${hero.name}`.toLowerCase();
  const enemyText = `${enemyHero.localized_name} ${enemyHero.name}`.toLowerCase();
  const illusionHunters = ["sven", "leshrac", "sand king", "earthshaker", "jakiro", "disruptor", "luna", "medusa"];
  const silenceTargets = ["storm spirit", "anti-mage", "queen of pain", "puck", "ember spirit", "void spirit"];
  const passiveTargets = ["bristleback", "underlord", "spectre", "morphling", "phantom assassin"];

  if (enemyHero.roles.includes("Carry") && hero.roles.includes("Disabler")) score += 1.5;
  if (illusionHunters.some((name) => heroText.includes(name)) && enemyHero.roles.includes("Pusher")) score += 2;
  if (silenceTargets.some((name) => enemyText.includes(name)) && hero.roles.includes("Disabler")) score += 1.5;
  if (passiveTargets.some((name) => enemyText.includes(name)) && hero.roles.includes("Nuker")) score += 1.5;

  return score;
}

function computePositionFit(hero, position) {
  const roles = new Set(hero.roles);
  let score = 0;

  if (position === "carry") {
    if (roles.has("Carry")) score += 15;
    if (roles.has("Escape")) score += 2;
    if (roles.has("Pusher")) score += 1.5;
  }

  if (position === "mid") {
    if (roles.has("Nuker")) score += 8;
    if (roles.has("Carry")) score += 5;
    if (roles.has("Escape")) score += 4;
    if (hero.attack_type === "Ranged") score += 2;
  }

  if (position === "offlane") {
    if (roles.has("Initiator")) score += 7;
    if (roles.has("Durable")) score += 7;
    if (roles.has("Disabler")) score += 5;
    if (roles.has("Escape")) score += 2;
  }

  if (position === "soft-support") {
    if (roles.has("Support")) score += 8;
    if (roles.has("Initiator")) score += 6;
    if (roles.has("Disabler")) score += 5;
    if (roles.has("Nuker")) score += 3;
  }

  if (position === "hard-support") {
    if (roles.has("Support")) score += 11;
    if (roles.has("Disabler")) score += 5;
    if (roles.has("Nuker")) score += 3;
    if (roles.has("Durable")) score += 1.5;
  }

  return score;
}

function computeTeamNeed(hero, allyHeroes) {
  if (!allyHeroes.length) return 0;

  const roleCounts = new Map();
  for (const allyHero of allyHeroes) {
    for (const role of allyHero.roles) {
      roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    }
  }

  let score = 0;
  if ((roleCounts.get("Carry") || 0) === 0 && hero.roles.includes("Carry")) score += 4.5;
  if ((roleCounts.get("Initiator") || 0) === 0 && hero.roles.includes("Initiator")) score += 4.5;
  if ((roleCounts.get("Disabler") || 0) === 0 && hero.roles.includes("Disabler")) score += 4.5;
  if ((roleCounts.get("Nuker") || 0) === 0 && hero.roles.includes("Nuker")) score += 3.5;
  if ((roleCounts.get("Durable") || 0) === 0 && hero.roles.includes("Durable")) score += 3;
  if ((roleCounts.get("Support") || 0) === 0 && hero.roles.includes("Support")) score += 2.5;

  return score;
}

function computeDraftShape(hero, allyHeroes, enemyHeroes) {
  let score = 0;
  const allyMelee = allyHeroes.filter((ally) => ally.attack_type === "Melee").length;
  const allyRanged = allyHeroes.filter((ally) => ally.attack_type === "Ranged").length;
  const enemyMelee = enemyHeroes.filter((enemy) => enemy.attack_type === "Melee").length;
  const enemyRanged = enemyHeroes.filter((enemy) => enemy.attack_type === "Ranged").length;

  if (allyMelee >= 3 && hero.attack_type === "Ranged") score += 2.5;
  if (allyRanged >= 3 && hero.attack_type === "Melee") score += hero.roles.includes("Initiator") ? 2.2 : 1;
  if (enemyMelee >= 3 && hero.attack_type === "Ranged") score += 2.5;
  if (enemyRanged >= 3 && hero.attack_type === "Melee") score += hero.roles.includes("Durable") ? 2 : 1;

  return score;
}

function computeConsistencyBonus(enemySignals) {
  if (enemySignals.length < 2) return 0;
  const totals = enemySignals.map((entry) => entry.total).sort((a, b) => b - a);
  const averageTotal = average(totals);
  const topTwo = average(totals.slice(0, 2));
  return Math.max(0, topTwo - averageTotal) * 0.45;
}

function buildExplanation(
  hero,
  allyHeroes,
  enemyHeroes,
  enemySignals,
  allySignals,
  breakdown,
  draftRole = null,
  laneSynergy = 0,
  allyAssignments = [],
) {
  const parts = [];
  const bestEnemy = enemySignals
    .map((entry, index) => ({ ...entry, enemyHero: enemyHeroes[index] }))
    .sort((a, b) => b.total - a.total)[0];
  const bestAlly = allySignals
    .map((entry, index) => ({ ...entry, allyHero: allyHeroes[index] }))
    .sort((a, b) => b.total - a.total)[0];
  const missingRoles = getMissingRoles(allyHeroes);
  const counterReason = getCounterReason(hero, enemyHeroes, enemySignals);

  if (counterReason) {
    parts.push(counterReason.text);
  }

  if (bestEnemy?.enemyHero) {
    parts.push(`${hero.localized_name} is strong into ${bestEnemy.enemyHero.localized_name}.`);
  }

  if (bestAlly?.allyHero && bestAlly.total > 0) {
    parts.push(`It also works well with ${bestAlly.allyHero.localized_name}.`);
  }

  if (draftRole) {
    parts.push(`Fits the ${draftRole.label} slot.`);
  }

  if (laneSynergy > 0) {
    const lanePartner = allyAssignments.find(({ draftRole: allyRole }) =>
      (draftRole?.role === "hard-support" && allyRole.role === "carry") ||
      (draftRole?.role === "soft-support" && allyRole.role === "offlane") ||
      (draftRole?.role === "carry" && allyRole.role === "hard-support") ||
      (draftRole?.role === "offlane" && allyRole.role === "soft-support"),
    );
    if (lanePartner) parts.push(`Laning synergy with ${lanePartner.hero.localized_name}.`);
  }

  if (missingRoles.length && hero.roles.some((role) => missingRoles.includes(role))) {
    parts.push(`It fills a missing ${missingRoles[0].toLowerCase()} role on your side.`);
  }

  const positive = breakdown
    .filter((part) => part.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);
  if (positive.length) {
    parts.push(`Main edges: ${positive.map((part) => part.label).join(", ")}.`);
  }

  return parts.join(" ");
}

function buildTeamTags(heroes) {
  const roleCounts = new Map();
  let melee = 0;
  let ranged = 0;

  for (const hero of heroes) {
    if (hero.attack_type === "Melee") melee += 1;
    if (hero.attack_type === "Ranged") ranged += 1;
    for (const role of hero.roles) {
      roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    }
  }

  const tags = [`${heroes.length}/5`];
  if (melee >= 3) tags.push(`${melee} melee`);
  if (ranged >= 3) tags.push(`${ranged} ranged`);
  for (const role of ROLE_ORDER) {
    const count = roleCounts.get(role) || 0;
    if (count >= 2) tags.push(`${count} ${role.toLowerCase()}s`);
  }
  return tags.slice(0, 4);
}

function getMissingRoles(allyHeroes) {
  const roleCounts = new Map();
  for (const hero of allyHeroes) {
    for (const role of hero.roles) {
      roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    }
  }
  return ROLE_ORDER.filter((role) => (roleCounts.get(role) || 0) === 0);
}

function getVisibleHeroes() {
  const query = state.search.trim().toLowerCase();
  const visible = query
    ? state.heroes.filter((hero) =>
        hero.searchTokens.some((token) => token.includes(query)) ||
        hero.localized_name.toLowerCase().includes(query) ||
        hero.name.toLowerCase().includes(query),
      )
    : state.heroes;
  return visible;
}

function findNextEmptySlot(team, startIndex) {
  const slots = getSlots(team);
  if (!slots[startIndex]) return startIndex;
  for (let offset = 1; offset <= SLOT_COUNT; offset += 1) {
    const index = (startIndex + offset) % SLOT_COUNT;
    if (!slots[index]) return index;
  }
  return startIndex;
}

function renderRecommendationsError(message) {
  els.recommendations.innerHTML = `<div class="error-box">${escapeHTML(message)}</div>`;
}

function setStatus(text, extraClass = "") {
  els.statusPill.className = extraClass ? `status-pill ${extraClass}` : "status-pill";
  els.statusPill.textContent = text;
}

async function fetchJSON(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function heroImage(hero) {
  const source = hero.img || hero.icon || "";
  return `${HERO_IMG_BASE}${source.replace(/\?$/, "")}`;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
