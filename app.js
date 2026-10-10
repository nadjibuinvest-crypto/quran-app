// ---------- Constants & State ----------
const LS = {
  current: 'qa_current',        // surah number being studied
  surahs: 'qa_surahs',          // per-surah progress, keyed by surah number
  reciter: 'qa_reciter',
  monthlyGoal: 'qa_monthly_goal',
  loop: 'qa_loop'
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
    fetch(`https://api.alquran.cloud/v1/surah/${number}/en.asad`),
    fetch(`https://api.alquran.cloud/v1/surah/${number}/en.transliteration`)
  ]);
  const [ar, en, tr] = await Promise.all([arRes.json(), enRes.json(), trRes.json()]);
  return { arabic: ar.data, translation: en.data, transliteration: tr.data };
}

// Plain-English summary + reflection questions for all 114 surahs.
async function getSurahInfo(n) {
  if (!surahInfoCache) {
    const res = await fetch('data/surah-info.json?v=1');
    if (!res.ok) throw new Error('surah info missing');
    surahInfoCache = await res.json();
  }
  return surahInfoCache.find(i => i.n === n) || null;
}

// Simple explanation for each verse. Not every surah has one yet.
async function getSimpleAyahs(n) {
  try {
    const res = await fetch(`data/ayah-simple/${n}.json?v=1`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// ---------- Ayah of the Day (Motivation) ----------
// Each entry references a real ayah (fetched live for accurate Arabic/translation)
// plus a short, well-known theme/story so nothing here is guessed or fabricated.
const DAILY_AYAHS = [
  { ref: '94:5', theme: 'Revealed to comfort the Prophet ﷺ during a hard period — a reminder that ease follows hardship.', youtube: 'Surah Ash-Sharh Al-Inshirah explanation story' },
  { ref: '2:286', theme: 'Allah does not burden a soul beyond what it can bear.', youtube: 'Surah Al-Baqarah 286 tafsir explanation' },
  { ref: '13:28', theme: 'Hearts find rest in the remembrance of Allah.', youtube: 'Surah Ar-Rad 28 tafsir explanation' },
  { ref: '39:53', theme: 'Allah forgives all sins — never despair of His mercy.', youtube: 'Surah Az-Zumar 53 tafsir explanation' },
  { ref: '65:3', theme: 'Whoever relies on Allah, He is sufficient for them.', youtube: 'Surah At-Talaq 3 tafsir explanation' },
  { ref: '21:87', theme: "Prophet Yunus's (Jonah's) dua from inside the whale — after which Allah saved him.", youtube: 'story of Prophet Yunus and the whale Quran' },
  { ref: '12:87', theme: "From the story of Prophet Yusuf (Joseph) — his father's reminder not to lose hope in Allah's mercy.", youtube: 'story of Prophet Yusuf Quran explained' },
  { ref: '20:25', theme: "Prophet Musa's (Moses') dua for ease before confronting Pharaoh.", youtube: 'story of Prophet Musa and Pharaoh Quran' },
  { ref: '18:10', theme: 'The dua of the young men who took refuge in the cave (Ashab al-Kahf).', youtube: 'story of the People of the Cave Ashab al Kahf Quran' },
  { ref: '9:40', theme: "The Hijra cave story — the Prophet ﷺ and Abu Bakr, and Allah's promise of aid.", youtube: 'story of the cave Hijra Prophet Muhammad Abu Bakr' },
  { ref: '3:139', theme: 'A call not to weaken or grieve — believers are honored when faith is firm.', youtube: 'Surah Al Imran 139 tafsir explanation' },
  { ref: '94:1', theme: 'Allah reminds the Prophet ﷺ of the expansion and relief given to his heart.', youtube: 'Surah Ash-Sharh Al-Inshirah explanation' },
  { ref: '2:216', theme: "You may dislike a thing which is good for you — trusting Allah's plan.", youtube: 'Surah Al-Baqarah 216 tafsir explanation' },
  { ref: '55:13', theme: "The refrain of Surah Ar-Rahman — counting Allah's countless favors.", youtube: 'Surah Ar-Rahman explained favors' },
  { ref: '16:97', theme: 'Righteous deeds, by male or female, are rewarded with a good life.', youtube: 'Surah An-Nahl 97 tafsir explanation' },
  { ref: '3:26', theme: 'Recognizing Allah as the sole owner of all sovereignty.', youtube: 'Surah Al Imran 26 tafsir explanation' },
  { ref: '17:23', theme: 'A command of kindness and mercy toward parents.', youtube: 'Surah Al-Isra 23 tafsir kindness to parents' },
  { ref: '49:13', theme: 'Humanity made into nations and tribes to know one another — nobility is in righteousness.', youtube: 'Surah Al-Hujurat 13 tafsir explanation' },
  { ref: '2:153', theme: 'Seeking help through patience and prayer.', youtube: 'Surah Al-Baqarah 153 patience and prayer' },
  { ref: '24:35', theme: 'Ayat an-Nur — Allah described as the Light of the heavens and the earth.', youtube: 'Ayat an Nur verse of light explained' }
];

async function getAyahText(ref) {
  const [arRes, enRes] = await Promise.all([
    fetch(`https://api.alquran.cloud/v1/ayah/${ref}/quran-uthmani`),
    fetch(`https://api.alquran.cloud/v1/ayah/${ref}/en.asad`)
  ]);
  const ar = await arRes.json();
  const en = await enRes.json();
  return { arabic: ar.data, translation: en.data };
}

async function renderAyahOfTheDay() {
  const idx = dayOfYear(new Date()) % DAILY_AYAHS.length;
  const entry = DAILY_AYAHS[idx];
  try {
    const { arabic, translation } = await getAyahText(entry.ref);
    $('quote-arabic').textContent = stripBismillah(arabic.text, arabic.surah.number, arabic.numberInSurah);
    $('quote-translation').textContent = translation.text;
    $('quote-reference').textContent =
      `Surah ${arabic.surah.englishName} (${arabic.surah.name}) — Ayah ${arabic.numberInSurah}`;
    $('quote-story').textContent = entry.theme;
    const ytLink = $('quote-youtube-link');
    ytLink.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(entry.youtube)}`;
    ytLink.hidden = false;
  } catch (e) {
    $('quote-arabic').textContent = '';
    $('quote-translation').textContent = "Could not load today's ayah — check your internet connection.";
    $('quote-reference').textContent = '';
    $('quote-story').textContent = '';
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
      card.append(el('div', 'sc-meta', `${s.numberOfAyahs} verses · ${s.revelationType}`));
      if (st.learnedOn) card.append(el('span', 'chip chip-done', '✓ Learned'));
      else if (st.listenSeconds > 0) card.append(el('span', 'chip', 'Practicing'));
      card.addEventListener('click', () => openSurah(s.number));
      container.appendChild(card);
    });
    if (!container.children.length) container.append(el('p', 'muted', 'No surah matches that search.'));
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
  $('learn-surah-meta').textContent = meta ? `${meta.numberOfAyahs} verses · ${meta.revelationType}` : '';

  // About: plain-English summary, then the reflection questions.
  let info = null;
  try { info = await getSurahInfo(n); } catch (e) { /* shown as fallback text below */ }
  if (token !== renderToken) return;
  $('about-summary').textContent = info ? info.summary : 'The summary could not be loaded. Check your connection and try again.';
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
    note.textContent = 'Simple explanations for each verse are not written for this surah yet. Use the summary above and the translation below.';
  }
  list.innerHTML = '';
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
    list.appendChild(item);
  });
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
    : 'Press play. Your practice time and repeats will be counted here.';
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
    note.textContent = `Listened ${Math.round(listenedSeconds)}s of ${Math.round(recordingDuration)}s (${pct}%). Listen to the whole thing to unlock the confirmation.`;
  };

  const checkUnlock = () => {
    if (recordingDuration > 0 && listenedSeconds >= recordingDuration * 0.9) {
      $('recitation-confirm-checkbox').disabled = false;
      $('recitation-listen-note').textContent = '✓ Full recording heard. You can confirm below.';
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
      alert('Microphone access is needed to record your recitation. Please allow microphone permission and try again.');
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
    ? `🎉 Goal reached: ${thisMonth} learned this month`
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
    if (!confirm('Erase all your notes, wins and practice time from this phone? This cannot be undone.')) return;
    Object.values(LS).forEach(k => localStorage.removeItem(k));
    OLD_KEYS.forEach(k => localStorage.removeItem(k));
    $('audio-player').pause();
    $('audio-player').removeAttribute('src');
    delete $('audio-player').dataset.surah;
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
      alert('Could not access the microphone. Check that this site has microphone permission in your browser/phone settings.');
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
  migrateOldData();
  initTabs();
  initSurahSearch();
  initStudyActions();
  initWinsActions();
  initSettingsActions();
  renderStudy();
  renderSurahGrid();
  renderAyahOfTheDay();
});
