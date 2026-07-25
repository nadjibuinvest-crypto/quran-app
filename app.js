// ---------- Constants & State ----------
const LS_KEYS = {
  plan: 'qa_plan',
  completed: 'qa_completed',
  reciter: 'qa_reciter',
  monthlyGoal: 'qa_monthly_goal'
};

const DAY_MS = 24 * 60 * 60 * 1000;

let surahListCache = null;
let currentSurahData = null; // { arabic, translation } for the surah currently in Learn tab
let currentDayRange = null;  // { from, to } ayah range for today's focus
let quizState = { questions: [], index: 0, correctCount: 0 };

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
function daysSince(dateStr) {
  const start = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const diff = Math.floor((new Date(now.toDateString()) - new Date(start.toDateString())) / DAY_MS);
  return diff;
}

// ---------- Tabs ----------
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.getElementById('btn-goto-surahs').addEventListener('click', () => switchTab('surahs'));
}
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (tab === 'progress') renderProgressTab();
}

// ---------- Surah data (alquran.cloud) ----------
async function getSurahList() {
  if (surahListCache) return surahListCache;
  const res = await fetch('https://api.alquran.cloud/v1/surah');
  const data = await res.json();
  surahListCache = data.data; // array of 114
  return surahListCache;
}

async function getSurahText(number) {
  const [arRes, enRes] = await Promise.all([
    fetch(`https://api.alquran.cloud/v1/surah/${number}/quran-uthmani`),
    fetch(`https://api.alquran.cloud/v1/surah/${number}/en.asad`)
  ]);
  const ar = await arRes.json();
  const en = await enRes.json();
  return { arabic: ar.data, translation: en.data };
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
  { ref: '2:216', theme: 'You may dislike a thing which is good for you — trusting Allah\'s plan.', youtube: 'Surah Al-Baqarah 216 tafsir explanation' },
  { ref: '55:13', theme: 'The refrain of Surah Ar-Rahman — counting Allah\'s countless favors.', youtube: 'Surah Ar-Rahman explained favors' },
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
    document.getElementById('quote-arabic').textContent = arabic.text;
    document.getElementById('quote-translation').textContent = translation.text;
    document.getElementById('quote-reference').textContent =
      `Surah ${arabic.surah.englishName} (${arabic.surah.name}) — Ayah ${arabic.numberInSurah}`;
    document.getElementById('quote-story').textContent = entry.theme;
    const ytLink = document.getElementById('quote-youtube-link');
    ytLink.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(entry.youtube)}`;
    ytLink.hidden = false;
  } catch (e) {
    document.getElementById('quote-arabic').textContent = '';
    document.getElementById('quote-translation').textContent = 'Could not load today\'s ayah — check your internet connection.';
    document.getElementById('quote-reference').textContent = '';
    document.getElementById('quote-story').textContent = '';
  }
}

// ---------- All Surahs Tab ----------
async function renderSurahsTab() {
  const container = document.getElementById('surah-list');
  try {
    const list = await getSurahList();
    const plan = loadJSON(LS_KEYS.plan, null);
    container.innerHTML = '';
    list.forEach(s => {
      const card = document.createElement('div');
      card.className = 'surah-card' + (plan && plan.number === s.number ? ' current' : '');
      card.innerHTML = `
        <div class="sc-top"><span class="sc-num">#${s.number}</span><span class="sc-arabic">${s.name}</span></div>
        <div class="sc-name">${s.englishName}</div>
        <div class="muted">${s.englishNameTranslation}</div>
        <div class="sc-meta">${s.numberOfAyahs} verses · ${s.revelationType}</div>
      `;
      card.addEventListener('click', () => startSurahPlan(s));
      container.appendChild(card);
    });
    document.getElementById('surah-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      container.querySelectorAll('.surah-card').forEach((card, i) => {
        const s = list[i];
        const match = s.englishName.toLowerCase().includes(q) ||
          s.englishNameTranslation.toLowerCase().includes(q) ||
          String(s.number).includes(q);
        card.style.display = match ? '' : 'none';
      });
    });
  } catch (e) {
    container.innerHTML = '<p class="muted">Could not load surah list. Check your internet connection.</p>';
  }
}

function startSurahPlan(surah) {
  const plan = {
    number: surah.number,
    englishName: surah.englishName,
    englishNameTranslation: surah.englishNameTranslation,
    arabicName: surah.name,
    numberOfAyahs: surah.numberOfAyahs,
    revelationType: surah.revelationType,
    startDate: todayStr(),
    practicedDays: [],
    quizDays: [],
    recitationConfirmed: false
  };
  saveJSON(LS_KEYS.plan, plan);
  switchTab('learn');
  renderLearnTab();
}

// ---------- Learn Tab ----------
function buildDayPlan(numberOfAyahs) {
  const learnDays = Math.min(7, numberOfAyahs);
  const chunkSize = Math.ceil(numberOfAyahs / learnDays);
  const days = [];
  for (let d = 1; d <= learnDays; d++) {
    const startAyah = (d - 1) * chunkSize + 1;
    const endAyah = Math.min(d * chunkSize, numberOfAyahs);
    days.push({ day: d, phase: 'learn', from: startAyah, to: endAyah });
  }
  for (let d = learnDays + 1; d <= 14; d++) {
    days.push({ day: d, phase: 'review', from: 1, to: numberOfAyahs });
  }
  return days;
}

async function renderLearnTab() {
  const plan = loadJSON(LS_KEYS.plan, null);
  const emptyState = document.getElementById('no-surah-selected');
  const content = document.getElementById('learn-content');

  if (!plan) {
    emptyState.hidden = false;
    content.hidden = true;
    return;
  }
  emptyState.hidden = true;
  content.hidden = false;

  const rawDay = daysSince(plan.startDate) + 1;
  const dayNumber = Math.max(1, Math.min(14, rawDay));

  document.getElementById('learn-surah-name').textContent = `${plan.number}. ${plan.englishName} — ${plan.englishNameTranslation}`;
  document.getElementById('learn-surah-arabic').textContent = plan.arabicName;
  document.getElementById('learn-surah-meta').textContent = `${plan.numberOfAyahs} verses · ${plan.revelationType}`;
  document.getElementById('day-number').textContent = dayNumber;
  document.getElementById('progress-fill').style.width = `${(dayNumber / 14) * 100}%`;
  document.getElementById('streak-count').textContent = (plan.practicedDays || []).length;

  const dayPlan = buildDayPlan(plan.numberOfAyahs);
  const today = dayPlan.find(d => d.day === dayNumber) || dayPlan[dayPlan.length - 1];
  currentDayRange = { from: today.from, to: today.to };
  document.getElementById('phase-label').textContent = today.phase === 'learn' ? 'Learning phase' : 'Review phase';

  const focusText = today.phase === 'learn'
    ? `Focus on verses ${today.from}–${today.to} today. Read them slowly, listen to the recitation, and repeat each verse a few times.`
    : `Review the full surah (verses 1–${plan.numberOfAyahs}) today to reinforce what you've learned.`;
  document.getElementById('today-focus-text').textContent = focusText;

  const finishBtn = document.getElementById('btn-finish-surah');
  const finishHelper = document.getElementById('finish-helper');
  const recitationCard = document.getElementById('recitation-card');
  finishBtn.hidden = dayNumber < 14;
  recitationCard.hidden = dayNumber < 14;
  if (dayNumber >= 14) {
    const confirmed = !!plan.recitationConfirmed;
    finishBtn.disabled = !confirmed;
    finishHelper.textContent = confirmed ? '' : 'Complete the recitation check below to unlock this.';
    document.getElementById('recitation-confirm-checkbox').checked = confirmed;
    resetRecitationUI();
  }

  refreshPracticeUI();

  // Pace warning: flag if practiced days are meaningfully behind elapsed cycle days.
  const paceWarning = document.getElementById('pace-warning');
  const practicedCount = (plan.practicedDays || []).length;
  if (dayNumber >= 4 && practicedCount < dayNumber - 3) {
    paceWarning.hidden = false;
    paceWarning.textContent = `You've practiced ${practicedCount} of ${dayNumber} days so far — pick up the pace or this surah won't be locked in by day 14.`;
  } else {
    paceWarning.hidden = true;
  }

  // Audio links
  const reciter = localStorage.getItem(LS_KEYS.reciter) || 'Mishary Alafasy';
  const query = encodeURIComponent(`${plan.englishName} Surah ${reciter} full recitation`);
  document.getElementById('link-youtube').href = `https://www.youtube.com/results?search_query=${query}`;
  document.getElementById('link-spotify').href = `https://open.spotify.com/search/${query}`;

  const ytEmbed = document.getElementById('youtube-embed');
  const ytWrap = document.getElementById('youtube-embed-wrap');
  ytEmbed.src = `https://www.youtube.com/embed?listType=search&list=${query}`;
  ytWrap.hidden = false;

  // Verses
  const versesList = document.getElementById('verses-list');
  versesList.innerHTML = '<p class="muted">Loading verses…</p>';
  try {
    const { arabic, translation } = await getSurahText(plan.number);
    currentSurahData = { arabic, translation };
    versesList.innerHTML = '';
    arabic.ayahs.forEach((ayah, i) => {
      const inRange = ayah.numberInSurah >= today.from && ayah.numberInSurah <= today.to;
      const item = document.createElement('div');
      item.className = 'verse-item' + (inRange ? ' today-verse' : '');
      item.innerHTML = `
        <span class="verse-num">Ayah ${ayah.numberInSurah}</span>
        <div class="verse-arabic">${ayah.text}</div>
        <div class="verse-translation">${translation.ayahs[i].text}</div>
      `;
      versesList.appendChild(item);
    });
  } catch (e) {
    currentSurahData = null;
    versesList.innerHTML = '<p class="muted">Could not load verse text. Check your internet connection.</p>';
  }

  renderQuizIdle();

  // Audio player (per-ayah recitation, Alafasy edition, direct mp3s via CDN)
  const audioPlayer = document.getElementById('audio-player');
  document.getElementById('btn-play-audio').onclick = () => {
    audioPlayer.hidden = false;
    audioPlayer.src = `https://cdn.islamic.network/quran/audio-surah/128/ar.alafasy/${plan.number}.mp3`;
    audioPlayer.play().catch(() => {});
  };

  document.getElementById('settings-current-plan').textContent =
    `${plan.englishName} — Day ${dayNumber} of 14 (started ${plan.startDate})`;
}

function initLearnActions() {
  document.getElementById('btn-mark-today').addEventListener('click', () => {
    const plan = loadJSON(LS_KEYS.plan, null);
    if (!plan) return;
    const t = todayStr();
    const quizDoneToday = (plan.quizDays || []).includes(t);
    if (!quizDoneToday) return; // gated behind today's recall check
    plan.practicedDays = plan.practicedDays || [];
    if (!plan.practicedDays.includes(t)) plan.practicedDays.push(t);
    saveJSON(LS_KEYS.plan, plan);
    refreshPracticeUI();
  });

  document.getElementById('btn-finish-surah').addEventListener('click', () => {
    const plan = loadJSON(LS_KEYS.plan, null);
    if (!plan) return;
    if (!plan.recitationConfirmed) return; // gated behind the recitation check
    const completed = loadJSON(LS_KEYS.completed, []);
    completed.push({ number: plan.number, englishName: plan.englishName, finishedOn: todayStr() });
    saveJSON(LS_KEYS.completed, completed);
    localStorage.removeItem(LS_KEYS.plan);
    renderLearnTab();
    updateSettingsSummary();
    switchTab('surahs');
    renderSurahsTab();
  });

  initRecitationActions();
}

// ---------- Accountability: recitation-check gate (day 14) ----------
// No browser on iOS supports real speech-to-text (Apple doesn't ship the Web
// Speech API to any iOS browser engine), so there is no reliable way to
// auto-grade recitation accuracy client-side. Instead, this enforces that the
// full recording is actually listened to — not just skipped to the end —
// before the confirmation checkbox unlocks.
let mediaRecorder = null;
let recordedChunks = [];
let recordingDuration = 0;
let listenedSeconds = 0;
let listenTickInterval = null;
let lastTickTime = null;

function resetRecitationUI() {
  const audioEl = document.getElementById('recitation-audio');
  const recordBtn = document.getElementById('btn-record-recitation');
  const listenNote = document.getElementById('recitation-listen-note');
  const checkbox = document.getElementById('recitation-confirm-checkbox');
  audioEl.hidden = true;
  audioEl.removeAttribute('src');
  recordBtn.textContent = '🎙️ Start Recording';
  recordBtn.disabled = false;
  listenNote.hidden = true;
  listenNote.textContent = '';
  recordingDuration = 0;
  listenedSeconds = 0;
  clearInterval(listenTickInterval);
  const plan = loadJSON(LS_KEYS.plan, null);
  if (!plan || !plan.recitationConfirmed) checkbox.disabled = true;
}

// Attaches listen-progress tracking to the recitation audio element exactly
// once. recordingDuration/listenedSeconds are module-level state reset on
// each new recording, so the same listeners work across "Record Again" cycles
// without piling up duplicate handlers on the persistent DOM node.
function attachListenTracking(audio) {
  const updateNote = () => {
    const listenNote = document.getElementById('recitation-listen-note');
    if (!recordingDuration) return;
    listenNote.hidden = false;
    const pct = Math.min(100, Math.round((listenedSeconds / recordingDuration) * 100));
    listenNote.textContent = `Listened ${Math.round(listenedSeconds)}s of ${Math.round(recordingDuration)}s (${pct}%) — listen to the whole thing to unlock confirmation.`;
  };

  const checkUnlock = () => {
    if (recordingDuration > 0 && listenedSeconds >= recordingDuration * 0.9) {
      document.getElementById('recitation-confirm-checkbox').disabled = false;
      document.getElementById('recitation-listen-note').textContent = '✓ Full recording heard — you can confirm below.';
    }
  };

  audio.addEventListener('loadedmetadata', () => {
    if (!isFinite(audio.duration)) {
      // Blob-recorded audio sometimes reports Infinity duration until forced to seek.
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

function initRecitationActions() {
  const recordBtn = document.getElementById('btn-record-recitation');
  const audioEl = document.getElementById('recitation-audio');
  const checkbox = document.getElementById('recitation-confirm-checkbox');
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
        recordingDuration = 0;
        listenedSeconds = 0;
        const blob = new Blob(recordedChunks, { type: 'audio/webm' });
        audioEl.src = URL.createObjectURL(blob);
        audioEl.hidden = false;
        stream.getTracks().forEach(t => t.stop());
        recordBtn.textContent = '🎙️ Record Again';
        recordBtn.disabled = false;
        checkbox.disabled = true;
        checkbox.checked = false;
        const plan = loadJSON(LS_KEYS.plan, null);
        if (plan) {
          plan.recitationConfirmed = false;
          saveJSON(LS_KEYS.plan, plan);
          document.getElementById('btn-finish-surah').disabled = true;
          document.getElementById('finish-helper').textContent = 'Complete the recitation check below to unlock this.';
        }
      };
      mediaRecorder.start();
      recordBtn.textContent = '⏹ Stop Recording';
    } catch (e) {
      recordBtn.textContent = '🎙️ Start Recording';
      alert('Microphone access is needed to record your recitation. Please allow microphone permission and try again.');
    }
  });

  checkbox.addEventListener('change', () => {
    const plan = loadJSON(LS_KEYS.plan, null);
    if (!plan) return;
    plan.recitationConfirmed = checkbox.checked;
    saveJSON(LS_KEYS.plan, plan);
    const finishBtn = document.getElementById('btn-finish-surah');
    const finishHelper = document.getElementById('finish-helper');
    finishBtn.disabled = !checkbox.checked;
    finishHelper.textContent = checkbox.checked ? '' : 'Complete the recitation check below to unlock this.';
  });
}

// ---------- Accountability: recall-check gate & pace tracking ----------
function refreshPracticeUI() {
  const plan = loadJSON(LS_KEYS.plan, null);
  if (!plan) return;
  const t = todayStr();
  const quizDoneToday = (plan.quizDays || []).includes(t);
  const alreadyPracticedToday = (plan.practicedDays || []).includes(t);
  const btn = document.getElementById('btn-mark-today');
  const helper = document.getElementById('mark-practiced-helper');

  if (alreadyPracticedToday) {
    btn.textContent = '✓ Practiced today';
    btn.disabled = true;
    helper.textContent = '';
  } else if (!quizDoneToday) {
    btn.textContent = '✓ Mark today practiced';
    btn.disabled = true;
    helper.textContent = "Complete today's recall check above to unlock this.";
  } else {
    btn.textContent = '✓ Mark today practiced';
    btn.disabled = false;
    helper.textContent = '';
  }
  document.getElementById('streak-count').textContent = (plan.practicedDays || []).length;
}

function buildQuizQuestions(count) {
  if (!currentSurahData || !currentDayRange) return [];
  const { arabic, translation } = currentSurahData;
  const rangeAyahs = arabic.ayahs.filter(a => a.numberInSurah >= currentDayRange.from && a.numberInSurah <= currentDayRange.to);
  const pool = rangeAyahs.length ? rangeAyahs : arabic.ayahs;
  const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(count, pool.length));

  return picked.map(ayah => {
    const correctText = translation.ayahs.find(t => t.numberInSurah === ayah.numberInSurah).text;
    const otherTexts = translation.ayahs
      .filter(t => t.numberInSurah !== ayah.numberInSurah)
      .map(t => t.text)
      .sort(() => Math.random() - 0.5);
    const distractors = [];
    for (const txt of otherTexts) {
      if (distractors.length >= 2) break;
      if (txt !== correctText && !distractors.includes(txt)) distractors.push(txt);
    }
    const options = [correctText, ...distractors].sort(() => Math.random() - 0.5);
    return { ayahNum: ayah.numberInSurah, arabicText: ayah.text, correctText, options };
  });
}

function renderQuizIdle() {
  const plan = loadJSON(LS_KEYS.plan, null);
  const quizArea = document.getElementById('quiz-area');
  if (!plan || !quizArea) return;
  const doneToday = (plan.quizDays || []).includes(todayStr());
  quizArea.innerHTML = `
    <button id="btn-start-quiz" class="btn secondary">▶ ${doneToday ? 'Retake' : 'Start'} Recall Check</button>
    ${doneToday ? '<p class="muted" style="margin-top:8px;">✓ Already completed today — feel free to retake for extra practice.</p>' : ''}
  `;
  document.getElementById('btn-start-quiz').addEventListener('click', startQuiz);
}

function startQuiz() {
  const quizArea = document.getElementById('quiz-area');
  const questions = buildQuizQuestions(5);
  if (!questions.length) {
    quizArea.innerHTML = '<p class="muted">Verses are still loading — try again in a moment.</p>';
    return;
  }
  quizState = { questions, index: 0, correctCount: 0 };
  showQuizQuestion();
}

function showQuizQuestion() {
  const quizArea = document.getElementById('quiz-area');
  const q = quizState.questions[quizState.index];
  quizArea.innerHTML = `
    <p class="muted">Question ${quizState.index + 1} of ${quizState.questions.length} — Ayah ${q.ayahNum}</p>
    <div class="quiz-arabic">${q.arabicText}</div>
    <p class="muted">Which translation matches this verse?</p>
    <div class="quiz-options">
      ${q.options.map((opt, i) => `<button class="btn ghost quiz-option" data-idx="${i}">${opt}</button>`).join('')}
    </div>
    <p id="quiz-feedback" class="quiz-feedback"></p>
  `;
  quizArea.querySelectorAll('.quiz-option').forEach(btn => {
    btn.addEventListener('click', () => handleQuizAnswer(btn, q));
  });
}

function handleQuizAnswer(btn, q) {
  const quizArea = document.getElementById('quiz-area');
  const feedback = document.getElementById('quiz-feedback');
  quizArea.querySelectorAll('.quiz-option').forEach(b => { b.disabled = true; });

  if (btn.textContent === q.correctText) {
    btn.style.borderColor = 'var(--accent)';
    feedback.textContent = '✓ Correct!';
    feedback.style.color = 'var(--accent)';
    quizState.correctCount++;
  } else {
    btn.style.borderColor = 'var(--danger)';
    feedback.textContent = `✗ Not quite — correct answer: "${q.correctText}"`;
    feedback.style.color = 'var(--danger)';
  }

  setTimeout(() => {
    quizState.index++;
    if (quizState.index < quizState.questions.length) {
      showQuizQuestion();
    } else {
      finishQuiz();
    }
  }, 1500);
}

function finishQuiz() {
  const quizArea = document.getElementById('quiz-area');
  const plan = loadJSON(LS_KEYS.plan, null);
  if (plan) {
    plan.quizDays = plan.quizDays || [];
    const t = todayStr();
    if (!plan.quizDays.includes(t)) plan.quizDays.push(t);
    saveJSON(LS_KEYS.plan, plan);
  }
  quizArea.innerHTML = `
    <p class="quiz-result">You got ${quizState.correctCount} / ${quizState.questions.length} correct.</p>
    <button id="btn-retry-quiz" class="btn ghost">↻ Try again</button>
  `;
  document.getElementById('btn-retry-quiz').addEventListener('click', startQuiz);
  refreshPracticeUI();
}

// ---------- Progress Tab ----------
function renderProgressTab() {
  const completed = loadJSON(LS_KEYS.completed, []);
  const goal = parseInt(localStorage.getItem(LS_KEYS.monthlyGoal) || '1', 10);
  document.getElementById('monthly-goal-select').value = String(goal);

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thisMonthCompleted = completed.filter(c => c.finishedOn.startsWith(monthKey));
  const count = thisMonthCompleted.length;

  document.getElementById('month-progress-fill').style.width = `${Math.min(100, (count / goal) * 100)}%`;
  document.getElementById('month-progress-text').textContent = `${count} of ${goal} surah${goal > 1 ? 's' : ''} finished this month.`;

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysRemaining = daysInMonth - dayOfMonth;
  const stillNeeded = Math.max(0, goal - count);
  const daysNeeded = stillNeeded * 14;

  const paceEl = document.getElementById('month-pace-text');
  if (stillNeeded === 0) {
    paceEl.textContent = '🎉 Monthly goal met!';
    paceEl.className = 'pace-status on-track';
  } else if (daysNeeded <= daysRemaining) {
    paceEl.textContent = `On track — you need ${stillNeeded} more surah${stillNeeded > 1 ? 's' : ''} and have ${daysRemaining} days left this month.`;
    paceEl.className = 'pace-status on-track';
  } else {
    paceEl.textContent = `Behind pace — you need ${stillNeeded} more surah${stillNeeded > 1 ? 's' : ''} (~${daysNeeded} days of consistent practice) but only ${daysRemaining} days remain this month.`;
    paceEl.className = 'pace-status behind';
  }

  const plan = loadJSON(LS_KEYS.plan, null);
  const cycleText = document.getElementById('progress-cycle-text');
  if (plan) {
    const dayNumber = Math.max(1, Math.min(14, daysSince(plan.startDate) + 1));
    const practicedCount = (plan.practicedDays || []).length;
    const quizCount = (plan.quizDays || []).length;
    cycleText.textContent = `${plan.englishName}: Day ${dayNumber} of 14 — practiced ${practicedCount} days, completed ${quizCount} recall checks so far.`;
  } else {
    cycleText.textContent = 'No surah in progress — start one from "All Surahs".';
  }

  const listEl = document.getElementById('completed-list');
  if (!completed.length) {
    listEl.innerHTML = '<p class="muted">No surahs completed yet.</p>';
  } else {
    listEl.innerHTML = [...completed].reverse().map(c =>
      `<div class="completed-row"><span>${c.number}. ${c.englishName}</span><span class="muted">${c.finishedOn}</span></div>`
    ).join('');
  }
}

function initProgressActions() {
  document.getElementById('monthly-goal-select').addEventListener('change', (e) => {
    localStorage.setItem(LS_KEYS.monthlyGoal, e.target.value);
    renderProgressTab();
  });
}

// ---------- Settings Tab ----------
function updateSettingsSummary() {
  const plan = loadJSON(LS_KEYS.plan, null);
  document.getElementById('settings-current-plan').textContent = plan
    ? `${plan.englishName} — started ${plan.startDate}`
    : 'No surah in progress';
  const completed = loadJSON(LS_KEYS.completed, []);
  document.getElementById('settings-completed-count').textContent = `${completed.length} completed`;

  const dateInput = document.getElementById('settings-start-date');
  const saveBtn = document.getElementById('btn-save-start-date');
  if (plan) {
    dateInput.value = plan.startDate;
    dateInput.disabled = false;
    saveBtn.disabled = false;
  } else {
    dateInput.value = '';
    dateInput.disabled = true;
    saveBtn.disabled = true;
  }
}

function initSettingsActions() {
  const reciterSelect = document.getElementById('reciter-select');
  reciterSelect.value = localStorage.getItem(LS_KEYS.reciter) || 'Mishary Alafasy';
  reciterSelect.addEventListener('change', () => {
    localStorage.setItem(LS_KEYS.reciter, reciterSelect.value);
    renderLearnTab();
  });

  document.getElementById('btn-reset-plan').addEventListener('click', () => {
    if (confirm('Reset your current surah plan? This cannot be undone.')) {
      localStorage.removeItem(LS_KEYS.plan);
      renderLearnTab();
      updateSettingsSummary();
    }
  });

  document.getElementById('btn-save-start-date').addEventListener('click', () => {
    const plan = loadJSON(LS_KEYS.plan, null);
    const val = document.getElementById('settings-start-date').value;
    if (!plan || !val) return;
    plan.startDate = val;
    saveJSON(LS_KEYS.plan, plan);
    renderLearnTab();
    updateSettingsSummary();
  });
}

// ---------- Init ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initLearnActions();
  initSettingsActions();
  initProgressActions();
  renderLearnTab();
  renderSurahsTab();
  renderAyahOfTheDay();
  updateSettingsSummary();
});
