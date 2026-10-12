// ---------- Constants & State ----------
// Every person on this phone gets their own set of keys, so progress never mixes.
const PROFILES_KEY = 'qa_profiles';       // [{ id, name, pinHash }]
const ACTIVE_KEY = 'qa_active_profile';   // id of the person using the app now
const PROFILE_FIELDS = ['current', 'surahs', 'reciter', 'monthly_goal', 'loop'];
let activeProfileId = null;
function profileKey(field) { return `qa_p${activeProfileId}_${field}`; }
const LS = {
  get current() { return profileKey('current'); },       // surah number being studied
  get surahs() { return profileKey('surahs'); },         // per-surah progress, keyed by surah number
  get reciter() { return profileKey('reciter'); },
  get monthlyGoal() { return profileKey('monthly_goal'); },
  get loop() { return profileKey('loop'); }
};
const OLD_KEYS = ['qa_plan', 'qa_completed'];
const DAY_MS = 24 * 60 * 60 * 1000;
const $ = (id) => document.getElementById(id);

let surahListCache = null;
let surahInfoCache = null;
let currentMeta = null;   // metadata of the surah open in Study tab
let renderToken = 0;      // guards against slow loads landing on the wrong surah

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
  localStorage.setItem(key, JSON.stringify(val));
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
function fmtDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec} sec`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
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

// ---------- Per-surah progress ----------
function allStates() {
  return loadJSON(LS.surahs, {});
}
function getState(n) {
  const s = allStates()[n] || {};
  return {
    note: s.note || '',
    reflections: Array.isArray(s.reflections) ? s.reflections : [],
    level: s.level ?? null,
    listenSeconds: s.listenSeconds || 0,
    repeats: s.repeats || 0,
    ayahLevels: s.ayahLevels && typeof s.ayahLevels === 'object' ? s.ayahLevels : {},
    learnedOn: s.learnedOn || null,
    englishName: s.englishName || '',
    arabicName: s.arabicName || ''
  };
}
function setState(n, patch) {
  const all = allStates();
  all[n] = Object.assign({}, all[n] || {}, patch);
  saveJSON(LS.surahs, all);
}
function currentSurahNumber() {
  return parseInt(localStorage.getItem(LS.current) || '', 10) || null;
}

// Carry over progress saved by the old 14-day version of the app.
function migrateOldData() {
  const oldPlan = loadJSON('qa_plan', null);
  const oldCompleted = loadJSON('qa_completed', null);
  if (!oldPlan && !oldCompleted) return;
  const all = allStates();
  (oldCompleted || []).forEach(c => {
    all[c.number] = Object.assign({}, all[c.number] || {}, {
      learnedOn: c.finishedOn, englishName: c.englishName
    });
  });
  saveJSON(LS.surahs, all);
  if (oldPlan && !localStorage.getItem(LS.current)) {
    localStorage.setItem(LS.current, String(oldPlan.number));
  }
  OLD_KEYS.forEach(k => localStorage.removeItem(k));
}

// ---------- People ----------
let pendingProfile = null;
let activeVerseRecorder = null;

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
  if (activeVerseRecorder && activeVerseRecorder.state === 'recording') activeVerseRecorder.stop();
}

function startApp(id) {
  activeProfileId = id;
  localStorage.setItem(ACTIVE_KEY, id);
  try { sessionStorage.setItem('qa_unlocked', id); } catch (e) { /* private mode */ }
  $('profile-screen').hidden = true;
  const person = activeProfile();
  $('person-name').textContent = person ? person.name : '';
  $('settings-person-name').textContent = person ? person.name : '';
  migrateOldData();
  stopAllAudio();
  $('reciter-select').value = localStorage.getItem(LS.reciter) || 'Mishary Alafasy';
  surahSearchQuery = '';
  $('surah-search').value = '';
  switchTab('learn');
  renderStudy();
  renderSurahGrid();
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
  $('btn-goto-surahs').addEventListener('click', () => switchTab('surahs'));
}
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (tab === 'wins') renderWins();
  if (tab === 'surahs') renderSurahGrid();
  window.scrollTo(0, 0);
}
function openSurah(n) {
  localStorage.setItem(LS.current, String(n));
  switchTab('learn');
  renderStudy();
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
async function getSurahList() {
  if (surahListCache) return surahListCache;
  const res = await fetch('https://api.alquran.cloud/v1/surah');
  const data = await res.json();
  surahListCache = data.data; // array of 114, in order
  return surahListCache;
}

async function getSurahText(number) {
  const [arRes, enRes, trRes] = await Promise.all([
    fetch(`https://api.alquran.cloud/v1/surah/${number}/quran-uthmani`),
    fetch(`https://api.alquran.cloud/v1/surah/${number}/en.itani`),
    fetch(`https://api.alquran.cloud/v1/surah/${number}/en.transliteration`)
  ]);
  const [ar, en, tr] = await Promise.all([arRes.json(), enRes.json(), trRes.json()]);
  return { arabic: ar.data, translation: en.data, transliteration: tr.data };
}

// Plain-English summary + reflection questions for all 114 surahs.
async function getSurahInfo(n) {
  if (!surahInfoCache) {
    const res = await fetch('data/surah-info.json?v=2');
    if (!res.ok) throw new Error('surah info missing');
    surahInfoCache = await res.json();
  }
  return surahInfoCache.find(i => i.n === n) || null;
}

// Simple explanation for each verse. Not every surah has one yet.
async function getSimpleAyahs(n) {
  try {
    const res = await fetch(`data/ayah-simple/${n}.json?v=3`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
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
  const [arRes, enRes] = await Promise.all([
    fetch(`https://api.alquran.cloud/v1/ayah/${ref}/quran-uthmani`),
    fetch(`https://api.alquran.cloud/v1/ayah/${ref}/en.itani`)
  ]);
  const ar = await arRes.json();
  const en = await enRes.json();
  return { arabic: ar.data, translation: en.data };
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

// ---------- All Surahs Tab ----------
let surahSearchQuery = '';

async function renderSurahGrid() {
  const container = $('surah-list');
  try {
    const list = await getSurahList();
    const states = allStates();
    const current = currentSurahNumber();
    container.innerHTML = '';
    list.forEach(s => {
      const st = states[s.number] || {};
      const q = surahSearchQuery;
      const match = !q || s.englishName.toLowerCase().includes(q) ||
        s.englishNameTranslation.toLowerCase().includes(q) || String(s.number).includes(q);
      if (!match) return;
      const card = el('div', 'surah-card' + (current === s.number ? ' current' : ''));
      const top = el('div', 'sc-top');
      top.append(el('span', 'sc-num', `#${s.number}`), el('span', 'sc-arabic', s.name));
      card.append(top, el('div', 'sc-name', s.englishName), el('div', 'muted', s.englishNameTranslation));
      card.append(el('div', 'sc-meta', `${s.numberOfAyahs} verses · ${placeName(s.revelationType)}`));
      if (st.learnedOn) card.append(el('span', 'chip chip-done', '✓ Learned'));
      else if (st.listenSeconds > 0) card.append(el('span', 'chip', 'Practicing'));
      card.addEventListener('click', () => openSurah(s.number));
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

// ---------- Study Tab ----------
const LEVEL_WORDS = [
  '', 'Just starting', 'Just starting', 'Just starting',
  'Getting there', 'Getting there', 'Getting there',
  'Pretty good', 'Pretty good', 'Very strong', 'Almost perfect'
];

async function renderStudy() {
  const token = ++renderToken;
  const n = currentSurahNumber();
  const empty = $('no-surah-selected');
  const content = $('learn-content');

  if (!n) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;

  const state = getState(n);
  let meta = null;
  try { meta = (await getSurahList())[n - 1]; } catch (e) { /* offline: fall back to saved name */ }
  if (token !== renderToken) return;
  currentMeta = meta;

  const name = meta ? meta.englishName : (state.englishName || `Surah ${n}`);
  $('learn-surah-name').textContent = meta
    ? `${n}. ${meta.englishName} — ${meta.englishNameTranslation}`
    : `${n}. ${name}`;
  $('learn-surah-arabic').textContent = meta ? meta.name : state.arabicName;
  $('learn-surah-meta').textContent = meta ? `${meta.numberOfAyahs} verses · ${placeName(meta.revelationType)}` : '';

  // About: plain-English summary, then the reflection questions.
  let info = null;
  try { info = await getSurahInfo(n); } catch (e) { /* shown as fallback text below */ }
  if (token !== renderToken) return;
  $('about-summary').textContent = info ? info.summary : 'The summary could not load. Check your internet and try again.';
  renderReflections(n, info ? info.questions : [], state.reflections);

  // Your own words, level, practice stats
  $('my-summary').value = state.note;
  $('my-summary-status').textContent = '';
  $('level-slider').value = state.level ?? 5;
  renderLevelLabel(state.level);
  renderPracticeStats(n);
  renderLoopButton();

  // Audio: only reload the source when the surah changed so playback is not interrupted.
  const audio = $('audio-player');
  if (audio.dataset.surah !== String(n)) {
    audio.pause();
    audio.dataset.surah = String(n);
    audio.src = `https://cdn.islamic.network/quran/audio-surah/128/ar.alafasy/${n}.mp3`;
  }
  const reciter = localStorage.getItem(LS.reciter) || 'Mishary Alafasy';
  const query = encodeURIComponent(`${name} Surah ${reciter} full recitation`);
  $('link-youtube').href = `https://www.youtube.com/results?search_query=${query}`;
  $('link-spotify').href = `https://open.spotify.com/search/${query}`;
  const details = $('yt-details');
  details.open = false;
  $('youtube-embed').removeAttribute('src');
  $('youtube-embed').dataset.src = `https://www.youtube.com/embed?listType=search&list=${query}`;

  resetRecitationUI();
  refreshLearnedUI();

  // Verses
  const list = $('verses-list');
  const note = $('verses-note');
  list.innerHTML = '<p class="muted">Loading verses…</p>';
  note.hidden = true;
  const [text, simple] = await Promise.all([getSurahText(n).catch(() => null), getSimpleAyahs(n)]);
  if (token !== renderToken) return;

  if (!text) {
    list.innerHTML = '<p class="muted">Could not load verse text. Check your internet connection.</p>';
    return;
  }
  const count = text.arabic.ayahs.length;
  const hasSimple = Array.isArray(simple) && simple.length === count;
  if (!hasSimple) {
    note.hidden = false;
    note.textContent = 'Simple words for each verse are not ready for this surah yet. Read the summary above.';
  }
  list.innerHTML = '';
  const ayahLevels = getState(n).ayahLevels;
  text.arabic.ayahs.forEach((ayah, i) => {
    const item = el('div', 'verse-item');
    item.append(el('span', 'verse-num', `Ayah ${ayah.numberInSurah}`));
    item.append(el('div', 'verse-arabic', stripBismillah(ayah.text, n, ayah.numberInSurah)));
    item.append(el('div', 'verse-translit', text.transliteration.ayahs[i].text));
    item.append(el('div', 'verse-translation', text.translation.ayahs[i].text));
    if (hasSimple) {
      const simpleBox = el('div', 'verse-simple');
      simpleBox.append(el('b', null, 'In simple words: '), document.createTextNode(simple[i]));
      item.append(simpleBox);
    }
    item.append(buildVersePractice(n, ayah.numberInSurah, ayahLevels[ayah.numberInSurah] ?? null));
    list.appendChild(item);
  });
}

// A small box under every verse to rate yourself and record just that verse.
function buildVersePractice(n, ayahNumber, level) {
  const box = el('details', 'verse-practice');
  const summary = el('summary', null, level ? `Practice this verse · ${level}/10` : 'Practice this verse');
  box.append(summary);

  const row = el('div', 'level-row');
  const slider = el('input');
  slider.type = 'range'; slider.min = '1'; slider.max = '10'; slider.step = '1';
  slider.value = String(level ?? 5);
  row.append(el('span', 'tiny muted', '1'), slider, el('span', 'tiny muted', '10'));
  const label = el('p', 'level-label', level ? `${level} / 10 — ${LEVEL_WORDS[level]}` : 'How well can you say this verse? Slide to show.');
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    label.textContent = `${v} / 10 — ${LEVEL_WORDS[v]}`;
  });
  slider.addEventListener('change', () => {
    const v = parseInt(slider.value, 10);
    const levels = Object.assign({}, getState(n).ayahLevels, { [ayahNumber]: v });
    setState(n, { ayahLevels: levels });
    summary.textContent = `Practice this verse · ${v}/10`;
  });

  const recBtn = el('button', 'btn secondary', '🎙️ Say this verse');
  recBtn.type = 'button';
  const player = el('audio', 'full-audio');
  player.controls = true;
  player.hidden = true;
  let recorder = null;
  let chunks = [];
  recBtn.addEventListener('click', async () => {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    try {
      if (activeVerseRecorder && activeVerseRecorder.state === 'recording') activeVerseRecorder.stop();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recorder = new MediaRecorder(stream);
      activeVerseRecorder = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        if (chunks.length) {
          player.src = URL.createObjectURL(new Blob(chunks, { type: 'audio/webm' }));
          player.hidden = false;
        }
        recBtn.textContent = '🎙️ Say it again';
      };
      recorder.start();
      recBtn.textContent = '⏹ Stop';
    } catch (e) {
      alert('The microphone is needed to record. Please allow the microphone and try again.');
    }
  });

  box.append(row, label, recBtn, player);
  return box;
}

function renderReflections(n, questions, answers) {
  const box = $('reflection-list');
  box.innerHTML = '';
  questions.forEach((q, i) => {
    const wrap = el('div', 'reflection');
    wrap.append(el('label', 'reflection-q', `${i + 1}. ${q}`));
    const ta = el('textarea', 'note-box');
    ta.rows = 3;
    ta.placeholder = 'Your answer...';
    ta.value = answers[i] || '';
    const status = el('p', 'muted tiny');
    bindAutosave(ta, status, (value) => {
      const current = getState(n).reflections.slice();
      while (current.length < questions.length) current.push('');
      current[i] = value;
      setState(n, { reflections: current });
    });
    wrap.append(ta, status);
    box.append(wrap);
  });
}

// Saves a text field a moment after typing stops, for the surah that was open when typing.
function bindAutosave(field, statusEl, save) {
  let timer = null;
  field.addEventListener('input', () => {
    statusEl.textContent = 'Typing…';
    clearTimeout(timer);
    timer = setTimeout(() => {
      save(field.value);
      statusEl.textContent = 'Saved ✓';
    }, 500);
  });
}

function renderLevelLabel(level) {
  $('level-label').textContent = level ? `${level} / 10 — ${LEVEL_WORDS[level]}` : 'Not rated yet';
}

function renderPracticeStats(n) {
  const s = getState(n);
  $('practice-stats').textContent = s.listenSeconds || s.repeats
    ? `Practice time: ${fmtDuration(s.listenSeconds)} · Repeated ${s.repeats} ${s.repeats === 1 ? 'time' : 'times'}`
    : 'Press play. Your practice time and repeats will show here.';
}

function renderLoopButton() {
  const on = localStorage.getItem(LS.loop) === '1';
  const btn = $('btn-loop');
  btn.textContent = `🔁 Repeat: ${on ? 'On' : 'Off'}`;
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('active', on);
}

function initStudyActions() {
  bindAutosave($('my-summary'), $('my-summary-status'), (value) => {
    const n = currentSurahNumber();
    if (n) setState(n, { note: value });
  });

  const slider = $('level-slider');
  slider.addEventListener('input', () => renderLevelLabel(parseInt(slider.value, 10)));
  slider.addEventListener('change', () => {
    const n = currentSurahNumber();
    if (n) setState(n, { level: parseInt(slider.value, 10) });
  });

  $('btn-rewind').addEventListener('click', () => {
    const audio = $('audio-player');
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  });

  $('btn-loop').addEventListener('click', () => {
    const on = localStorage.getItem(LS.loop) === '1';
    localStorage.setItem(LS.loop, on ? '0' : '1');
    renderLoopButton();
  });

  // Only load the video once someone actually opens it.
  $('yt-details').addEventListener('toggle', (e) => {
    const frame = $('youtube-embed');
    if (e.target.open && !frame.getAttribute('src') && frame.dataset.src) frame.src = frame.dataset.src;
  });

  initPracticeTracking();
  initRecitationActions();
}

// Counts how long the reference recitation has been playing and how many times it finished.
function initPracticeTracking() {
  const audio = $('audio-player');
  let timer = null;
  let last = 0;

  const stop = () => { clearInterval(timer); timer = null; };

  audio.addEventListener('playing', () => {
    stop();
    last = Date.now();
    timer = setInterval(() => {
      const now = Date.now();
      const delta = Math.min((now - last) / 1000, 2);
      last = now;
      const n = parseInt(audio.dataset.surah || '', 10);
      if (!n || audio.paused || audio.seeking) return;
      setState(n, { listenSeconds: getState(n).listenSeconds + delta });
      if (n === currentSurahNumber()) renderPracticeStats(n);
    }, 1000);
  });
  audio.addEventListener('pause', stop);
  audio.addEventListener('ended', () => {
    stop();
    const n = parseInt(audio.dataset.surah || '', 10);
    if (n) {
      setState(n, { repeats: getState(n).repeats + 1 });
      if (n === currentSurahNumber()) renderPracticeStats(n);
    }
    if (localStorage.getItem(LS.loop) === '1') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    }
  });
}

// ---------- Recite it yourself ----------
// No browser on iOS supports speech-to-text, so accuracy cannot be graded
// automatically. Instead the recording must be listened to in full (tracked
// in real time, skipping ahead does not count) before it can be confirmed.
let mediaRecorder = null;
let recordedChunks = [];
let recordingDuration = 0;
let listenedSeconds = 0;
let listenTickInterval = null;
let lastTickTime = null;

function resetRecitationUI() {
  const audioEl = $('recitation-audio');
  audioEl.pause();
  audioEl.hidden = true;
  audioEl.removeAttribute('src');
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  $('btn-record-recitation').textContent = '🎙️ Start Recording';
  $('btn-record-recitation').disabled = false;
  const note = $('recitation-listen-note');
  note.hidden = true;
  note.textContent = '';
  const checkbox = $('recitation-confirm-checkbox');
  checkbox.checked = false;
  checkbox.disabled = true;
  $('btn-mark-learned').disabled = true;
  recordingDuration = 0;
  listenedSeconds = 0;
  clearInterval(listenTickInterval);
}

// Attached once; recordingDuration/listenedSeconds are reset for every new recording.
function attachListenTracking(audio) {
  const updateNote = () => {
    const note = $('recitation-listen-note');
    if (!recordingDuration) return;
    note.hidden = false;
    const pct = Math.min(100, Math.round((listenedSeconds / recordingDuration) * 100));
    note.textContent = `You listened ${Math.round(listenedSeconds)} sec of ${Math.round(recordingDuration)} sec (${pct}%). Listen to all of it to go on.`;
  };

  const checkUnlock = () => {
    if (recordingDuration > 0 && listenedSeconds >= recordingDuration * 0.9) {
      $('recitation-confirm-checkbox').disabled = false;
      $('recitation-listen-note').textContent = '✓ You listened to all of it. You can check the box below.';
    }
  };

  audio.addEventListener('loadedmetadata', () => {
    if (!isFinite(audio.duration)) {
      // Recorded audio can report an infinite length until it is forced to seek.
      audio.currentTime = 1e101;
      audio.addEventListener('timeupdate', function fixOnce() {
        audio.removeEventListener('timeupdate', fixOnce);
        audio.currentTime = 0;
        recordingDuration = isFinite(audio.duration) ? audio.duration : 0;
        updateNote();
      });
    } else {
      recordingDuration = audio.duration;
      updateNote();
    }
  });

  audio.addEventListener('play', () => {
    lastTickTime = Date.now();
    clearInterval(listenTickInterval);
    listenTickInterval = setInterval(() => {
      const now = Date.now();
      const delta = (now - lastTickTime) / 1000;
      lastTickTime = now;
      if (!audio.paused && !audio.seeking) listenedSeconds += delta;
      updateNote();
      checkUnlock();
    }, 250);
  });
  audio.addEventListener('pause', () => clearInterval(listenTickInterval));
  audio.addEventListener('ended', () => { clearInterval(listenTickInterval); checkUnlock(); });
}

function refreshLearnedUI() {
  const n = currentSurahNumber();
  if (!n) return;
  const s = getState(n);
  const learned = !!s.learnedOn;
  $('learned-badge').hidden = !learned;
  $('btn-mark-learned').hidden = learned;
  $('btn-unlearn').hidden = !learned;
  $('learned-status').textContent = learned
    ? `🎉 You learned this surah on ${s.learnedOn}. It is in Your Wins.`
    : '';
}

function initRecitationActions() {
  const recordBtn = $('btn-record-recitation');
  const audioEl = $('recitation-audio');
  const checkbox = $('recitation-confirm-checkbox');
  attachListenTracking(audioEl);

  recordBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        if (!recordedChunks.length) return;
        recordingDuration = 0;
        listenedSeconds = 0;
        audioEl.src = URL.createObjectURL(new Blob(recordedChunks, { type: 'audio/webm' }));
        audioEl.hidden = false;
        recordBtn.textContent = '🎙️ Record Again';
        recordBtn.disabled = false;
        checkbox.disabled = true;
        checkbox.checked = false;
        $('btn-mark-learned').disabled = true;
      };
      mediaRecorder.start();
      recordBtn.textContent = '⏹ Stop Recording';
    } catch (e) {
      recordBtn.textContent = '🎙️ Start Recording';
      alert('The microphone is needed to record. Please allow the microphone and try again.');
    }
  });

  checkbox.addEventListener('change', () => {
    $('btn-mark-learned').disabled = !checkbox.checked;
  });

  $('btn-mark-learned').addEventListener('click', () => {
    const n = currentSurahNumber();
    if (!n || !checkbox.checked) return;
    setState(n, {
      learnedOn: todayStr(),
      englishName: currentMeta ? currentMeta.englishName : '',
      arabicName: currentMeta ? currentMeta.name : ''
    });
    refreshLearnedUI();
  });

  $('btn-unlearn').addEventListener('click', () => {
    const n = currentSurahNumber();
    if (!n) return;
    setState(n, { learnedOn: null });
    refreshLearnedUI();
    checkbox.checked = false;
    $('btn-mark-learned').disabled = true;
  });
}

// ---------- Your Wins Tab ----------
async function renderWins() {
  const states = allStates();
  const entries = Object.keys(states).map(k => ({ n: parseInt(k, 10), ...getState(parseInt(k, 10)) }));
  const learned = entries.filter(e => e.learnedOn).sort((a, b) => b.learnedOn.localeCompare(a.learnedOn));
  const practicing = entries.filter(e => !e.learnedOn && e.listenSeconds > 0)
    .sort((a, b) => b.listenSeconds - a.listenSeconds);

  $('wins-learned').textContent = learned.length;
  $('wins-time').textContent = fmtDuration(entries.reduce((s, e) => s + e.listenSeconds, 0));
  $('wins-repeats').textContent = entries.reduce((s, e) => s + e.repeats, 0);

  // This month vs. goal
  const goal = parseInt(localStorage.getItem(LS.monthlyGoal) || '1', 10);
  $('monthly-goal-select').value = String(goal);
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thisMonth = learned.filter(e => e.learnedOn.startsWith(monthKey)).length;
  $('month-progress-fill').style.width = `${Math.min(100, (thisMonth / goal) * 100)}%`;
  $('month-progress-text').textContent = thisMonth >= goal
    ? `🎉 Goal done: ${thisMonth} learned this month`
    : `${thisMonth} of ${goal} learned this month`;

  let names = null;
  try { names = await getSurahList(); } catch (e) { /* use saved names */ }
  const label = (e) => {
    const m = names ? names[e.n - 1] : null;
    return `${e.n}. ${m ? m.englishName : (e.englishName || 'Surah ' + e.n)}`;
  };

  const fill = (container, rows, emptyText, detail) => {
    container.innerHTML = '';
    if (!rows.length) { container.append(el('p', 'muted', emptyText)); return; }
    rows.forEach(e => {
      const row = el('button', 'win-row');
      row.append(el('span', 'win-name', label(e)), el('span', 'muted win-detail', detail(e)));
      row.addEventListener('click', () => openSurah(e.n));
      container.append(row);
    });
  };

  fill($('wins-list'), learned, 'No surahs learned yet. Your first win is waiting.', (e) => {
    const parts = [`Learned ${e.learnedOn}`];
    if (e.level) parts.push(`Level ${e.level}/10`);
    if (e.listenSeconds) parts.push(fmtDuration(e.listenSeconds));
    return parts.join(' · ');
  });
  fill($('practicing-list'), practicing, 'Nothing yet. Play a surah and it will show up here.', (e) => {
    const parts = [fmtDuration(e.listenSeconds)];
    if (e.level) parts.push(`Level ${e.level}/10`);
    return parts.join(' · ');
  });
}

function initWinsActions() {
  $('monthly-goal-select').addEventListener('change', (e) => {
    localStorage.setItem(LS.monthlyGoal, e.target.value);
    renderWins();
  });
}

// ---------- Settings Tab ----------
function initSettingsActions() {
  const reciterSelect = $('reciter-select');
  reciterSelect.value = localStorage.getItem(LS.reciter) || 'Mishary Alafasy';
  reciterSelect.addEventListener('change', () => {
    localStorage.setItem(LS.reciter, reciterSelect.value);
    renderStudy();
  });

  $('btn-reset-all').addEventListener('click', () => {
    if (!confirm('Delete all of your notes, wins and practice time? You cannot undo this.')) return;
    Object.values(LS).forEach(k => localStorage.removeItem(k));
    stopAllAudio();
    renderStudy();
    renderWins();
    renderSurahGrid();
  });

  initMicTest();
}

// Standalone mic check, independent of any surah.
function initMicTest() {
  const btn = $('btn-test-mic');
  const audioEl = $('test-mic-audio');
  let testRecorder = null;
  let testChunks = [];

  btn.addEventListener('click', async () => {
    if (testRecorder && testRecorder.state === 'recording') {
      testRecorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      testChunks = [];
      testRecorder = new MediaRecorder(stream);
      testRecorder.ondataavailable = (e) => { if (e.data.size > 0) testChunks.push(e.data); };
      testRecorder.onstop = () => {
        audioEl.src = URL.createObjectURL(new Blob(testChunks, { type: 'audio/webm' }));
        audioEl.hidden = false;
        stream.getTracks().forEach(t => t.stop());
        btn.textContent = '🎙️ Record Again';
      };
      testRecorder.start();
      btn.textContent = '⏹ Stop Recording';
    } catch (e) {
      alert('Could not use the microphone. Check that this site is allowed to use the microphone in your phone settings.');
    }
  });
}

// ---------- Init ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initPeople();
  initTabs();
  initSurahSearch();
  initStudyActions();
  initWinsActions();
  initSettingsActions();
  renderAyahOfTheDay();

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
