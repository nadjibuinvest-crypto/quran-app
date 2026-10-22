// ---------- Constants & State ----------
// Every person on this phone gets their own set of keys, so progress never mixes.
const PROFILES_KEY = 'qa_profiles';       // [{ id, name, pinHash }]
const ACTIVE_KEY = 'qa_active_profile';   // id of the person using the app now
const PROFILE_FIELDS = ['current', 'surahs', 'reciter', 'monthly_goal', 'loop', 'language', 'study', 'listen', 'plan', 'speed'];
let activeProfileId = null;
function profileKey(field) { return `qa_p${activeProfileId}_${field}`; }
const LS = {
  get study() { return profileKey('study'); },       // which ayahs this person has learned
  get reciter() { return profileKey('reciter'); },
  get loop() { return profileKey('loop'); },
  get language() { return profileKey('language'); }, // en, sw or fr
  get listen() { return profileKey('listen'); },     // last surah played in All Surahs
  get plan() { return profileKey('plan'); },         // where Study starts and in what order
  get speed() { return profileKey('speed'); }        // listening speed in All Surahs
};
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LIMIT = 2;       // new ayahs each day
const REQUIRED_PLAYS = 10;   // plays needed for each ayah
const $ = (id) => document.getElementById(id);

let surahListCache = null;
let surahInfoCache = null;

// ---------- Utilities ----------
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage is full or off */ }
}
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayStr() {
  return formatLocalDate(new Date());
}
function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / DAY_MS);
}
function msUntilMidnight() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
}
function fmtCountdown(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
// 'Meccan' and 'Medinan' are hard words, so say where the surah came down instead.
function placeName(type) {
  return type === 'Medinan' ? 'From Madinah' : 'From Makkah';
}
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------- What this person has learned ----------
// study.ayahs["108:1"] = { plays: 4, ok: true, done: "2026-10-20" }
//   plays = times the ayah was played all the way through
//   ok    = the question about the ayah was answered right
//   done  = the day the person finished the ayah (it stays open until then, no matter how many days)
function studyData() {
  const d = loadJSON(LS.study, null);
  return d && d.ayahs && typeof d.ayahs === 'object' ? d : { ayahs: {} };
}
function getAyahState(s, a) {
  const x = studyData().ayahs[`${s}:${a}`] || {};
  return { plays: x.plays || 0, ok: !!x.ok, done: x.done || null };
}
function setAyahState(s, a, patch) {
  const d = studyData();
  const k = `${s}:${a}`;
  d.ayahs[k] = Object.assign({}, d.ayahs[k] || {}, patch);
  saveJSON(LS.study, d);
}
function doneTodayCount() {
  const t = todayStr();
  return Object.values(studyData().ayahs).filter(x => x.done === t).length;
}

// ---------- People ----------
let pendingProfile = null;

function getProfiles() { return loadJSON(PROFILES_KEY, []); }
function saveProfiles(list) { saveJSON(PROFILES_KEY, list); }
function activeProfile() { return getProfiles().find(p => p.id === activeProfileId) || null; }
function newProfileId() { return Math.random().toString(36).slice(2, 8); }

async function hashPin(pin) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('lpquran:' + pin));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return 'plain:' + pin;
  }
}

// Progress saved before people existed becomes the first person, named "Me".
function adoptLegacyData() {
  if (getProfiles().length) return;
  const legacy = { qa_current: 'current', qa_surahs: 'surahs', qa_reciter: 'reciter', qa_monthly_goal: 'monthly_goal', qa_loop: 'loop' };
  const hasLegacy = Object.keys(legacy).some(k => localStorage.getItem(k) !== null) ||
    localStorage.getItem('qa_plan') !== null || localStorage.getItem('qa_completed') !== null;
  if (!hasLegacy) return;
  const id = newProfileId();
  saveProfiles([{ id, name: 'Me', pinHash: null }]);
  Object.entries(legacy).forEach(([oldKey, field]) => {
    const v = localStorage.getItem(oldKey);
    if (v !== null) { localStorage.setItem(`qa_p${id}_${field}`, v); localStorage.removeItem(oldKey); }
  });
  localStorage.setItem(ACTIVE_KEY, id);
}

function stopAllAudio() {
  const audio = $('audio-player');
  audio.pause();
  audio.removeAttribute('src');
  delete audio.dataset.surah;
  const ayah = $('ayah-audio');
  ayah.pause();
  ayah.removeAttribute('src');
  delete ayah.dataset.key;
  listenSurah = null;
}

function startApp(id) {
  activeProfileId = id;
  localStorage.setItem(ACTIVE_KEY, id);
  try { sessionStorage.setItem('qa_unlocked', id); } catch (e) { /* private mode */ }
  $('profile-screen').hidden = true;
  const person = activeProfile();
  $('person-name').textContent = person ? person.name : '';
  $('settings-person-name').textContent = person ? person.name : '';
  stopAllAudio();
  $('reciter-select').value = localStorage.getItem(LS.reciter) || 'Mishary Alafasy';
  syncLanguageSelects();
  renderSpeedButtons();
  renderAyahOfTheDay();
  surahSearchQuery = '';
  $('surah-search').value = '';
  showBrowse();
  switchTab('learn');
  renderSurahGrid();
  renderOfflineTextStatus();
  renderOfflineSummary();
  setTimeout(prepareOffline, 800);
}

function showProfileScreen() {
  $('audio-player').pause();
  const profiles = getProfiles();
  $('profile-screen').hidden = false;
  $('profile-pin-form').hidden = true;
  $('profile-add-error').textContent = '';
  $('btn-show-add').hidden = !profiles.length;
  $('profile-add-form').hidden = profiles.length > 0;
  $('btn-profile-close').hidden = !activeProfile();
  $('profile-title').textContent = profiles.length ? 'Who is learning?' : 'Welcome! What is your name?';
  renderProfileList();
}

function renderProfileList() {
  const box = $('profile-list');
  box.innerHTML = '';
  getProfiles().forEach(person => {
    const btn = el('button', 'profile-btn');
    btn.type = 'button';
    btn.append(el('span', 'profile-avatar', (person.name.trim().charAt(0) || '?').toUpperCase()));
    btn.append(el('span', 'profile-name', person.name));
    if (person.pinHash) btn.append(el('span', 'profile-lock', '🔒'));
    btn.addEventListener('click', () => chooseProfile(person));
    box.append(btn);
  });
}

function chooseProfile(person) {
  if (!person.pinHash) { startApp(person.id); return; }
  pendingProfile = person;
  $('pin-for').textContent = `Type the PIN for ${person.name}`;
  $('pin-input').value = '';
  $('pin-error').textContent = '';
  $('profile-pin-form').hidden = false;
  $('pin-input').focus();
}

async function submitPin() {
  if (!pendingProfile) return;
  const hash = await hashPin($('pin-input').value.trim());
  if (hash === pendingProfile.pinHash) startApp(pendingProfile.id);
  else $('pin-error').textContent = 'That PIN is not right. Try again.';
}

async function saveNewPerson() {
  const name = $('profile-name-input').value.trim();
  const pin = $('profile-pin-input').value.trim();
  const err = $('profile-add-error');
  if (!name) { err.textContent = 'Please type a name.'; return; }
  if (pin && !/^\d{4}$/.test(pin)) { err.textContent = 'A PIN is 4 numbers. Or leave it empty.'; return; }
  const list = getProfiles();
  if (list.some(x => x.name.toLowerCase() === name.toLowerCase())) { err.textContent = 'That name is already used.'; return; }
  const person = { id: newProfileId(), name: name.slice(0, 20), pinHash: pin ? await hashPin(pin) : null };
  saveProfiles(list.concat(person));
  $('profile-name-input').value = '';
  $('profile-pin-input').value = '';
  startApp(person.id);
}

function deleteCurrentPerson() {
  const person = activeProfile();
  if (!person) return;
  if (!confirm(`Delete ${person.name} and all of their notes, wins and practice time? You cannot undo this.`)) return;
  PROFILE_FIELDS.forEach(f => localStorage.removeItem(`qa_p${person.id}_${f}`));
  saveProfiles(getProfiles().filter(x => x.id !== person.id));
  localStorage.removeItem(ACTIVE_KEY);
  try { sessionStorage.removeItem('qa_unlocked'); } catch (e) { /* ignore */ }
  activeProfileId = null;
  stopAllAudio();
  showProfileScreen();
}

function initPeople() {
  $('btn-switch-person').addEventListener('click', showProfileScreen);
  $('btn-settings-switch').addEventListener('click', showProfileScreen);
  $('btn-delete-person').addEventListener('click', deleteCurrentPerson);
  $('btn-profile-close').addEventListener('click', () => { $('profile-screen').hidden = true; });
  $('btn-show-add').addEventListener('click', () => {
    $('profile-add-form').hidden = false;
    $('btn-show-add').hidden = true;
    $('profile-pin-form').hidden = true;
    $('profile-name-input').focus();
  });
  $('btn-profile-save').addEventListener('click', saveNewPerson);
  $('btn-pin-ok').addEventListener('click', submitPin);
  $('btn-pin-cancel').addEventListener('click', () => { $('profile-pin-form').hidden = true; pendingProfile = null; });
  $('pin-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });
  $('profile-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNewPerson(); });
}


// ---------- Tabs ----------
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (tab === 'learn') renderStudy();
  if (tab === 'wins') renderWins();
  if (tab === 'surahs' && !listenSurah) renderSurahGrid();
  if (tab !== 'learn') { clearInterval(lockTimer); lockTimer = null; }
  window.scrollTo(0, 0);
}

// The Arabic data source puts the Bismillah in front of ayah 1 of most surahs.
// It is not part of that verse, so remove it to match the translation below it.
function stripBismillah(text, surahNumber, ayahNumber) {
  if (ayahNumber !== 1 || surahNumber === 1 || surahNumber === 9) return text;
  const words = text.replace(/^\uFEFF/, '').split(' ');
  if (words.length > 4 && words[0].startsWith('\u0628\u0650\u0633\u0652\u0645\u0650')) {
    return words.slice(4).join(' ');
  }
  return text;
}


// ---------- Data ----------
// Everything that is loaded is also kept on the phone, so a surah you have
// opened before still works with no internet.
const DATA_CACHE = 'quran-data';
const AUDIO_CACHE = 'quran-audio';
const LANGUAGES = {
  en: { label: 'English (simple)', edition: 'en.itani' },
  sw: { label: 'Kiswahili (Swahili)', edition: 'sw.barwani' },
  fr: { label: 'Français (French)', edition: 'fr.hamidullah' }
};
function currentLanguage() {
  const l = localStorage.getItem(LS.language);
  return LANGUAGES[l] ? l : 'en';
}
function syncLanguageSelects() {
  const l = currentLanguage();
  $('language-select').value = l;
  $('listen-language-select').value = l;
}
function setLanguage(l) {
  localStorage.setItem(LS.language, l);
  syncLanguageSelects();
  renderAyahOfTheDay();
  if (listenSurah) renderListenVerses(listenSurah);
  if ($('tab-learn').classList.contains('active')) renderStudy();
}

async function fetchJSONCached(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    try { const c = await caches.open(DATA_CACHE); await c.put(url, res.clone()); } catch (e) { /* storage is off */ }
    return await res.json();
  } catch (err) {
    try {
      const hit = await caches.match(url);
      if (hit) return await hit.json();
    } catch (e) { /* ignore */ }
    throw err;
  }
}

const SURAHS_URL = 'data/surahs.json?v=1';
const INFO_URL = 'data/surah-info.json?v=2';
const QURAN_URL = (n) => `data/quran/${n}.json?v=1`;
const NOTES_URL = (n) => `data/ayah-simple/${n}.json?v=3`;
const NOTES_INDEX_URL = 'data/notes-index.json?v=1';
const STUDY_ORDER_URL = 'data/study-order.json?v=1';
const MEANINGS_INDEX_URL = 'data/meanings-index.json?v=1';
const MEANINGS_URL = (n) => `data/meanings/${n}.json?v=1`;
// Old books, only for lessons that have no prepared notes yet. Shown in the books' own words.
const BOOKS = [
  { slug: 'en-al-jalalayn', name: 'Tafsir al-Jalalayn' },
  { slug: 'en-tafsir-ibn-abbas', name: 'Tanwir al-Miqbas (from Ibn Abbas)' }
];
const BOOK_URL = (slug, n) => `https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/${slug}/${n}.json`;

async function getSurahList() {
  if (surahListCache) return surahListCache;
  surahListCache = await fetchJSONCached(SURAHS_URL); // array of 114, in order
  return surahListCache;
}

// The Quran words live inside the app (one small file per surah, in 5 versions),
// so they work with no internet at all.
const quranFiles = new Map();
async function getQuranFile(n) {
  if (!quranFiles.has(n)) quranFiles.set(n, await fetchJSONCached(QURAN_URL(n)));
  return quranFiles.get(n);
}
async function getSurahText(n) {
  const q = await getQuranFile(n);
  const wrap = (arr) => ({ ayahs: arr.map((text, i) => ({ numberInSurah: i + 1, text })) });
  return { arabic: wrap(q.ar), translation: wrap(q[currentLanguage()] || q.en), transliteration: wrap(q.tl) };
}

// Plain-English summary for all 114 surahs.
async function getSurahInfo(n) {
  if (!surahInfoCache) surahInfoCache = await fetchJSONCached(INFO_URL);
  return surahInfoCache.find(i => i.n === n) || null;
}

// Simple explanation for each verse. Not every surah has one yet.
async function getSimpleAyahs(n) {
  try {
    return await fetchJSONCached(NOTES_URL(n));
  } catch (e) {
    return null;
  }
}

// What the Prophet ﷺ and the scholars said about each ayah, in simple words.
// Only the lessons that were prepared have this (see data/meanings-index.json).
let meaningsIndexCache = null;
async function getMeanings(n) {
  try {
    if (!meaningsIndexCache) meaningsIndexCache = await fetchJSONCached(MEANINGS_INDEX_URL);
    if (!meaningsIndexCache.includes(n)) return null;
    return (await fetchJSONCached(MEANINGS_URL(n))).ayahs;
  } catch (e) {
    return null;
  }
}

// Live text from the old books (for lessons with no prepared notes). It is in the books' own, harder words.
async function getBookText(slug, n, a) {
  const data = await fetchJSONCached(BOOK_URL(slug, n));
  const row = (data.ayahs || []).find(x => x.ayah === a);
  return row ? (row.text || '').trim() : '';
}

let studyOrderCache = null;
async function getStudyOrder() {
  if (studyOrderCache) return studyOrderCache;
  try {
    studyOrderCache = await fetchJSONCached(STUDY_ORDER_URL);
  } catch (e) {
    studyOrderCache = Array.from({ length: 114 }, (_, i) => 114 - i);
  }
  return studyOrderCache;
}

// ---------- Audio (also saved for no internet) ----------
const AUDIO_BASE = 'https://download.quranicaudio.com/quran/mishaari_raashid_al_3afaasee/';
function audioUrl(n) { return AUDIO_BASE + String(n).padStart(3, '0') + '.mp3'; }
function backupAudioUrl(n) { return `https://cdn.islamic.network/quran/audio-surah/128/ar.alafasy/${n}.mp3`; }
// One ayah on its own (a few seconds, so it is easy to save for no internet).
function ayahId(s, a) { return String(s).padStart(3, '0') + String(a).padStart(3, '0'); }
function ayahAudioUrl(s, a) { return `https://everyayah.com/data/Alafasy_128kbps/${ayahId(s, a)}.mp3`; }
function backupAyahAudioUrl(s, a) { return `https://verses.quran.com/Alafasy/mp3/${ayahId(s, a)}.mp3`; }

async function cacheAyahAudio(s, a) {
  if (!navigator.onLine || !('caches' in window)) return;
  try {
    const c = await caches.open(AUDIO_CACHE);
    const url = ayahAudioUrl(s, a);
    if (await c.match(url)) return;
    const res = await fetch(url);
    if (res.ok) await c.put(url, res);
  } catch (e) { /* it will play from the internet instead */ }
}
// Save the next few lessons' audio while there is internet, so they work on a plane.
async function prefetchAhead(count) {
  if (!navigator.onLine) return;
  try {
    const next = await nextAyahs(count);
    for (const x of next) await cacheAyahAudio(x.s, x.a);
  } catch (e) { /* ignore */ }
}

let audioObjectUrl = null;
let ayahObjectUrl = null;
let autoplayNext = false;
let listenSurah = null;

// Shows the surah name and next/back buttons on the phone's lock screen.
function updateMediaSession(n) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  try {
    const meta = surahListCache && surahListCache[n - 1];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta ? `${n}. ${meta.englishName}` : `Surah ${n}`,
      artist: 'Mishary Alafasy',
      album: 'LP Quran'
    });
    navigator.mediaSession.setActionHandler('nexttrack', n < 114 ? () => showListen(n + 1, true) : null);
    navigator.mediaSession.setActionHandler('previoustrack', n > 1 ? () => showListen(n - 1, true) : null);
  } catch (e) { /* not supported */ }
}

async function setSurahAudio(n) {
  const audio = $('audio-player');
  audio.pause();
  audio.dataset.surah = String(n);
  audio.dataset.failedOver = '';
  if (audioObjectUrl) { URL.revokeObjectURL(audioObjectUrl); audioObjectUrl = null; }
  let src = audioUrl(n);
  try {
    const c = await caches.open(AUDIO_CACHE);
    const hit = await c.match(audioUrl(n));
    if (hit) { audioObjectUrl = URL.createObjectURL(await hit.blob()); src = audioObjectUrl; }
  } catch (e) { /* play from the internet */ }
  if (audio.dataset.surah !== String(n)) return;
  audio.src = src;
  resetPlayerUI();
  updateMediaSession(n);
  if (autoplayNext) {
    autoplayNext = false;
    $('ayah-audio').pause();
    audio.play().catch(() => {});
  }
}

async function isSavedOffline(n) {
  try {
    const c = await caches.open(AUDIO_CACHE);
    return !!(await c.match(audioUrl(n)));
  } catch (e) {
    return false;
  }
}

async function renderOfflineState(n) {
  const saved = await isSavedOffline(n);
  if (listenSurah !== n) return;
  $('btn-offline').hidden = saved;
  $('btn-offline-remove').hidden = !saved;
  $('offline-status').textContent = saved
    ? '✓ Saved on this phone. It works with no internet.'
    : 'Save this surah on your phone to listen with no internet.';
}

async function downloadSurahAudio(n, onProgress) {
  const res = await fetch(audioUrl(n));
  if (!res.ok || !res.body) throw new Error('audio');
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress) onProgress(got, total);
  }
  const blob = new Blob(chunks, { type: 'audio/mpeg' });
  const ac = await caches.open(AUDIO_CACHE);
  await ac.put(audioUrl(n), new Response(blob, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(blob.size) } }));
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
}

function saveErrorText(e) {
  return e && e.name === 'QuotaExceededError'
    ? 'There is not enough space on this phone.'
    : 'Could not save. Check your internet and try again.';
}

async function saveSurahOffline(n) {
  const status = $('offline-status');
  const btn = $('btn-offline');
  btn.disabled = true;
  try {
    let mb = null;
    try {
      const head = await fetch(audioUrl(n), { method: 'HEAD' });
      const len = parseInt(head.headers.get('content-length') || '0', 10);
      if (len) mb = Math.max(1, Math.round(len / 1048576));
    } catch (e) { /* size is only a hint */ }
    if (mb && !confirm(`This surah is about ${mb} MB. It is best to save it on Wi-Fi. Save it now?`)) {
      btn.disabled = false;
      return;
    }
    status.textContent = 'Saving the audio…';
    await downloadSurahAudio(n, (got, total) => {
      status.textContent = total
        ? `Saving the audio… ${Math.round((got / total) * 100)}%`
        : `Saving the audio… ${Math.round(got / 1048576)} MB`;
    });
  } catch (e) {
    status.textContent = saveErrorText(e);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  await renderOfflineState(n);
  renderOfflineSummary();
}

// The 38 short surahs (Al-Fatiha and 78–114) are about 67 MB in all.
const SHORT_SURAHS = [1, ...Array.from({ length: 37 }, (_, i) => 78 + i)];

async function saveShortSurahsOffline() {
  const status = $('offline-bulk-status');
  const btn = $('btn-save-short');
  if (!confirm('This saves 38 short surahs (about 67 MB) so you can listen with no internet. It is best on Wi-Fi. Save them now?')) return;
  btn.disabled = true;
  let done = 0;
  try {
    for (const n of SHORT_SURAHS) {
      if (!(await isSavedOffline(n))) {
        status.textContent = `Saving surah ${n}… (${done} of ${SHORT_SURAHS.length} done)`;
        await downloadSurahAudio(n);
      }
      done++;
    }
    status.textContent = `✓ All ${SHORT_SURAHS.length} short surahs are saved on this phone.`;
  } catch (e) {
    status.textContent = `${saveErrorText(e)} (${done} of ${SHORT_SURAHS.length} saved)`;
  }
  btn.disabled = false;
  renderOfflineSummary();
  if (listenSurah) renderOfflineState(listenSurah);
}

async function renderOfflineSummary() {
  const box = $('offline-audio-summary');
  try {
    const ac = await caches.open(AUDIO_CACHE);
    const keys = await ac.keys();
    const surahKeys = keys.filter(k => k.url.startsWith(AUDIO_BASE));
    const ayahCount = keys.length - surahKeys.length;
    let bytes = 0;
    for (const k of surahKeys) {
      const r = await ac.match(k);
      const len = parseInt((r && r.headers.get('content-length')) || '0', 10);
      bytes += len || (r ? (await r.blob()).size : 0);
    }
    const parts = [];
    if (surahKeys.length) parts.push(`${surahKeys.length} ${surahKeys.length === 1 ? 'surah' : 'surahs'} (${Math.round(bytes / 1048576)} MB)`);
    if (ayahCount) parts.push(`${ayahCount} single ${ayahCount === 1 ? 'ayah' : 'ayahs'} for Study`);
    box.textContent = parts.length ? `Saved for listening: ${parts.join(' and ')}.` : 'No audio is saved on this phone yet.';
    $('btn-clear-audio').hidden = !keys.length;
  } catch (e) {
    box.textContent = '';
  }
}

async function clearSavedAudio() {
  if (!confirm('Delete all the saved audio from this phone? You can save it again later.')) return;
  try { await caches.delete(AUDIO_CACHE); } catch (e) { /* ignore */ }
  renderOfflineSummary();
  if (listenSurah) renderOfflineState(listenSurah);
}

// ---------- Get the whole app ready for no internet ----------
// The first time the app is opened with internet, all 114 surahs (words in every
// language, the notes and the lesson meanings) are saved on the phone in the background.
const TEXT_FLAG = 'qa_text_saved_v2';   // for this phone, not for one person
let preparingOffline = false;
let toastTimer = null;

function showToast(text, ms) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function renderOfflineTextStatus() {
  const box = $('offline-text-status');
  const appSaved = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  const textSaved = localStorage.getItem(TEXT_FLAG) === 'done';
  if (appSaved && textSaved) {
    box.textContent = '✓ Ready. The app, all 114 surahs and your lessons are saved on this phone. They work with no internet, even on a plane.';
  } else if (!navigator.onLine) {
    box.textContent = 'You have no internet right now. Open the app once with internet and it will get ready.';
  } else if (!appSaved) {
    box.textContent = 'Almost ready. Close the app and open it once more.';
  } else {
    box.textContent = 'Getting ready for no internet…';
  }
}

async function prepareOffline() {
  if (!('caches' in window)) return;
  // Study audio is small. Keep the next few lessons saved every time the app opens.
  prefetchAhead(10).then(renderOfflineSummary);
  if (preparingOffline) return;
  if (localStorage.getItem(TEXT_FLAG) === 'done') { renderOfflineTextStatus(); return; }
  if (!navigator.onLine) { renderOfflineTextStatus(); return; }
  preparingOffline = true;
  try {
    let notes = [];
    let meanings = [];
    try { notes = await fetchJSONCached(NOTES_INDEX_URL); } catch (e) { /* no notes list */ }
    try { meanings = await fetchJSONCached(MEANINGS_INDEX_URL); } catch (e) { /* no meanings list */ }
    const urls = [SURAHS_URL, INFO_URL, STUDY_ORDER_URL];
    for (let n = 1; n <= 114; n++) urls.push(QURAN_URL(n));
    notes.forEach(n => urls.push(NOTES_URL(n)));
    meanings.forEach(n => urls.push(MEANINGS_URL(n)));
    const cache = await caches.open(DATA_CACHE);
    const queue = urls.slice();
    let done = 0;
    let failed = 0;
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        try {
          if (!(await cache.match(u))) {
            const r = await fetch(u);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            await cache.put(u, r);
          }
        } catch (e) { failed++; }
        done++;
        if (done % 8 === 0 || done === urls.length) showToast(`Getting the app ready for no internet… ${Math.round((done / urls.length) * 100)}%`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (!failed) {
      localStorage.setItem(TEXT_FLAG, 'done');
      showToast('✓ Ready for no internet. All 114 surahs are saved on this phone.', 6000);
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
    } else {
      showToast('Could not finish getting ready. Open the app again with internet.', 6000);
    }
  } finally {
    preparingOffline = false;
    renderOfflineTextStatus();
  }
}

async function removeOffline(n) {
  try {
    const c = await caches.open(AUDIO_CACHE);
    await c.delete(audioUrl(n));
  } catch (e) { /* ignore */ }
  await renderOfflineState(n);
  renderOfflineSummary();
}


// ---------- Verse of the Day ----------
// Each entry points to a real verse (loaded live so the Arabic is exact), then adds
// what it means in simple words and one small thing to try today.
const DAILY_AYAHS = [
  { ref: '94:5', story: 'Allah told the Prophet this when life was very hard for him.', meaning: 'Hard times do not last forever. Easy times come after them.', apply: 'Think of one hard thing in your life. Say: Allah, please make it easy. Then do one small thing to help today.', youtube: 'Surah Ash-Sharh Al-Inshirah explanation story' },
  { ref: '2:286', meaning: 'Allah knows how strong you are. He never gives you more than you can carry.', apply: 'When something feels too hard, say: Allah knows I can do this. Then take one small step.', youtube: 'Surah Al-Baqarah 286 explanation' },
  { ref: '13:28', meaning: 'When you remember Allah, your heart feels calm and safe.', apply: 'When you feel worried, say SubhanAllah ten times. Then notice how your heart feels.', youtube: 'Surah Ar-Rad 28 explanation' },
  { ref: '39:53', meaning: 'Never give up hope. Whatever mistake you made, Allah can forgive you. Just come back to Him and say sorry.', apply: 'Is there something you feel bad about? Say sorry to Allah today. Promise to do better.', youtube: 'Surah Az-Zumar 53 explanation' },
  { ref: '65:3', meaning: 'If you trust Allah, He is enough for you. He will take care of you.', apply: 'Pick one thing you worry about. Do your best. Then say: Hasbunallah. Allah is enough for me.', youtube: 'Surah At-Talaq 3 explanation' },
  { ref: '21:87', story: 'Prophet Yunus was inside a big fish, in the dark sea. He said this dua. Allah heard him and saved him.', meaning: 'Even in the darkest place, Allah hears you.', apply: 'When you make a mistake, say this dua: La ilaha illa anta, subhanaka, inni kuntu minaz-zalimin.', youtube: 'story of Prophet Yunus and the whale Quran' },
  { ref: '12:87', story: 'Prophet Yusuf was lost for many years. His father Yaqub was very sad, but he did not give up hope in Allah.', meaning: 'Never lose hope in Allah. He can fix things in ways you do not expect.', apply: 'Is there something you gave up on? Ask Allah for it again today.', youtube: 'story of Prophet Yusuf Quran explained' },
  { ref: '20:25', story: 'Prophet Musa had to go and talk to a mean king named Pharaoh. He was scared, so he made this dua.', meaning: 'Ask Allah to make your heart calm before a hard job.', apply: 'Before a test, or before you speak in front of people, say: Rabbi ishrah li sadri, wa yassir li amri.', youtube: 'story of Prophet Musa and Pharaoh Quran' },
  { ref: '18:10', story: 'Some young men ran to a cave to keep their faith safe. They made this dua.', meaning: 'Ask Allah for His kindness and for the right way.', apply: 'Before you sleep tonight, say this dua and ask Allah to make your way easy.', youtube: 'story of the People of the Cave Ashab al Kahf Quran' },
  { ref: '9:40', story: 'The Prophet and his friend Abu Bakr hid in a cave. Abu Bakr was scared. The Prophet told him not to be sad, because Allah was with them.', meaning: 'Allah is with you when you are scared or alone.', apply: 'When you feel scared, say: La tahzan, innallaha ma-ana. Do not be sad. Allah is with us.', youtube: 'story of the cave Hijra Prophet Muhammad Abu Bakr' },
  { ref: '3:139', meaning: 'Do not feel weak or sad. If you keep your faith strong, you will be on top.', apply: 'When something goes wrong today, take a deep breath and say: I will not give up.', youtube: 'Surah Al Imran 139 explanation' },
  { ref: '94:1', meaning: 'Allah reminds the Prophet how He made his heart calm and took away his heavy worries. He can do this for you too.', apply: 'Think of three times Allah made things easy for you. Say Alhamdulillah for each one.', youtube: 'Surah Ash-Sharh Al-Inshirah explanation' },
  { ref: '2:216', meaning: 'You might not like something, but it may be good for you. Allah knows more than you do.', apply: 'Think of something that happened that you did not like. Can you find one good thing in it?', youtube: 'Surah Al-Baqarah 216 explanation' },
  { ref: '55:13', meaning: 'Allah asks: Which of My gifts can you say no to? We can never count all His gifts, like air, water, food and family.', apply: 'Name five gifts you have right now. Say Alhamdulillah for each one.', youtube: 'Surah Ar-Rahman explained favors' },
  { ref: '16:97', meaning: 'Any boy or girl, man or woman, who believes and does good things, Allah will give a good and happy life.', apply: 'Do one good thing in secret today, only for Allah.', youtube: 'Surah An-Nahl 97 explanation' },
  { ref: '3:26', meaning: 'Allah is the King of everything. He gives and He takes. Everything is in His hand.', apply: 'When you want something, ask Allah first. Make a dua.', youtube: 'Surah Al Imran 26 explanation' },
  { ref: '17:23', meaning: 'Allah tells us to be very kind to our mom and dad. Even when they are old, never be rude to them.', apply: 'Say something kind to your mom or dad today, or make dua for them.', youtube: 'Surah Al-Isra 23 kindness to parents' },
  { ref: '49:13', meaning: 'Allah made us into different groups so we can get to know each other. The best person is the one who obeys Allah the most.', apply: 'Say salaam and smile at someone new or different from you today.', youtube: 'Surah Al-Hujurat 13 explanation' },
  { ref: '2:153', meaning: 'When things are hard, ask Allah for help with patience and prayer. Allah is with people who are patient.', apply: 'When you feel upset today, wait, breathe slowly, and pray two rakat.', youtube: 'Surah Al-Baqarah 153 patience and prayer' },
  { ref: '24:35', meaning: 'Light helps us see. Allah is the Light of the sky and the earth. His Quran shows us the right way.', apply: 'Read or listen to one verse today. Ask yourself: What does Allah want me to do?', youtube: 'Ayat an Nur verse of light explained' }
];

async function getAyahText(ref) {
  const [surahNo, ayahNo] = ref.split(':').map(Number);
  const [q, list] = await Promise.all([getQuranFile(surahNo), getSurahList()]);
  const meta = list[surahNo - 1];
  return {
    arabic: { text: q.ar[ayahNo - 1], numberInSurah: ayahNo, surah: { number: surahNo, name: meta.name, englishName: meta.englishName } },
    translation: { text: (q[currentLanguage()] || q.en)[ayahNo - 1] }
  };
}

async function renderAyahOfTheDay() {
  const idx = dayOfYear(new Date()) % DAILY_AYAHS.length;
  const entry = DAILY_AYAHS[idx];
  // The simple words and the thing to try do not need the internet, so show them right away.
  $('quote-meaning').textContent = entry.meaning;
  $('quote-apply').textContent = entry.apply;
  $('quote-story').textContent = entry.story || '';
  $('quote-story').hidden = !entry.story;
  const ytLink = $('quote-youtube-link');
  ytLink.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(entry.youtube)}`;
  ytLink.hidden = false;
  try {
    const { arabic, translation } = await getAyahText(entry.ref);
    $('quote-arabic').textContent = stripBismillah(arabic.text, arabic.surah.number, arabic.numberInSurah);
    $('quote-translation').textContent = translation.text;
    $('quote-reference').textContent = `From Surah ${arabic.surah.englishName}, verse ${arabic.numberInSurah}`;
  } catch (e) {
    $('quote-arabic').textContent = '';
    $('quote-translation').textContent = 'Could not load the verse. Check your internet.';
    $('quote-reference').textContent = '';
  }
}


// ---------- Study Tab ----------
// 2 new ayahs a day. The next ayah only opens after the one before it is finished:
// played 10 times, the question answered, and "I understand" tapped.
// Time does not open anything by itself. If it takes 3 days, it takes 3 days.
let studyToken = 0;
let studyDay = '';
let lockTimer = null;
const cardRefresh = new Map();   // "108:1" -> function that redraws that card's play count
const notesCache = new Map();

async function simpleNotes(n) {
  if (!notesCache.has(n)) notesCache.set(n, await getSimpleAyahs(n));
  return notesCache.get(n);
}

// Where Study starts and in what order. Each person picks their own.
//   order: 'short' = shortest surahs first, 'quran' = 1 to 114, 'back' = 114 to 1
//   start: a surah number to begin with (then the order goes on from there), or null
const STUDY_ORDERS = {
  short: 'Shortest surahs first',
  quran: 'In Quran order (1 to 114)',
  back: 'From the end (114 to 1)'
};
function studyPlan() {
  const p = loadJSON(LS.plan, null) || {};
  return {
    start: p.start >= 1 && p.start <= 114 ? p.start : null,
    order: STUDY_ORDERS[p.order] ? p.order : 'short'
  };
}
async function getSequence() {
  const plan = studyPlan();
  let seq;
  if (plan.order === 'quran') seq = Array.from({ length: 114 }, (_, i) => i + 1);
  else if (plan.order === 'back') seq = Array.from({ length: 114 }, (_, i) => 114 - i);
  else seq = (await getStudyOrder()).slice();
  const i = plan.start ? seq.indexOf(plan.start) : -1;
  return i > 0 ? seq.slice(i).concat(seq.slice(0, i)) : seq;
}

// The next ayahs that are not finished yet, in order. Finished ayahs are skipped,
// so an ayah left half-done stays waiting for you in the list.
async function nextAyahs(count) {
  const [order, list] = await Promise.all([getSequence(), getSurahList()]);
  const learned = studyData().ayahs;
  const out = [];
  for (const s of order) {
    const total = list[s - 1].numberOfAyahs;
    for (let a = 1; a <= total; a++) {
      const st = learned[`${s}:${a}`];
      if (!(st && st.done)) {
        out.push({ s, a });
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

function seededShuffle(arr, seed) {
  const a = arr.slice();
  let x = (Math.abs(seed) % 2147483646) + 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 16807) % 2147483647;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The question: "What is this ayah about?" One right answer and two from other ayahs.
const QUIZ_POOL = [108, 103, 112, 106, 110, 114, 105, 111, 113, 107, 109, 102, 101, 100, 99, 97, 94, 93, 92, 91];
async function blurbList(t, kind) {
  if (kind === 'note') return (await simpleNotes(t)) || [];
  const q = await getQuranFile(t);
  return q[currentLanguage()] || q.en;
}
async function buildQuiz(s, a) {
  const notes = await simpleNotes(s);
  const kind = notes && notes[a - 1] ? 'note' : 'words';
  const right = (await blurbList(s, kind))[a - 1];
  const cands = [];
  for (const t of [s].concat(QUIZ_POOL.filter(x => x !== s))) {
    const arr = await blurbList(t, kind);
    arr.forEach((text, i) => {
      if (t === s && i === a - 1) return;
      if (text && text !== right && !cands.includes(text)) cands.push(text);
    });
    if (cands.length >= 6) break;
  }
  const wrong = seededShuffle(cands, s * 1000 + a).slice(0, 2);
  const options = seededShuffle([right].concat(wrong), s * 31 + a * 7 + 3);
  return { options, answer: options.indexOf(right), kind };
}

function ytLink(label, query) {
  const a = el('a', 'btn ghost', label);
  a.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function fillList(parent, items) {
  const ul = el('ul', 'meaning-list');
  items.forEach(t => ul.append(el('li', '', t)));
  parent.append(ul);
}

// The meanings: simple words, what the Prophet ﷺ said, what scholars wrote.
async function buildMeaning(s, a, meta) {
  const box = el('div', 'ayah-meaning');
  box.append(el('h4', '', 'What this ayah means'));
  const notes = await simpleNotes(s);
  if (notes && notes[a - 1]) {
    const simple = el('div', 'verse-simple');
    simple.append(el('b', '', 'In simple words: '), document.createTextNode(notes[a - 1]));
    box.append(simple);
  }
  const meanings = await getMeanings(s);
  const m = meanings && meanings[a - 1];
  if (m) {
    const p = el('div', 'meaning-block');
    p.append(el('h5', '', 'What the Prophet ﷺ said'));
    if (m.prophet && m.prophet.length) fillList(p, m.prophet);
    else p.append(el('p', 'muted tiny', 'The books we used do not tell a hadith about this ayah.'));
    box.append(p);
    const sc = el('div', 'meaning-block');
    sc.append(el('h5', '', 'What the scholars wrote'));
    if (m.scholars && m.scholars.length) fillList(sc, m.scholars);
    else sc.append(el('p', 'muted tiny', 'Nothing more was written about this one.'));
    box.append(sc);
    box.append(el('p', 'muted tiny', 'These notes tell what the old books say, in simple words. Each note names its book. A teacher can tell you more.'));
  } else {
    if (!(notes && notes[a - 1])) box.append(el('p', 'muted', 'Simple words for this ayah are not ready yet. Read the Quran words above, then open the book notes below.'));
    const det = el('details', 'book-notes');
    det.append(el('summary', '', 'Book notes (in the books\' own, harder words)'));
    const inner = el('div', 'book-inner');
    det.append(inner);
    let loaded = false;
    det.addEventListener('toggle', async () => {
      if (!det.open || loaded) return;
      loaded = true;
      inner.textContent = 'Loading…';
      const parts = [];
      for (const b of BOOKS) {
        try {
          const t = await getBookText(b.slug, s, a);
          if (t) parts.push({ name: b.name, text: t });
        } catch (e) { /* offline */ }
      }
      inner.textContent = '';
      if (!parts.length) {
        loaded = false;
        inner.append(el('p', 'muted', 'The book notes need internet the first time. Try again when you are online.'));
        return;
      }
      parts.forEach(x => {
        const p = el('p', 'book-text');
        p.append(el('b', '', x.name + ': '), document.createTextNode(x.text));
        inner.append(p);
      });
    });
    box.append(det);
  }
  return box;
}

async function buildAyahCard(s, a, mode) {
  const [q, list] = await Promise.all([getQuranFile(s), getSurahList()]);
  const meta = list[s - 1];
  const key = `${s}:${a}`;
  const isDone = mode === 'done';
  const card = el('div', 'card ayah-card' + (isDone ? ' ayah-done' : ''));

  const head = el('div', 'ayah-head');
  head.append(el('span', 'verse-num', `Surah ${meta.englishName} · Ayah ${a} of ${meta.numberOfAyahs}`));
  if (isDone) head.append(el('span', 'chip chip-done', '✓ Learned'));
  card.append(head);
  card.append(el('div', 'verse-arabic', stripBismillah(q.ar[a - 1], s, a)));
  card.append(el('div', 'verse-translit', q.tl[a - 1]));
  card.append(el('div', 'verse-translation', (q[currentLanguage()] || q.en)[a - 1]));

  // Play only this ayah, and count the plays.
  const playRow = el('div', 'ayah-play-row');
  const playBtn = el('button', 'btn primary ayah-play-btn', '▶ Play this ayah');
  playBtn.type = 'button';
  playBtn.dataset.key = key;
  playBtn.addEventListener('click', () => playAyah(s, a));
  const count = el('div', 'ayah-count');
  playRow.append(playBtn, count);
  card.append(playRow);
  const track = el('div', 'progress-track');
  const fill = el('div', 'progress-fill');
  track.append(fill);
  card.append(track);

  let finishBtn = null;
  let finishHint = null;
  const refresh = () => {
    const st = getAyahState(s, a);
    const n = Math.min(st.plays, REQUIRED_PLAYS);
    count.textContent = isDone
      ? `Played ${st.plays} ${st.plays === 1 ? 'time' : 'times'}`
      : (st.plays >= REQUIRED_PLAYS ? `✓ Played ${st.plays} times` : `Played ${st.plays} of ${REQUIRED_PLAYS} times`);
    fill.style.width = `${(n / REQUIRED_PLAYS) * 100}%`;
    if (finishBtn) {
      const ready = st.plays >= REQUIRED_PLAYS && st.ok;
      finishBtn.disabled = !ready;
      const todo = [];
      if (st.plays < REQUIRED_PLAYS) todo.push(`play it ${REQUIRED_PLAYS - st.plays} more ${REQUIRED_PLAYS - st.plays === 1 ? 'time' : 'times'}`);
      if (!st.ok) todo.push('answer the question');
      finishHint.textContent = ready ? 'You did it all. Tap the button.' : `To open the next ayah: ${todo.join(' and ')}.`;
    }
  };
  cardRefresh.set(key, refresh);

  if (isDone) {
    refresh();
    syncPlayButtons();
    return card;
  }

  card.append(await buildMeaning(s, a, meta));

  const links = el('div', 'audio-buttons');
  links.append(
    ytLink('▶ Watch about this ayah', `Surah ${meta.englishName} ayah ${a} meaning and story`),
    ytLink('▶ Story of this surah', `Surah ${meta.englishName} story explained for kids`)
  );
  card.append(links);

  // The question
  const quizBox = el('div', 'quiz');
  quizBox.append(el('h4', '', 'Question: what is this ayah about?'));
  const quiz = await buildQuiz(s, a);
  const msg = el('p', 'quiz-msg');
  const opts = quiz.options.map((text, i) => {
    const b = el('button', 'quiz-opt', text);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (i === quiz.answer) {
        setAyahState(s, a, { ok: true });
        showSolved();
        refresh();
      } else {
        b.classList.add('wrong');
        b.disabled = true;
        msg.textContent = 'Not quite. Read what the ayah means, then try again.';
      }
    });
    return b;
  });
  function showSolved() {
    opts.forEach((b, i) => { b.disabled = true; b.classList.toggle('right', i === quiz.answer); b.classList.remove('wrong'); });
    msg.textContent = '✓ Yes, that is right!';
  }
  opts.forEach(b => quizBox.append(b));
  quizBox.append(msg);
  card.append(quizBox);
  if (getAyahState(s, a).ok) showSolved();

  // Finish
  const fin = el('div', 'finish-box');
  finishBtn = el('button', 'btn primary finish-btn', '✓ I understand this ayah');
  finishBtn.type = 'button';
  finishHint = el('p', 'muted tiny');
  finishBtn.addEventListener('click', () => finishAyah(s, a, meta));
  fin.append(finishBtn, finishHint);
  card.append(fin);

  refresh();
  syncPlayButtons();
  return card;
}

function finishAyah(s, a, meta) {
  const st = getAyahState(s, a);
  if (st.plays < REQUIRED_PLAYS || !st.ok) return;
  setAyahState(s, a, { done: todayStr(), at: Date.now() });
  $('ayah-audio').pause();
  const total = meta.numberOfAyahs;
  let all = true;
  for (let i = 1; i <= total; i++) if (!getAyahState(s, i).done) { all = false; break; }
  showToast(all ? `🎉 You learned all of Surah ${meta.englishName}!` : '✓ Ayah learned!', 4000);
  renderStudy();
  window.scrollTo(0, 0);
}

function lockedCard(s, a, meta) {
  const card = el('div', 'card ayah-locked');
  card.append(el('div', 'lock-icon', '🔒'));
  const t = el('div', '');
  t.append(el('b', '', `Next: Surah ${meta.englishName}, ayah ${a}`));
  t.append(el('p', 'muted', 'This one opens after you finish the ayah above.'));
  card.append(t);
  return card;
}

function renderTodayBar(doneToday, learnedTotal) {
  const dots = $('today-dots');
  dots.innerHTML = '';
  for (let i = 0; i < DAILY_LIMIT; i++) dots.append(el('span', 'dot' + (i < doneToday ? ' on' : '')));
  $('today-text').textContent = doneToday >= DAILY_LIMIT
    ? `Today: ${DAILY_LIMIT} of ${DAILY_LIMIT} ayahs learned. Well done!`
    : `Today: ${doneToday} of ${DAILY_LIMIT} ayahs learned`;
}

async function renderStudy() {
  const token = ++studyToken;
  studyDay = todayStr();
  clearInterval(lockTimer);
  lockTimer = null;
  cardRefresh.clear();
  const body = $('study-body');
  const doneToday = doneTodayCount();
  const left = Math.max(0, DAILY_LIMIT - doneToday);
  renderTodayBar(doneToday);

  let upcoming = [];
  let list = null;
  try {
    list = await getSurahList();
    upcoming = await nextAyahs(Math.max(left, 1));
  } catch (e) {
    if (token !== studyToken) return;
    body.innerHTML = '';
    body.append(el('div', 'card', 'Could not load the lessons. Open the app once with internet.'));
    return;
  }
  if (token !== studyToken) return;
  fillStartPicker(list);

  const nodes = [];
  const todayCards = Object.entries(studyData().ayahs)
    .filter(([, v]) => v.done === todayStr())
    .sort((x, y) => (x[1].at || 0) - (y[1].at || 0))
    .map(([k]) => k.split(':').map(Number));

  if (!upcoming.length) {
    const c = el('div', 'card empty-state');
    c.append(el('h2', '', '🎉 You finished every lesson!'), el('p', 'muted', 'You learned all the ayahs, one by one. Use All Surahs to listen anytime.'));
    nodes.push(c);
  } else if (left === 0) {
    const nx = upcoming[0];
    const c = el('div', 'card lock-card');
    c.append(el('div', 'lock-big', '🔒'));
    c.append(el('h2', '', `You learned your ${DAILY_LIMIT} ayahs today!`));
    c.append(el('p', 'muted', 'The next ayahs open tomorrow. Rest, and say them again in your head.'));
    const timer = el('div', 'lock-timer');
    timer.id = 'lock-timer';
    timer.textContent = fmtCountdown(msUntilMidnight());
    c.append(timer, el('p', 'muted tiny', `Opens in hours : minutes : seconds. Next: Surah ${list[nx.s - 1].englishName}, ayah ${nx.a}.`));
    nodes.push(c);
    const day = todayStr();
    lockTimer = setInterval(() => {
      if (todayStr() !== day) { renderStudy(); return; }
      const t = $('lock-timer');
      if (t) t.textContent = fmtCountdown(msUntilMidnight());
    }, 1000);
  } else {
    const first = upcoming[0];
    // About this surah, in simple words
    const info = await getSurahInfo(first.s).catch(() => null);
    if (token !== studyToken) return;
    if (info) {
      const det = el('details', 'card surah-intro');
      det.open = first.a === 1;
      det.append(el('summary', '', `About Surah ${list[first.s - 1].englishName}`));
      det.append(el('p', 'about-text', info.summary));
      nodes.push(det);
    }
    nodes.push(await buildAyahCard(first.s, first.a, 'active'));
    if (left >= 2 && upcoming[1]) nodes.push(lockedCard(upcoming[1].s, upcoming[1].a, list[upcoming[1].s - 1]));
  }

  if (todayCards.length) {
    const h = el('h3', 'section-title', 'Learned today');
    nodes.push(h);
    for (const [s, a] of todayCards) nodes.push(await buildAyahCard(s, a, 'done'));
  }
  if (token !== studyToken) return;
  body.innerHTML = '';
  nodes.forEach(n => body.append(n));
  syncPlayButtons();
  prefetchAhead(10);
}

// ---------- Choose where to start ----------
function fillStartPicker(list) {
  const sel = $('start-surah-select');
  const plan = studyPlan();
  if (!sel.options.length) {
    sel.append(new Option('The first lesson in my order', ''));
    list.forEach(s => sel.append(new Option(`${s.number}. ${s.englishName} (${s.numberOfAyahs} ayahs)`, String(s.number))));
    const ord = $('study-order-select');
    Object.entries(STUDY_ORDERS).forEach(([v, label]) => ord.append(new Option(label, v)));
  }
  sel.value = plan.start ? String(plan.start) : '';
  $('study-order-select').value = plan.order;
}

function initStudyPlan() {
  const save = () => {
    const start = parseInt($('start-surah-select').value, 10) || null;
    saveJSON(LS.plan, { start, order: $('study-order-select').value });
    renderStudy();
  };
  $('start-surah-select').addEventListener('change', save);
  $('study-order-select').addEventListener('change', save);
}

// ---------- Playing one ayah ----------
async function playAyah(s, a) {
  const au = $('ayah-audio');
  const key = `${s}:${a}`;
  if (au.dataset.key === key && au.src) {
    if (!au.paused) { au.pause(); return; }
    if (!au.ended && au.currentTime > 0) { au.play().catch(() => {}); return; }
  }
  $('audio-player').pause();
  au.pause();
  au.dataset.key = key;
  au.dataset.failedOver = '';
  if (ayahObjectUrl) { URL.revokeObjectURL(ayahObjectUrl); ayahObjectUrl = null; }
  let src = ayahAudioUrl(s, a);
  try {
    const c = await caches.open(AUDIO_CACHE);
    const hit = await c.match(src);
    if (hit) { ayahObjectUrl = URL.createObjectURL(await hit.blob()); src = ayahObjectUrl; }
  } catch (e) { /* play from the internet */ }
  if (au.dataset.key !== key) return;
  au.src = src;
  au.play().catch(() => {});
  if (!src.startsWith('blob:')) cacheAyahAudio(s, a);
}

function syncPlayButtons() {
  const au = $('ayah-audio');
  document.querySelectorAll('.ayah-play-btn').forEach(b => {
    const on = au.dataset.key === b.dataset.key && !au.paused && !au.ended;
    b.textContent = on ? '⏸ Pause' : '▶ Play this ayah';
  });
}

function initAyahAudio() {
  const au = $('ayah-audio');
  au.addEventListener('play', () => { $('audio-player').pause(); syncPlayButtons(); });
  au.addEventListener('pause', syncPlayButtons);
  au.addEventListener('ended', () => {
    const key = au.dataset.key;
    if (!key) return;
    const [s, a] = key.split(':').map(Number);
    const plays = getAyahState(s, a).plays + 1;
    setAyahState(s, a, { plays });
    if (plays === REQUIRED_PLAYS) showToast(`✓ You played it ${REQUIRED_PLAYS} times!`, 3000);
    const f = cardRefresh.get(key);
    if (f) f();
    syncPlayButtons();
  });
  // If the main server cannot be reached, try the backup one once.
  au.addEventListener('error', () => {
    const key = au.dataset.key;
    if (!key || !au.src) return;
    const [s, a] = key.split(':').map(Number);
    if (!navigator.onLine && !au.src.startsWith('blob:')) {
      showToast('No internet. Open this lesson once with internet and its audio will be saved.', 4000);
      return;
    }
    if (au.dataset.failedOver === '1' || au.src.startsWith('blob:')) return;
    au.dataset.failedOver = '1';
    au.src = backupAyahAudioUrl(s, a);
    au.load();
    au.play().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && activeProfileId && todayStr() !== studyDay && $('tab-learn').classList.contains('active')) renderStudy();
  });
}


// ---------- Your Wins Tab ----------
// Only what you learned: "You have learned 4 of 6 ayahs in Surah An-Nas".
function rangeText(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  const parts = [];
  let i = 0;
  while (i < a.length) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    parts.push(j > i + 1 ? `${a[i]}–${a[j]}` : a.slice(i, j + 1).join(', '));
    i = j + 1;
  }
  return parts.join(', ');
}

async function renderWins() {
  let list = null;
  try { list = await getSurahList(); } catch (e) { /* use numbers only */ }
  const bySurah = new Map();
  const days = new Set();
  let total = 0;
  Object.entries(studyData().ayahs).forEach(([k, v]) => {
    if (!v.done) return;
    const [s, a] = k.split(':').map(Number);
    total++;
    days.add(v.done);
    const row = bySurah.get(s) || { s, ayahs: [], last: 0 };
    row.ayahs.push(a);
    row.last = Math.max(row.last, v.at || 0, row.last);
    row.lastDay = !row.lastDay || v.done > row.lastDay ? v.done : row.lastDay;
    bySurah.set(s, row);
  });
  const rows = [...bySurah.values()].sort((x, y) => (y.lastDay || '').localeCompare(x.lastDay || '') || y.last - x.last);
  const finished = rows.filter(r => list && r.ayahs.length === list[r.s - 1].numberOfAyahs).length;

  $('wins-ayahs').textContent = total;
  $('wins-surahs').textContent = finished;
  $('wins-days').textContent = days.size;

  const box = $('wins-list');
  box.innerHTML = '';
  if (!rows.length) {
    box.append(el('p', 'muted', 'Nothing yet. Your first ayah is waiting in the Study tab.'));
    return;
  }
  rows.forEach(r => {
    const meta = list ? list[r.s - 1] : null;
    const row = el('div', 'win-row');
    row.append(el('span', 'win-name', `Surah ${meta ? meta.englishName : r.s}`));
    const of = meta ? ` of ${meta.numberOfAyahs}` : '';
    const doneAll = meta && r.ayahs.length === meta.numberOfAyahs;
    row.append(el('span', 'win-detail' + (doneAll ? ' win-all' : ''),
      doneAll ? `✓ You learned all ${meta.numberOfAyahs} ayahs` : `You have learned ${r.ayahs.length}${of} ${r.ayahs.length === 1 && !meta ? 'ayah' : 'ayahs'}`));
    row.append(el('span', 'muted tiny', `Ayah ${rangeText(r.ayahs)}`));
    box.append(row);
  });
}

// ---------- All Surahs Tab: just listen ----------
let surahSearchQuery = '';

function showBrowse() {
  $('surah-browse').hidden = false;
  $('surah-listen').hidden = true;
  renderNowPlaying();
}

async function renderSurahGrid() {
  const container = $('surah-list');
  try {
    const list = await getSurahList();
    const learned = {};
    Object.entries(studyData().ayahs).forEach(([k, v]) => {
      if (v.done) { const s = k.split(':')[0]; learned[s] = (learned[s] || 0) + 1; }
    });
    container.innerHTML = '';
    list.forEach(s => {
      const q = surahSearchQuery;
      const match = !q || s.englishName.toLowerCase().includes(q) ||
        s.englishNameTranslation.toLowerCase().includes(q) || String(s.number).includes(q);
      if (!match) return;
      const card = el('div', 'surah-card' + (listenSurah === s.number ? ' current' : ''));
      const top = el('div', 'sc-top');
      top.append(el('span', 'sc-num', `#${s.number}`), el('span', 'sc-arabic', s.name));
      card.append(top, el('div', 'sc-name', s.englishName), el('div', 'muted', s.englishNameTranslation));
      card.append(el('div', 'sc-meta', `${s.numberOfAyahs} verses · ${placeName(s.revelationType)}`));
      const got = learned[s.number] || 0;
      if (got >= s.numberOfAyahs) card.append(el('span', 'chip chip-done', '✓ Learned'));
      else if (got > 0) card.append(el('span', 'chip', `${got} of ${s.numberOfAyahs} learned`));
      card.addEventListener('click', () => showListen(s.number, true));
      container.appendChild(card);
    });
    if (!container.children.length) container.append(el('p', 'muted', 'No surah found. Try a different name.'));
  } catch (e) {
    container.innerHTML = '<p class="muted">Could not load surah list. Check your internet connection.</p>';
  }
}

function initSurahSearch() {
  $('surah-search').addEventListener('input', (e) => {
    surahSearchQuery = e.target.value.trim().toLowerCase();
    renderSurahGrid();
  });
}

function renderNowPlaying() {
  const btn = $('now-playing');
  const audio = $('audio-player');
  const on = listenSurah && audio.src && !audio.paused;
  btn.hidden = !on;
  if (on && surahListCache) btn.textContent = `▶ Now playing: ${listenSurah}. ${surahListCache[listenSurah - 1].englishName} (tap to open)`;
}

function updateListenLinks(name) {
  const reciter = localStorage.getItem(LS.reciter) || 'Mishary Alafasy';
  const query = encodeURIComponent(`${name} Surah ${reciter} full recitation`);
  $('link-youtube').href = `https://www.youtube.com/results?search_query=${query}`;
  $('link-spotify').href = `https://open.spotify.com/search/${query}`;
  $('youtube-embed').removeAttribute('src');
  $('youtube-embed').dataset.src = `https://www.youtube.com/embed?listType=search&list=${query}`;
  $('yt-details').open = false;
}

async function showListen(n, autoplay) {
  n = Number(n);
  if (!(n >= 1 && n <= 114)) return;
  let meta = null;
  try { meta = (await getSurahList())[n - 1]; } catch (e) { /* offline with nothing saved */ }
  const audio = $('audio-player');
  const same = listenSurah === n && audio.dataset.surah === String(n);
  listenSurah = n;
  localStorage.setItem(LS.listen, String(n));
  $('surah-browse').hidden = true;
  $('surah-listen').hidden = false;
  $('listen-name').textContent = meta ? `${n}. ${meta.englishName}` : `Surah ${n}`;
  $('listen-arabic').textContent = meta ? meta.name : '';
  $('listen-meta').textContent = meta ? `${meta.englishNameTranslation} · ${meta.numberOfAyahs} verses · ${placeName(meta.revelationType)}` : '';
  $('btn-prev').disabled = n <= 1;
  $('btn-next').disabled = n >= 114;
  updateListenLinks(meta ? meta.englishName : `Surah ${n}`);
  renderLoopButton();
  if (!same) {
    autoplayNext = !!autoplay;
    setSurahAudio(n);
  } else if (autoplay && audio.paused) {
    $('ayah-audio').pause();
    audio.play().catch(() => {});
  }
  renderListenVerses(n);
  renderOfflineState(n);
}

async function renderListenVerses(n) {
  const box = $('listen-verses');
  $('listen-verses-lang').textContent = `Words in: ${LANGUAGES[currentLanguage()].label}`;
  try {
    const t = await getSurahText(n);
    if (listenSurah !== n) return;
    const frag = document.createDocumentFragment();
    t.arabic.ayahs.forEach((ay, i) => {
      const item = el('div', 'verse-item');
      item.append(el('span', 'verse-num', `Verse ${ay.numberInSurah}`));
      item.append(el('div', 'verse-arabic', stripBismillah(ay.text, n, ay.numberInSurah)));
      item.append(el('div', 'verse-translit', t.transliteration.ayahs[i].text));
      item.append(el('div', 'verse-translation', t.translation.ayahs[i].text));
      frag.append(item);
    });
    box.innerHTML = '';
    box.append(frag);
  } catch (e) {
    box.innerHTML = '';
    box.append(el('p', 'muted', 'Could not load the words. Check your internet connection.'));
  }
}

// ---------- Listening speed ----------
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
function currentSpeed() {
  const v = parseFloat(localStorage.getItem(LS.speed));
  return SPEEDS.includes(v) ? v : 1;
}
function applySpeed() {
  const audio = $('audio-player');
  const r = currentSpeed();
  audio.defaultPlaybackRate = r;
  audio.playbackRate = r;
}
function renderSpeedButtons() {
  const box = $('speed-buttons');
  const cur = currentSpeed();
  box.innerHTML = '';
  SPEEDS.forEach(r => {
    const b = el('button', 'speed-btn' + (r === cur ? ' active' : ''), r === 1 ? 'Normal' : `${r}×`);
    b.type = 'button';
    b.setAttribute('aria-pressed', r === cur ? 'true' : 'false');
    b.addEventListener('click', () => {
      localStorage.setItem(LS.speed, String(r));
      applySpeed();
      renderSpeedButtons();
    });
    box.append(b);
  });
  applySpeed();
}

function renderLoopButton() {
  const on = localStorage.getItem(LS.loop) === '1';
  const b = $('btn-loop');
  b.textContent = on ? '🔁 Repeat: On' : '🔁 Repeat: Off';
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.classList.toggle('active', on);
  $('repeat-hint').textContent = on
    ? 'This surah plays again and again.'
    : 'When this surah ends, the next surah plays.';
}

// ---------- Big player ----------
function fmtClock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function setPlayIcon(playing) {
  const b = $('btn-play');
  b.textContent = playing ? '⏸' : '▶';
  b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
function resetPlayerUI() {
  $('seek-slider').value = 0;
  $('time-now').textContent = '0:00';
  $('time-total').textContent = '--:--';
  setPlayIcon(false);
}
function initPlayerUI() {
  const audio = $('audio-player');
  const slider = $('seek-slider');
  let dragging = false;

  $('btn-play').addEventListener('click', () => {
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  audio.addEventListener('play', () => { applySpeed(); setPlayIcon(true); $('ayah-audio').pause(); renderNowPlaying(); });
  audio.addEventListener('pause', () => { setPlayIcon(false); renderNowPlaying(); });
  audio.addEventListener('ended', () => {
    setPlayIcon(false);
    if (localStorage.getItem(LS.loop) === '1') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else if (listenSurah && listenSurah < 114) {
      showListen(listenSurah + 1, true);   // Repeat is off: go on to the next surah
    } else {
      renderNowPlaying();
    }
  });

  audio.addEventListener('timeupdate', () => {
    if (!dragging && isFinite(audio.duration) && audio.duration > 0) {
      slider.value = Math.round((audio.currentTime / audio.duration) * 1000);
    }
    $('time-now').textContent = fmtClock(audio.currentTime);
  });
  const showTotal = () => { $('time-total').textContent = isFinite(audio.duration) ? fmtClock(audio.duration) : '--:--'; };
  audio.addEventListener('loadedmetadata', () => { applySpeed(); showTotal(); });
  audio.addEventListener('durationchange', showTotal);

  // If the main audio server cannot be reached, try the backup one once.
  audio.addEventListener('error', () => {
    const n = parseInt(audio.dataset.surah || '', 10);
    if (!audio.src) return;
    if (!navigator.onLine && !audio.src.startsWith('blob:')) {
      $('offline-status').textContent = 'No internet right now. Press "Save for no internet" while you are online, and this surah will play anywhere.';
      return;
    }
    if (!n || audio.dataset.failedOver === '1' || audio.src.startsWith('blob:')) return;
    audio.dataset.failedOver = '1';
    audio.src = backupAudioUrl(n);
    audio.load();
  });

  slider.addEventListener('input', () => {
    dragging = true;
    if (isFinite(audio.duration)) $('time-now').textContent = fmtClock((slider.value / 1000) * audio.duration);
  });
  slider.addEventListener('change', () => {
    if (isFinite(audio.duration)) audio.currentTime = (slider.value / 1000) * audio.duration;
    dragging = false;
  });

  $('btn-rewind').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 5); });
  $('btn-prev').addEventListener('click', () => { if (listenSurah > 1) showListen(listenSurah - 1, true); });
  $('btn-next').addEventListener('click', () => { if (listenSurah < 114) showListen(listenSurah + 1, true); });
  $('btn-loop').addEventListener('click', () => {
    const on = localStorage.getItem(LS.loop) === '1';
    localStorage.setItem(LS.loop, on ? '0' : '1');
    renderLoopButton();
  });
  $('btn-listen-back').addEventListener('click', () => { showBrowse(); renderSurahGrid(); });
  $('now-playing').addEventListener('click', () => { if (listenSurah) showListen(listenSurah, false); });

  // Only load the video once someone actually opens it.
  $('yt-details').addEventListener('toggle', (e) => {
    const frame = $('youtube-embed');
    if (e.target.open && !frame.getAttribute('src') && frame.dataset.src) frame.src = frame.dataset.src;
  });

  $('btn-offline').addEventListener('click', () => { if (listenSurah) saveSurahOffline(listenSurah); });
  $('btn-offline-remove').addEventListener('click', () => { if (listenSurah) removeOffline(listenSurah); });
}

// ---------- Settings Tab ----------
function initSettingsActions() {
  const reciterSelect = $('reciter-select');
  reciterSelect.value = localStorage.getItem(LS.reciter) || 'Mishary Alafasy';
  reciterSelect.addEventListener('change', () => {
    localStorage.setItem(LS.reciter, reciterSelect.value);
    if (listenSurah && surahListCache) updateListenLinks(surahListCache[listenSurah - 1].englishName);
  });

  $('language-select').addEventListener('change', (e) => setLanguage(e.target.value));
  $('listen-language-select').addEventListener('change', (e) => setLanguage(e.target.value));

  $('btn-save-short').addEventListener('click', saveShortSurahsOffline);
  $('btn-clear-audio').addEventListener('click', clearSavedAudio);

  $('btn-reset-all').addEventListener('click', () => {
    if (!confirm('Start over? This deletes everything you learned and your play counts. You cannot undo this.')) return;
    localStorage.removeItem(LS.study);
    ['current', 'surahs', 'monthly_goal'].forEach(f => localStorage.removeItem(profileKey(f)));
    $('ayah-audio').pause();
    renderStudy();
    renderWins();
    renderSurahGrid();
  });
}

// ---------- Init ----------
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    renderOfflineTextStatus();
    if (hadController) showToast('A new version is ready. Close the app and open it again.', 8000);
  });
}
window.addEventListener('online', () => { prepareOffline(); renderOfflineTextStatus(); });
window.addEventListener('offline', renderOfflineTextStatus);

window.addEventListener('DOMContentLoaded', () => {
  initPeople();
  initTabs();
  initSurahSearch();
  initPlayerUI();
  initAyahAudio();
  initStudyPlan();
  initSettingsActions();

  adoptLegacyData();
  const profiles = getProfiles();
  const savedId = localStorage.getItem(ACTIVE_KEY);
  const saved = profiles.find(x => x.id === savedId);
  let unlocked = null;
  try { unlocked = sessionStorage.getItem('qa_unlocked'); } catch (e) { /* ignore */ }
  // Open straight to the last person. A PIN is asked once each time the app is opened.
  if (saved && (!saved.pinHash || unlocked === saved.id)) startApp(saved.id);
  else showProfileScreen();
});
