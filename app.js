// ---------- Constants & State ----------
const LS_KEYS = {
  plan: 'qa_plan',
  completed: 'qa_completed',
  location: 'qa_location',
  reciter: 'qa_reciter',
  masjids: 'qa_masjids',
  monthlyGoal: 'qa_monthly_goal'
};

const DAY_MS = 24 * 60 * 60 * 1000;

// lat/lon below are verified via OpenStreetMap/Nominatim where found; masjids
// without a match are left uncoordinated rather than guessed, and can be
// geocoded from a user-entered address in the Masjid Events tab.
const DEFAULT_MASJIDS = [
  { id: 'epic', name: 'East Plano Islamic Center (EPIC)', city: 'Plano', lat: 33.0098876, lon: -96.6467684 },
  { id: 'ianttx', name: 'Islamic Association of North Texas (Dallas Central Mosque)', city: 'Richardson' },
  { id: 'ici', name: 'Islamic Center of Irving (ICI)', city: 'Irving' },
  { id: 'vric', name: 'Valley Ranch Islamic Center (VRIC)', city: 'Irving', lat: 32.9172725, lon: -96.9478424 },
  { id: 'iacc', name: 'Islamic Association of Collin County (Plano Masjid)', city: 'Plano' },
  { id: 'icf', name: 'Islamic Center of Frisco', city: 'Frisco', lat: 33.1721923, lon: -96.8347665 },
  { id: 'iatc', name: 'Islamic Association of Tarrant County (Fort Worth Masjid)', city: 'Fort Worth' },
  { id: 'dfwic', name: 'Dallas-Fort Worth Islamic Center', city: 'Fort Worth' },
  { id: 'ica', name: 'Islamic Center of Arlington', city: 'Arlington' },
  { id: 'gpm', name: 'Grand Prairie Masjid (Islamic Services Foundation)', city: 'Grand Prairie' },
  { id: 'dmai', name: 'Dallas Masjid of Al-Islam', city: 'Downtown Dallas', lat: 32.7668737, lon: -96.7786768 },
  { id: 'icsd', name: 'Islamic Center of South Dallas (Masjid Al-Wali)', city: 'Dallas' },
  { id: 'iqra', name: 'IQRA Masjid (Islamic Center of Quad Cities)', city: 'Allen' },
  { id: 'mar', name: 'Masjid Al-Rahman (Islamic Association of Lewisville/Flower Mound)', city: 'Flower Mound', lat: 33.0354194, lon: -97.0830237 },
  { id: 'icm', name: 'Islamic Center of McKinney', city: 'McKinney' }
];

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
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeZip(zip) {
  const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
  if (!res.ok) throw new Error('ZIP not found');
  const data = await res.json();
  const place = data.places[0];
  return {
    lat: parseFloat(place.latitude),
    lon: parseFloat(place.longitude),
    zip,
    label: `${place['place name']}, ${place['state abbreviation']} ${zip}`
  };
}

async function geocodeAddress(query) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`);
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
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
  if (tab === 'prayer') renderPrayerTab();
  if (tab === 'progress') renderProgressTab();
  if (tab === 'masjids') renderMasjidsTab();
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
let mediaRecorder = null;
let recordedChunks = [];
let speechRecognizer = null;
let recognizedTranscript = '';

function resetRecitationUI() {
  const audioEl = document.getElementById('recitation-audio');
  const recordBtn = document.getElementById('btn-record-recitation');
  const scoreNote = document.getElementById('recitation-score-note');
  audioEl.hidden = true;
  audioEl.removeAttribute('src');
  recordBtn.textContent = '🎙️ Start Recording';
  recordBtn.disabled = false;
  scoreNote.hidden = true;
  scoreNote.textContent = '';
}

function normalizeArabic(text) {
  return (text || '')
    .replace(/[ً-ٟؐ-ؚۖ-ٰۭ]/g, '') // strip tashkeel
    .replace(/[آأإٱ]/g, 'ا') // normalize alef forms
    .replace(/ى/g, 'ي') // alef maksura -> ya
    .replace(/[^؀-ۿ\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTranscriptAgainstSurah(transcript) {
  if (!currentSurahData) return null;
  const fullText = currentSurahData.arabic.ayahs.map(a => a.text).join(' ');
  const surahWords = normalizeArabic(fullText).split(' ').filter(Boolean);
  const heardWords = new Set(normalizeArabic(transcript).split(' ').filter(Boolean));
  if (!surahWords.length) return null;
  const matched = surahWords.filter(w => heardWords.has(w)).length;
  return Math.round((matched / surahWords.length) * 100);
}

function initRecitationActions() {
  const recordBtn = document.getElementById('btn-record-recitation');
  const audioEl = document.getElementById('recitation-audio');
  const checkbox = document.getElementById('recitation-confirm-checkbox');
  const scoreNote = document.getElementById('recitation-score-note');

  recordBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      if (speechRecognizer) speechRecognizer.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      recognizedTranscript = '';
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'audio/webm' });
        audioEl.src = URL.createObjectURL(blob);
        audioEl.hidden = false;
        stream.getTracks().forEach(t => t.stop());
        recordBtn.textContent = '🎙️ Record Again';
        recordBtn.disabled = false;
        checkbox.disabled = false;

        if (recognizedTranscript) {
          const score = scoreTranscriptAgainstSurah(recognizedTranscript);
          if (score !== null) {
            scoreNote.hidden = false;
            scoreNote.textContent = `Best-effort speech match: ~${score}% of the surah's words were recognized. This is not a certified grade — trust your own listen-back over this number.`;
          }
        }
      };

      const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognitionCtor) {
        speechRecognizer = new SpeechRecognitionCtor();
        speechRecognizer.lang = 'ar-SA';
        speechRecognizer.continuous = true;
        speechRecognizer.interimResults = false;
        speechRecognizer.onresult = (e) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            recognizedTranscript += ' ' + e.results[i][0].transcript;
          }
        };
        speechRecognizer.onerror = () => {};
        try { speechRecognizer.start(); } catch (e) { speechRecognizer = null; }
      } else {
        speechRecognizer = null;
      }

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

// ---------- Prayer Times Tab ----------
async function renderPrayerTab() {
  const loc = loadJSON(LS_KEYS.location, null);
  const display = document.getElementById('location-display');
  const timesCard = document.getElementById('prayer-times-card');

  if (!loc) {
    display.textContent = 'No location set — trying to detect automatically…';
    tryAutoLocation();
    return;
  }
  display.textContent = loc.label || `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`;
  await loadPrayerTimes(loc);
  timesCard.hidden = false;
}

async function loadPrayerTimes(loc) {
  try {
    let url;
    if (loc.city) {
      url = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(loc.city)}&country=${encodeURIComponent(loc.country || '')}&method=2`;
    } else {
      url = `https://api.aladhan.com/v1/timings?latitude=${loc.lat}&longitude=${loc.lon}&method=2`;
    }
    const res = await fetch(url);
    const data = await res.json();
    const timings = data.data.timings;
    const tz = data.data.meta && data.data.meta.timezone;
    const order = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
    const grid = document.getElementById('prayer-grid');
    grid.innerHTML = '';

    // Compute "now" in the queried location's timezone, not the browser's.
    const nowLocal = tz
      ? new Date(new Date().toLocaleString('en-US', { timeZone: tz }))
      : new Date();
    let nextName = null, nextDiffMin = Infinity;
    order.forEach(name => {
      const [h, m] = timings[name].split(':').map(Number);
      const t = new Date(nowLocal);
      t.setHours(h, m, 0, 0);
      const diffMin = (t - nowLocal) / 60000;
      if (diffMin > 0 && diffMin < nextDiffMin) { nextDiffMin = diffMin; nextName = name; }
    });

    order.forEach(name => {
      const tile = document.createElement('div');
      tile.className = 'prayer-tile' + (name === nextName ? ' next' : '');
      tile.innerHTML = `<div class="p-name">${name}</div><div class="p-time">${timings[name]}</div>`;
      grid.appendChild(tile);
    });

    document.getElementById('prayer-date').textContent = data.data.date.readable;
    document.getElementById('next-prayer-line').textContent = nextName
      ? `Next: ${nextName} in about ${Math.round(nextDiffMin)} min`
      : `All prayers passed for today — Fajr is next, tomorrow.`;
    document.getElementById('prayer-times-card').hidden = false;
  } catch (e) {
    document.getElementById('prayer-times-card').hidden = true;
    document.getElementById('location-display').textContent = 'Could not load prayer times. Check your internet connection.';
  }
}

function tryAutoLocation() {
  if (!navigator.geolocation) {
    document.getElementById('location-display').textContent = 'Geolocation not supported — please type your city below.';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Your current location' };
      saveJSON(LS_KEYS.location, loc);
      renderPrayerTab();
    },
    () => {
      document.getElementById('location-display').textContent = 'Location permission denied — please type your city below.';
    },
    { timeout: 8000 }
  );
}

function initPrayerActions() {
  document.getElementById('btn-use-location').addEventListener('click', tryAutoLocation);
  document.getElementById('btn-set-zip').addEventListener('click', async () => {
    const zip = document.getElementById('manual-zip').value.trim();
    if (!zip) return;
    const display = document.getElementById('location-display');
    display.textContent = 'Looking up ZIP code…';
    try {
      const loc = await geocodeZip(zip);
      saveJSON(LS_KEYS.location, loc);
      renderPrayerTab();
      renderMasjidsTab();
    } catch (e) {
      display.textContent = 'Could not find that ZIP code — please check it and try again.';
    }
  });
}

// ---------- Masjid Events Tab ----------
const MASJID_RADIUS_MILES = 70;

function getMasjidEntry(stored, id) {
  const raw = stored[id];
  if (!raw) return { schedule: '', address: '', link: '' };
  if (typeof raw === 'string') return { schedule: raw, address: '', link: '' }; // legacy format
  return { schedule: raw.schedule || '', address: raw.address || '', link: raw.link || '', lat: raw.lat, lon: raw.lon };
}

function renderMasjidsTab() {
  const stored = loadJSON(LS_KEYS.masjids, {});
  const container = document.getElementById('masjid-list');
  const template = document.getElementById('masjid-card-template');
  const loc = loadJSON(LS_KEYS.location, null);
  const zipInput = document.getElementById('masjid-zip');
  const zipStatus = document.getElementById('masjid-zip-status');
  container.innerHTML = '';

  if (loc && loc.zip) zipInput.value = loc.zip;
  zipStatus.textContent = loc && loc.lat
    ? `Sorted by distance from ${loc.label || 'your location'}. Masjids over ${MASJID_RADIUS_MILES} miles away with a known address are hidden.`
    : 'Enter your ZIP code to sort by distance and filter to within 70 miles.';

  const withDist = DEFAULT_MASJIDS.map(m => {
    const entry = getMasjidEntry(stored, m.id);
    const lat = entry.lat ?? m.lat;
    const lon = entry.lon ?? m.lon;
    const dist = (loc && loc.lat && lat != null) ? haversineMiles(loc.lat, loc.lon, lat, lon) : null;
    return { m, entry, lat, lon, dist };
  }).filter(x => x.dist === null || x.dist <= MASJID_RADIUS_MILES)
    .sort((a, b) => {
      if (a.dist === null && b.dist === null) return 0;
      if (a.dist === null) return 1;
      if (b.dist === null) return -1;
      return a.dist - b.dist;
    });

  withDist.forEach(({ m, entry, lat, lon, dist }) => {
    const node = template.content.cloneNode(true);
    node.querySelector('.masjid-name').textContent = m.name;
    node.querySelector('.masjid-city').textContent = m.city + ', TX';
    node.querySelector('.masjid-distance').textContent = dist !== null ? ` · ${dist.toFixed(1)} mi away` : ' · distance unknown (add address)';

    const linkEl = node.querySelector('.masjid-link');
    if (entry.link) {
      linkEl.href = /^https?:\/\//.test(entry.link) ? entry.link : `https://${entry.link}`;
      linkEl.textContent = '🔗 ' + entry.link;
      linkEl.hidden = false;
    }

    const viewEl = node.querySelector('.masjid-schedule-view');
    const editEl = node.querySelector('.masjid-schedule-edit');
    const scheduleInput = node.querySelector('.masjid-schedule-input');
    const addressInput = node.querySelector('.masjid-address-input');
    const linkInput = node.querySelector('.masjid-link-input');
    viewEl.textContent = entry.schedule;
    scheduleInput.value = entry.schedule;
    addressInput.value = entry.address;
    linkInput.value = entry.link;

    node.querySelector('.btn-edit-masjid').addEventListener('click', () => {
      viewEl.hidden = true;
      editEl.hidden = false;
    });
    node.querySelector('.btn-cancel-masjid').addEventListener('click', () => {
      scheduleInput.value = entry.schedule;
      addressInput.value = entry.address;
      linkInput.value = entry.link;
      viewEl.hidden = false;
      editEl.hidden = true;
    });
    const saveBtn = node.querySelector('.btn-save-masjid');
    saveBtn.addEventListener('click', async () => {
      const newAddress = addressInput.value.trim();
      const all = loadJSON(LS_KEYS.masjids, {});
      const prev = getMasjidEntry(all, m.id);
      const updated = {
        schedule: scheduleInput.value.trim(),
        address: newAddress,
        link: linkInput.value.trim(),
        lat: prev.lat, lon: prev.lon
      };
      if (newAddress && newAddress !== prev.address) {
        saveBtn.textContent = 'Looking up address…';
        saveBtn.disabled = true;
        try {
          const coords = await geocodeAddress(`${newAddress}`);
          if (coords) { updated.lat = coords.lat; updated.lon = coords.lon; }
        } catch (e) { /* keep previous coords if lookup fails */ }
        saveBtn.textContent = 'Save';
        saveBtn.disabled = false;
      } else if (!newAddress) {
        updated.lat = undefined;
        updated.lon = undefined;
      }
      all[m.id] = updated;
      saveJSON(LS_KEYS.masjids, all);
      renderMasjidsTab();
    });

    container.appendChild(node);
  });
}

function initMasjidActions() {
  document.getElementById('btn-masjid-zip').addEventListener('click', async () => {
    const zip = document.getElementById('masjid-zip').value.trim();
    if (!zip) return;
    const status = document.getElementById('masjid-zip-status');
    status.textContent = 'Looking up ZIP code…';
    try {
      const loc = await geocodeZip(zip);
      saveJSON(LS_KEYS.location, loc);
      renderMasjidsTab();
    } catch (e) {
      status.textContent = 'Could not find that ZIP code — please check it and try again.';
    }
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
  initPrayerActions();
  initSettingsActions();
  initProgressActions();
  initMasjidActions();
  renderLearnTab();
  renderSurahsTab();
  renderMasjidsTab();
  updateSettingsSummary();
  tryAutoLocation();
});
