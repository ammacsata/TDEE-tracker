// nutritracker v1.20 — app.js
const LS_CREDS = 'nutritracker_creds';
const LS_SESSION = 'nutritracker_session';
const SUPA_URL = 'https://whdamcifxsjfmnzgdrxe.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndoZGFtY2lmeHNqZm1uemdkcnhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0NTIyMjUsImV4cCI6MjA5NDAyODIyNX0.w6NlBPQ8Fru36r0VOf0jmcty2Ex4YCt7yEHKYC9VBNA';

let meals = [], pendingMeals = null, pendingDescription = null;
let goals = { cal: 2000, prot: 150, carbs: 200, fat: 65, fiber: 25 };
let memoryNotes = '', noteInputVisible = false, viewDate = new Date();
let favorites = [], weightLog = [], exerciseLog = [], recipes = [], calibrationNotes = [];
let supaReady = false, undoStack = null, undoTimer = null;
let editingMealId = null, editForDate = null, editReplacingId = null;
let currentUser = null, authToken = null;
let compareMode = 'week', trendRange = 7;

// ─── SUPABASE HELPERS ───
function supaUrl() { return SUPA_URL; }
function supaKey_() { return SUPA_KEY; }

const SUPA_TIMEOUT = 8000;
let offlineQueue = [];

async function supa(table, method, opts = {}, retried = false) {
  let endpoint = `${supaUrl()}/rest/v1/${table}`;
  if (opts.query) endpoint += '?' + opts.query;
  const token = authToken || supaKey_();
  const headers = {
    'apikey': supaKey_(),
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json'
  };
  if (method === 'POST') headers['Prefer'] = 'return=representation';
  if (method === 'PATCH') headers['Prefer'] = 'return=representation';
  const fetchOpts = { method, headers };
  if (opts.body) {
    if (currentUser && (method === 'POST')) opts.body.user_id = currentUser.id;
    fetchOpts.body = JSON.stringify(opts.body);
  }
  const controller = new AbortController();
  fetchOpts.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), SUPA_TIMEOUT);
  try {
    const res = await fetch(endpoint, fetchOpts);
    clearTimeout(timer);
    if (res.status === 401 && !retried) {
      // Token expired — try to refresh and retry once
      logError('auth', '401 received, attempting token refresh');
      const refreshed = await refreshSession();
      if (refreshed) {
        // Remove user_id from body since it'll be re-added on retry
        if (opts.body) delete opts.body.user_id;
        return supa(table, method, opts, true);
      } else {
        // Refresh failed — force re-login
        document.getElementById('authOverlay').style.display = '';
        throw new Error('Session expired — please sign in again');
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Supabase error: ' + res.status);
    }
    if (method === 'DELETE') return null;
    return res.json();
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      logError('timeout', `${method} ${table} timed out`);
      throw new Error('Connection timed out');
    }
    if (!navigator.onLine && method !== 'GET') {
      offlineQueue.push({ table, method, opts });
      logError('offline', `Queued ${method} ${table}`);
    }
    throw e;
  }
}

window.addEventListener('online', async () => {
  if (offlineQueue.length === 0) return;
  setSyncStatus('busy', 'syncing queued…');
  const queue = [...offlineQueue];
  offlineQueue = [];
  for (const op of queue) { try { await supa(op.table, op.method, op.opts); } catch(e) { logError('flush', e.message); } }
  setSyncStatus('ok', 'synced');
});

let errorLog = [];
function logError(type, msg) {
  errorLog.push({ time: new Date().toISOString(), type, msg });
  if (errorLog.length > 100) errorLog = errorLog.slice(-50);
  console.error(`[nutritracker:${type}]`, msg);
}

// ─── AUTH ───
async function supaAuth(endpoint, body) {
  const res = await fetch(`${supaUrl()}/auth/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'apikey': supaKey_(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.error?.message || err.msg || err.message || 'Authentication failed');
  }
  const data = await res.json();
  return data;
}

async function signUp() {
  const email = document.getElementById('authEmail').value.trim();
  const pw = document.getElementById('authPw').value;
  if (!email || !pw) return;
  const btn = document.getElementById('authBtn');
  btn.disabled = true;
  document.getElementById('authError').classList.remove('show');
  try {
    const data = await supaAuth('signup', { email, password: pw });
    if (data.access_token) {
      await handleAuthSuccess(data);
    } else if (data.id) {
      // Signup succeeded but no session — try signing in
      await signIn();
    }
  } catch(e) {
    document.getElementById('authError').textContent = e.message;
    document.getElementById('authError').classList.add('show');
  } finally { btn.disabled = false; }
}

async function signIn() {
  const email = document.getElementById('authEmail').value.trim();
  const pw = document.getElementById('authPw').value;
  if (!email || !pw) return;
  const btn = document.getElementById('authBtn');
  btn.disabled = true;
  document.getElementById('authError').classList.remove('show');
  try {
    const data = await supaAuth('token?grant_type=password', { email, password: pw });
    await handleAuthSuccess(data);
  } catch(e) {
    document.getElementById('authError').textContent = e.message;
    document.getElementById('authError').classList.add('show');
  } finally { btn.disabled = false; }
}

async function handleAuthSuccess(data) {
  authToken = data.access_token;
  currentUser = data.user;
  try { localStorage.setItem(LS_SESSION, JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user })); } catch(e) {}
  document.getElementById('authOverlay').style.display = 'none';
  document.getElementById('userEmail').textContent = currentUser.email;
  document.getElementById('signOutArea').style.display = '';
  // Show setup card if no API key yet
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    document.getElementById('setupCard').classList.remove('hidden');
  }
  await connectSupabase();
}

async function refreshSession() {
  try {
    const session = JSON.parse(localStorage.getItem(LS_SESSION) || '{}');
    if (!session.refresh_token) { console.log('No refresh token found'); return false; }
    const data = await supaAuth('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    if (!data.access_token) { console.log('Refresh returned no access token'); return false; }
    authToken = data.access_token;
    currentUser = data.user;
    try { localStorage.setItem(LS_SESSION, JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user })); } catch(e) {}
    return true;
  } catch(e) { console.error('Session refresh failed:', e.message); return false; }
}

function signOut() {
  authToken = null;
  currentUser = null;
  supaReady = false;
  meals = []; favorites = []; weightLog = []; exerciseLog = []; recipes = []; calibrationNotes = [];
  memoryNotes = '';
  try { localStorage.removeItem(LS_SESSION); } catch(e) {}
  document.getElementById('authOverlay').style.display = '';
  document.getElementById('signOutArea').style.display = 'none';
  document.getElementById('setupCard').classList.add('hidden');
  setSyncStatus('', 'signed out');
  renderToday(); renderFavorites();
}

function toggleAuthMode() {
  const isLogin = document.getElementById('authTitle').textContent === 'Sign in';
  document.getElementById('authTitle').textContent = isLogin ? 'Create account' : 'Sign in';
  document.getElementById('authBtn').textContent = isLogin ? 'Sign up' : 'Sign in';
  document.getElementById('authBtn').onclick = isLogin ? signUp : signIn;
  document.getElementById('authToggleText').innerHTML = isLogin
    ? 'Already have an account? <a onclick="toggleAuthMode()">Sign in</a>'
    : 'Need an account? <a onclick="toggleAuthMode()">Sign up</a>';
  document.getElementById('authError').classList.remove('show');
}

// ─── INIT ───
async function init() {
  loadTheme();
  try {
    const c = JSON.parse(localStorage.getItem(LS_CREDS) || '{}');
    if (c.apiKey) document.getElementById('apiKey').value = c.apiKey;
  } catch(e) {}

  // Try to restore session
  const session = JSON.parse(localStorage.getItem(LS_SESSION) || '{}');
  if (session.access_token) {
    authToken = session.access_token;
    currentUser = session.user;
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('userEmail').textContent = currentUser?.email || '';
    document.getElementById('signOutArea').style.display = '';
    const refreshed = await refreshSession();
    if (refreshed) {
      await connectSupabase();
    } else {
      // Token expired, show auth
      authToken = null; currentUser = null;
      document.getElementById('authOverlay').style.display = '';
      document.getElementById('signOutArea').style.display = 'none';
    }
  } else {
    document.getElementById('authOverlay').style.display = '';
  }

  checkReady();
  renderToday();
  renderFavorites();
}

async function connectSupabase() {
  try {
    setSyncStatus('busy', 'syncing…');
    if (!navigator.onLine) { setSyncStatus('err', 'offline'); logError('connect', 'No internet'); return; }
    let settings = await supa('settings', 'GET', { query: 'select=*&limit=1' });
    if (settings.length === 0 && currentUser) {
      // Create settings row for new user
      settings = await supa('settings', 'POST', { body: { goal_cal:2000, goal_prot:150, goal_carbs:200, goal_fat:65, goal_fiber:25, theme:'system' } });
    }
    if (settings.length > 0) {
      const s = settings[0];
      goals.cal = s.goal_cal || 2000; goals.prot = s.goal_prot || 150;
      goals.carbs = s.goal_carbs || 200; goals.fat = s.goal_fat || 65;
      goals.fiber = s.goal_fiber || 25;
      if (s.theme) loadThemeFromSupabase(s.theme);
      document.getElementById('goalCal').value = goals.cal;
      document.getElementById('goalProt').value = goals.prot;
      document.getElementById('goalCarbs').value = goals.carbs;
      document.getElementById('goalFat').value = goals.fat;
      document.getElementById('goalFiber').value = goals.fiber;
      updateGoalDisplay();
    }
    const mealRows = await supa('meals', 'GET', { query: 'select=*&order=date.desc,time.desc' });
    meals = mealRows.map(r => ({ id:r.id, date:r.date, time:r.time, type:r.meal_type, meal_name:r.meal_name, description:r.description, calories:r.calories, protein:r.protein, carbs:r.carbs, fat:r.fat, fiber:r.fiber||0 }));
    const favRows = await supa('favorites', 'GET', { query: 'select=*&order=created_at.desc' });
    favorites = favRows.map(r => ({ id:r.id, meal_name:r.meal_name, calories:r.calories, protein:r.protein, carbs:r.carbs, fat:r.fat, fiber:r.fiber||0, type:r.meal_type, description:r.description }));
    const weightRows = await supa('weight_log', 'GET', { query: 'select=*&order=date.asc' });
    weightLog = weightRows.map(r => ({ id:r.id, date:r.date, value:r.value }));
    const exRows = await supa('exercise', 'GET', { query: 'select=*&order=date.desc' });
    exerciseLog = exRows.map(r => ({ id:r.id, date:r.date, description:r.description, calories_burned:r.calories_burned }));
    const recRows = await supa('recipes', 'GET', { query: 'select=*&order=created_at.desc' });
    recipes = recRows.map(r => ({ id:r.id, recipe_name:r.recipe_name, description:r.description, calories:r.calories, protein:r.protein, carbs:r.carbs, fat:r.fat, fiber:r.fiber||0, portions:r.portions||1 }));
    const calNoteRows = await supa('calibrations', 'GET', { query: 'select=*&order=created_at.asc' });
    calibrationNotes = calNoteRows.map(r => ({ id:r.id, note:r.note }));
    rebuildMemoryNotes(); updateCalCount();
    supaReady = true;
    setSyncStatus('ok', 'synced');
    renderToday(); renderFavorites();
  } catch(e) {
    setSyncStatus('err', e.message.includes('timed out') ? 'timed out' : 'error');
    logError('connect', e.message);
    document.getElementById('setupCard').classList.remove('hidden');
  }
}

function saveCreds() {
  try { localStorage.setItem(LS_CREDS, JSON.stringify({ apiKey: document.getElementById('apiKey').value.trim() })); } catch(e) {}
}

function setSyncStatus(state, msg) {
  const dot = document.getElementById('syncDot');
  dot.className = 'dot' + (state === 'ok' ? ' ok' : '');
  if (state === 'err') dot.style.background = 'var(--coral)';
  else if (state === 'busy') dot.style.background = 'var(--amber)';
  else dot.style.background = '';
  document.getElementById('syncLabel').textContent = msg;
}

function fmtDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function dateLabelFn(d) {
  const today = fmtDate(new Date()), s = fmtDate(d);
  if (s === today) return 'Today';
  const yest = new Date(); yest.setDate(yest.getDate()-1);
  if (s === fmtDate(yest)) return 'Yesterday';
  return d.toLocaleDateString(undefined, {weekday:'short', month:'short', day:'numeric'});
}
function changeDate(delta) { viewDate.setDate(viewDate.getDate()+delta); renderToday(); }
function goToToday() { viewDate = new Date(); renderToday(); }

async function cycleMealType(id) {
  const types = ['Breakfast','Lunch','Dinner','Snack'];
  const meal = meals.find(m => m.id === id);
  if (!meal) return;
  const idx = types.indexOf(meal.type);
  meal.type = types[(idx + 1) % types.length];
  if (supaReady) { try { await supa('meals','PATCH',{query:`id=eq.${id}`,body:{meal_type:meal.type}}); } catch(e){} }
  renderToday();
  showQuickToast('Moved to ' + meal.type);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function checkReady() {
  const k = document.getElementById('apiKey').value.trim();
  const apiOk = k.startsWith('sk-ant-') && k.length > 20;
  document.getElementById('estimateBtn').disabled = !apiOk;
  document.getElementById('suggestBtn').disabled = !apiOk;
  document.getElementById('recipeEstBtn').disabled = !apiOk;
  document.getElementById('syncDot').classList.toggle('ok', apiOk && supaReady);
  document.getElementById('settingsBtn').classList.toggle('has-key', apiOk);
  saveCreds();
  return apiOk;
}

function toggleSetup() {
  const card = document.getElementById('setupCard');
  card.classList.toggle('hidden');
  if (!card.classList.contains('hidden')) {
    document.getElementById('apiKey').focus();
  } else {
    saveCreds();
    if (checkReady() && !supaReady && currentUser) connectSupabase();
  }
}

function switchTab(name) {
  const names = ['log','today','trends','recipes','settings'];
  document.querySelectorAll('.tab-btn').forEach((t,i) => t.classList.toggle('active', names[i]===name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id==='tab-'+name));
  if (name === 'today') renderToday();
  if (name === 'trends') renderTrends();
  if (name === 'log') renderFavorites();
  if (name === 'recipes') renderRecipes();
}

function toggleInlineNote() {
  noteInputVisible = !noteInputVisible;
  document.getElementById('calInline').classList.toggle('show', noteInputVisible);
  document.getElementById('calToggleLabel').textContent = noteInputVisible ? 'Hide note' : 'Add a calibration note';
}

function pickMealType(el) { document.querySelectorAll('.meal-pill').forEach(b => b.classList.remove('active')); el.classList.add('active'); }
function getMealType() { const a = document.querySelector('.meal-pill.active'); return a ? a.dataset.type : 'Lunch'; }
function setMealType(type) { document.querySelectorAll('.meal-pill').forEach(b => b.classList.toggle('active', b.dataset.type === type)); }

// ─── RATE LIMIT & CACHE ───
const rateBucket = { calls: [], limit: 10, windowMs: 60000 };
function checkRateLimit() {
  const now = Date.now();
  rateBucket.calls = rateBucket.calls.filter(t => now - t < rateBucket.windowMs);
  if (rateBucket.calls.length >= rateBucket.limit) {
    const waitSec = Math.ceil((rateBucket.calls[0] + rateBucket.windowMs - now) / 1000);
    throw new Error(`Rate limited — try again in ${waitSec}s.`);
  }
  rateBucket.calls.push(now);
}

const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function getCached(key) { const e = responseCache.get(key); if (e && Date.now()-e.time < CACHE_TTL) return e.data; if (e) responseCache.delete(key); return null; }
function setCache(key, data) { responseCache.set(key, {data, time:Date.now()}); if (responseCache.size > 50) responseCache.delete(responseCache.keys().next().value); }

function safeParseJSON(text) {
  // Try to extract clean JSON from potentially messy Claude responses
  const clean = text.replace(/```json|```/g, '').trim();
  // Try array first
  const arrMatch = clean.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { const arr = JSON.parse(arrMatch[0]); if (Array.isArray(arr)) return arr; } catch(e) {}
    // Try to fix common issues: trailing commas, unquoted keys
    try { const fixed = arrMatch[0].replace(/,\s*([}\]])/g, '$1'); const arr = JSON.parse(fixed); if (Array.isArray(arr)) return arr; } catch(e) {}
  }
  // Try single object
  const objMatch = clean.match(/\{[\s\S]*?"meal_name"[\s\S]*?\}/);
  if (objMatch) {
    try { return [JSON.parse(objMatch[0])]; } catch(e) {}
    try { const fixed = objMatch[0].replace(/,\s*}/g, '}'); return [JSON.parse(fixed)]; } catch(e) {}
  }
  // Try recipe_name object
  const recMatch = clean.match(/\{[\s\S]*?"recipe_name"[\s\S]*?\}/);
  if (recMatch) {
    try { return JSON.parse(recMatch[0]); } catch(e) {}
  }
  return null;
}

async function callClaude(key, body) {
  checkRateLimit();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}
async function estimateMeal() {
  const key = document.getElementById('apiKey').value.trim();
  const desc = document.getElementById('mealInput').value.trim();
  if (!desc) return;
  await runEstimation(key, desc);
}

async function runEstimation(key, desc) {
  const btn = document.getElementById('estimateBtn');
  btn.disabled = true;
  document.getElementById('estimating').classList.add('show');
  document.getElementById('errorMsg').classList.remove('show');
  document.getElementById('previewCard').classList.remove('show');
  document.getElementById('multiPreview').innerHTML = '';
  document.getElementById('multiPreview').style.display = 'none';
  // Check cache (keyed on lowercase description + current calibrations hash)
  const cacheKey = desc.toLowerCase().trim() + '|' + memoryNotes.length;
  const cached = getCached(cacheKey);
  if (cached) {
    pendingMeals = cached.items;
    pendingDescription = desc;
    if (cached.mealType) setMealType(cached.mealType);
    showPreview(pendingMeals);
    document.getElementById('estimating').classList.remove('show');
    btn.disabled = false;
    return;
  }
  const memCtx = memoryNotes ? `\n\nPersonal calibration notes — apply these:\n${memoryNotes}\n\nAlways prioritise these over generic defaults.` : '';
  const recipeCtx = recipes.length > 0 ? `\n\nUser's saved recipes — if the meal matches one of these, use these exact values:\n${recipes.map(r => `- ${r.recipe_name}: ${r.calories} cal, ${r.protein}g P, ${r.carbs}g C, ${r.fat}g F, ${r.fiber}g f`).join('\n')}` : '';
  try {
    const detectData = await callClaude(key, { model: 'claude-sonnet-4-6', max_tokens: 50, system: 'The user will describe a meal. Respond with ONLY "yes" or "no" — does this mention a specific restaurant, fast food chain, brand name, or packaged food product? No explanation.', messages: [{ role: 'user', content: desc }] });
    const needsSearch = detectData.content[0].text.trim().toLowerCase().startsWith('yes');
    document.getElementById('estimating').textContent = needsSearch ? 'Looking up nutrition data…' : 'Analysing your meal…';
    const today = fmtDate(new Date());
    const defaultDate = editForDate || today;
    const estimateBody = { model: 'claude-sonnet-4-6', max_tokens: 1024,
      system: `You are a nutrition estimation assistant.${needsSearch ? ' The user mentioned a specific restaurant or brand — use the web search tool to look up their official nutrition data before responding.' : ''} Today's date is ${today}. The user may describe one or multiple food items. Return a JSON array of items — even for a single item, wrap it in an array. Respond ONLY with a JSON array — no markdown, no preamble.\n[{"meal_name":"short name","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"date":"YYYY-MM-DD","meal_type":"Breakfast|Lunch|Dinner|Snack","note":"one sentence on source and confidence"}]\nAll numbers integers. For "date": if the user mentions a day (yesterday, last Tuesday, Monday, etc.), calculate the correct YYYY-MM-DD date relative to today (${today}). If no day is mentioned, use "${defaultDate}". For "meal_type": if the user mentions when they ate it, use that. Otherwise use "unspecified". Each distinct food item should be its own entry in the array.${recipeCtx}${memCtx}`,
      messages: [{ role: 'user', content: `Estimate nutrition for: ${desc}` }] };
    if (needsSearch) estimateBody.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    const data = await callClaude(key, estimateBody);
    const allText = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    // Try to parse as array first, fall back to single object
    let items = safeParseJSON(allText);
    if (!items || (Array.isArray(items) && items.length === 0)) throw new Error('Could not parse nutrition estimate. Try rephrasing your meal.');
    const mealTypeFromClaude = items[0].meal_type && items[0].meal_type !== 'unspecified' ? items[0].meal_type : null;
    if (mealTypeFromClaude) setMealType(mealTypeFromClaude);
    pendingMeals = items.map(meal => {
      const mealDate = meal.date && /^\d{4}-\d{2}-\d{2}$/.test(meal.date) ? meal.date : today;
      const mt = meal.meal_type && meal.meal_type !== 'unspecified' ? meal.meal_type : null;
      return { ...meal, fiber: meal.fiber||0, type: mt || getMealType(), description: desc, time: new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), date: mealDate, id: Date.now() + Math.random() };
    });
    pendingDescription = desc;
    // Cache the result (skip if web search was used — those need fresh data)
    if (!needsSearch) setCache(cacheKey, { items: pendingMeals, mealType: mealTypeFromClaude });
    showPreview(pendingMeals);
  } catch(e) {
    document.getElementById('errorMsg').textContent = 'Error: ' + e.message;
    document.getElementById('errorMsg').classList.add('show');
  } finally {
    document.getElementById('estimating').classList.remove('show');
    document.getElementById('estimating').textContent = 'Analysing your meal…';
    btn.disabled = false;
  }
}

function showPreview(items) {
  const totals = items.reduce((a,m) => ({cal:a.cal+m.calories,prot:a.prot+m.protein,carbs:a.carbs+m.carbs,fat:a.fat+m.fat,fiber:a.fiber+(m.fiber||0)}),{cal:0,prot:0,carbs:0,fat:0,fiber:0});
  if (items.length === 1) {
    document.getElementById('previewName').textContent = items[0].meal_name;
    document.getElementById('multiPreview').innerHTML = '';
    document.getElementById('multiPreview').style.display = 'none';
  } else {
    document.getElementById('previewName').textContent = items.length + ' items';
    const mp = document.getElementById('multiPreview');
    mp.style.display = '';
    mp.innerHTML = items.map(m => `<div class="multi-item"><span class="multi-name">${esc(m.meal_name)}</span><span class="multi-cal">${m.calories} cal</span></div>`).join('');
  }
  document.getElementById('pCal').textContent = totals.cal;
  document.getElementById('pProt').textContent = totals.prot;
  document.getElementById('pCarbs').textContent = totals.carbs;
  document.getElementById('pFat').textContent = totals.fat;
  document.getElementById('pFiber').textContent = totals.fiber;
  const dateNote = items[0].date !== fmtDate(new Date()) ? ' · logging to ' + items[0].date : '';
  document.getElementById('previewNote').textContent = (items[0].note || '') + dateNote;
  document.getElementById('inlineNote').value = '';
  noteInputVisible = false;
  document.getElementById('calInline').classList.remove('show');
  document.getElementById('calToggleLabel').textContent = 'Add a calibration note';
  document.getElementById('previewCard').classList.add('show');
}

async function confirmLog() {
  if (!pendingMeals || pendingMeals.length === 0) return;
  const noteVal = document.getElementById('inlineNote').value.trim();
  if (noteVal) {
    // Add as new calibration note
    const entry = { note: noteVal };
    if (supaReady) {
      try { const rows = await supa('calibrations','POST',{body:{note:noteVal}}); entry.id=rows[0].id; } catch(e){ entry.id=Date.now(); }
    } else { entry.id = Date.now(); }
    calibrationNotes.push(entry);
    rebuildMemoryNotes();
    updateCalCount();
    const key = document.getElementById('apiKey').value.trim();
    if (key && pendingDescription) {
      await runEstimation(key, pendingDescription);
      return; // Show updated preview, user confirms again
    }
  }
  // Log all pending meals
  const loggedMeals = [];
  for (const m of pendingMeals) {
    if (supaReady) {
      setSyncStatus('busy', 'saving…');
      try {
        const rows = await supa('meals', 'POST', { body: { date: m.date, time: m.time, meal_type: m.type, meal_name: m.meal_name, description: m.description, calories: m.calories, protein: m.protein, carbs: m.carbs, fat: m.fat, fiber: m.fiber||0 } });
        const logged = { ...m, id: rows[0].id };
        meals.unshift(logged);
        loggedMeals.push(logged);
        await addToFavorites(m);
        setSyncStatus('ok', 'synced');
      } catch(e) { meals.unshift(m); loggedMeals.push(m); setSyncStatus('err', 'save failed'); showQuickToast('⚠ Save failed — meal only stored locally'); logError('save', e.message); }
    } else { meals.unshift(m); loggedMeals.push(m); }
  }
  const loggedDate = pendingMeals[0].date;
  pendingMeals = null;
  pendingDescription = null;
  clearDateBanner();
  // Remove old entry if this was an edit
  if (editReplacingId) {
    meals = meals.filter(m => m.id !== editReplacingId);
    if (supaReady) { try { await supa('meals','DELETE',{query:`id=eq.${editReplacingId}`}); } catch(e){} }
    editReplacingId = null;
  }
  document.getElementById('mealInput').value = '';
  document.getElementById('previewCard').classList.remove('show');
  viewDate = new Date(loggedDate + 'T12:00:00');
  showUndo(loggedMeals.length === 1 ? 'Meal logged' : loggedMeals.length + ' meals logged', { type: 'log', meals: loggedMeals });
  renderToday(); switchTab('today');
}

function cancelEstimate() { document.getElementById('previewCard').classList.remove('show'); pendingMeals = null; pendingDescription = null; editReplacingId = null; clearDateBanner(); }

async function deleteMeal(id) {
  const meal = meals.find(m => m.id === id);
  meals = meals.filter(m => m.id !== id);
  renderToday();
  if (meal) showUndo('Meal deleted', { type: 'delete', meal, supaDeleted: false });
  if (supaReady) { try { await supa('meals', 'DELETE', { query: `id=eq.${id}` }); if (undoStack && undoStack.data.meal.id === id) undoStack.data.supaDeleted = true; } catch(e) {} }
}

function editMeal(id) {
  const meal = meals.find(m => m.id === id);
  if (!meal) return;
  const mealDate = meal.date;
  const isToday = mealDate === fmtDate(new Date());
  editReplacingId = id;
  document.getElementById('mealInput').value = meal.description || meal.meal_name;
  setMealType(meal.type);
  if (!isToday) {
    editForDate = mealDate;
    const d = new Date(mealDate + 'T12:00:00');
    document.getElementById('dateBannerText').textContent = 'Editing for ' + d.toLocaleDateString(undefined, {month:'short', day:'numeric'});
    document.getElementById('dateBanner').style.display = '';
  }
  switchTab('log');
  document.getElementById('mealInput').focus();
}

function clearDateBanner() {
  editForDate = null;
  document.getElementById('dateBanner').style.display = 'none';
}

// Inline rename
function startInlineRename(el, id, type) {
  if (el.contentEditable === 'true') return;
  el.contentEditable = 'true';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const list = type === 'recipe' ? recipes : meals;
  const nameKey = type === 'recipe' ? 'recipe_name' : 'meal_name';
  const table = type === 'recipe' ? 'recipes' : 'meals';
  const finish = async () => {
    el.contentEditable = 'false';
    const newName = el.textContent.trim();
    const item = list.find(x => x.id === id);
    if (!newName) { el.textContent = item ? item[nameKey] : ''; return; }
    if (item && newName !== item[nameKey]) {
      item[nameKey] = newName;
      if (supaReady) { try { await supa(table,'PATCH',{query:`id=eq.${id}`,body:{[nameKey]:newName}}); } catch(e){} }
    }
  };
  el.onblur = finish;
  el.onkeydown = (e) => { if(e.key==='Enter'){e.preventDefault();el.blur();} if(e.key==='Escape'){const item=list.find(x=>x.id===id);el.textContent=item?item[nameKey]:'';el.blur();} };
}

// Edit modal
function openEditModal(id) {
  const meal = meals.find(m => m.id === id);
  if (!meal) return;
  editingMealId = id;
  document.getElementById('editModalTitle').textContent = 'Edit: ' + meal.meal_name;
  document.getElementById('editName').value = meal.meal_name;
  document.getElementById('editCal').value = meal.calories;
  document.getElementById('editProt').value = meal.protein;
  document.getElementById('editCarbs').value = meal.carbs;
  document.getElementById('editFat').value = meal.fat;
  document.getElementById('editFiber').value = meal.fiber || 0;
  document.getElementById('editType').value = meal.type;
  document.getElementById('editDate').value = meal.date;
  document.getElementById('editOverlay').style.display = '';
}

function closeEditModal() {
  document.getElementById('editOverlay').style.display = 'none';
  editingMealId = null;
}

function recalcEditCal() {
  const p = parseInt(document.getElementById('editProt').value) || 0;
  const c = parseInt(document.getElementById('editCarbs').value) || 0;
  const f = parseInt(document.getElementById('editFat').value) || 0;
  document.getElementById('editCal').value = p * 4 + c * 4 + f * 9;
}

async function saveEditModal() {
  if (!editingMealId) return;
  const meal = meals.find(m => m.id === editingMealId);
  if (!meal) { closeEditModal(); return; }
  meal.meal_name = document.getElementById('editName').value.trim() || meal.meal_name;
  meal.calories = parseInt(document.getElementById('editCal').value) || 0;
  meal.protein = parseInt(document.getElementById('editProt').value) || 0;
  meal.carbs = parseInt(document.getElementById('editCarbs').value) || 0;
  meal.fat = parseInt(document.getElementById('editFat').value) || 0;
  meal.fiber = parseInt(document.getElementById('editFiber').value) || 0;
  meal.type = document.getElementById('editType').value;
  meal.date = document.getElementById('editDate').value;
  if (supaReady) {
    try {
      await supa('meals','PATCH',{query:`id=eq.${editingMealId}`,body:{
        meal_name:meal.meal_name,calories:meal.calories,protein:meal.protein,
        carbs:meal.carbs,fat:meal.fat,fiber:meal.fiber,meal_type:meal.type,date:meal.date
      }});
      setSyncStatus('ok','synced');
    } catch(e) { setSyncStatus('err','sync error'); }
  }
  closeEditModal();
  renderToday();
}

// Log to Today
async function logMealToToday(id) {
  const meal = meals.find(m => m.id === id);
  if (!meal) return;
  const now = new Date();
  const mealData = { date:fmtDate(now), time:now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), type:meal.type, meal_name:meal.meal_name, description:meal.description, calories:meal.calories, protein:meal.protein, carbs:meal.carbs, fat:meal.fat, fiber:meal.fiber||0 };
  if (supaReady) {
    setSyncStatus('busy','saving…');
    try {
      const rows = await supa('meals','POST',{body:{date:mealData.date,time:mealData.time,meal_type:mealData.type,meal_name:mealData.meal_name,description:mealData.description,calories:mealData.calories,protein:mealData.protein,carbs:mealData.carbs,fat:mealData.fat,fiber:mealData.fiber}});
      mealData.id = rows[0].id;
      setSyncStatus('ok','synced');
    } catch(e) { mealData.id = Date.now(); setSyncStatus('err','sync error'); }
  } else { mealData.id = Date.now(); }
  meals.unshift(mealData);
  showQuickToast(esc(meal.meal_name) + ' logged to today');
}

async function logMealGroupToToday(type, date) {
  const groupMeals = meals.filter(m => m.date === date && m.type === type);
  if (groupMeals.length === 0) return;
  const now = new Date();
  const today = fmtDate(now);
  const time = now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  let count = 0;
  for (const meal of groupMeals) {
    const mealData = { date:today, time, type:meal.type, meal_name:meal.meal_name, description:meal.description, calories:meal.calories, protein:meal.protein, carbs:meal.carbs, fat:meal.fat, fiber:meal.fiber||0 };
    if (supaReady) {
      setSyncStatus('busy','saving…');
      try {
        const rows = await supa('meals','POST',{body:{date:mealData.date,time:mealData.time,meal_type:mealData.type,meal_name:mealData.meal_name,description:mealData.description,calories:mealData.calories,protein:mealData.protein,carbs:mealData.carbs,fat:mealData.fat,fiber:mealData.fiber}});
        mealData.id = rows[0].id;
      } catch(e) { mealData.id = Date.now(); }
    } else { mealData.id = Date.now(); }
    meals.unshift(mealData);
    count++;
  }
  if (supaReady) setSyncStatus('ok','synced');
  showQuickToast(count + ' ' + type + ' item' + (count>1?'s':'') + ' logged to today');
}

function showUndo(msg, data) {
  if (undoTimer) clearTimeout(undoTimer);
  undoStack = { data };
  document.getElementById('undoMsg').textContent = msg;
  document.getElementById('undoToast').classList.add('show');
  undoTimer = setTimeout(() => {
    document.getElementById('undoToast').classList.remove('show');
    undoStack = null;
  }, 5000);
}

async function performUndo() {
  if (!undoStack) return;
  const action = undoStack.data;
  if (action.type === 'delete') {
    const m = action.meal;
    if (action.supaDeleted && supaReady) {
      try {
        const rows = await supa('meals', 'POST', { body: { date: m.date, time: m.time, meal_type: m.type, meal_name: m.meal_name, description: m.description, calories: m.calories, protein: m.protein, carbs: m.carbs, fat: m.fat, fiber: m.fiber||0 } });
        m.id = rows[0].id;
      } catch(e) {}
    }
    meals.unshift(m);
    renderToday();
  } else if (action.type === 'log') {
    for (const m of action.meals) {
      meals = meals.filter(x => x.id !== m.id);
      if (supaReady) { try { await supa('meals', 'DELETE', { query: `id=eq.${m.id}` }); } catch(e) {} }
    }
    renderToday();
  }
  document.getElementById('undoToast').classList.remove('show');
  if (undoTimer) clearTimeout(undoTimer);
  undoStack = null;
}

function rebuildMemoryNotes() {
  memoryNotes = calibrationNotes.map(n => '- ' + n.note).join('\n');
}

function updateCalCount() {
  const cnt = calibrationNotes.length;
  document.getElementById('calCount').textContent = cnt;
  document.getElementById('calViewBtn').style.display = cnt > 0 ? '' : 'none';
}

async function addCalibration() {
  const input = document.getElementById('calNoteInput');
  const note = input.value.trim();
  if (!note) return;
  const entry = { note };
  if (supaReady) {
    try {
      const rows = await supa('calibrations','POST',{body:{note}});
      entry.id = rows[0].id;
    } catch(e) { entry.id = Date.now(); }
  } else { entry.id = Date.now(); }
  calibrationNotes.push(entry);
  rebuildMemoryNotes();
  updateCalCount();
  input.value = '';
  const flash = document.getElementById('calFlash');
  flash.classList.add('show');
  setTimeout(() => flash.classList.remove('show'), 2000);
}

async function deleteCalibration(id) {
  calibrationNotes = calibrationNotes.filter(n => n.id !== id);
  rebuildMemoryNotes();
  updateCalCount();
  renderCalModal();
  if (supaReady) { try { await supa('calibrations','DELETE',{query:`id=eq.${id}`}); } catch(e){} }
}

async function saveCalibrationEdit(id, newNote) {
  const entry = calibrationNotes.find(n => n.id === id);
  if (!entry || !newNote.trim()) return;
  entry.note = newNote.trim();
  rebuildMemoryNotes();
  if (supaReady) { try { await supa('calibrations','PATCH',{query:`id=eq.${id}`,body:{note:entry.note}}); } catch(e){} }
}

function openCalModal() {
  renderCalModal();
  document.getElementById('calOverlay').style.display = '';
}

function closeCalModal() {
  document.getElementById('calOverlay').style.display = 'none';
}

function renderCalModal() {
  const list = document.getElementById('calModalList');
  if (calibrationNotes.length === 0) {
    list.innerHTML = '<p style="color:var(--text-3);font-size:13px;padding:16px 0;">No calibrations yet.</p>';
    return;
  }
  list.innerHTML = calibrationNotes.map(n => `<div class="cal-note-item">
    <div class="cal-note-text" contenteditable="true" onblur="saveCalibrationEdit(${n.id},this.textContent)">${esc(n.note)}</div>
    <div class="cal-note-actions">
      <button class="del-btn" onclick="deleteCalibration(${n.id})" aria-label="Delete">✕</button>
    </div>
  </div>`).join('');
}

// Legacy saveCalibrations for inline note during meal preview
async function saveCalibrations() {
  // Called when inline note is added during preview — add as new calibration
  // The note is already handled by addCalibrationFromPreview
}

let goalMode = 'grams'; // 'grams' or 'pct'

async function saveGoals() {
  if (goalMode === 'pct') {
    // Convert percentages to grams
    const cal = parseInt(document.getElementById('goalCal').value) || 2000;
    const protPct = parseInt(document.getElementById('goalProt').value) || 30;
    const carbsPct = parseInt(document.getElementById('goalCarbs').value) || 40;
    const fatPct = parseInt(document.getElementById('goalFat').value) || 30;
    goals.cal = cal;
    goals.prot = Math.round((protPct / 100 * cal) / 4);
    goals.carbs = Math.round((carbsPct / 100 * cal) / 4);
    goals.fat = Math.round((fatPct / 100 * cal) / 9);
    goals.fiber = parseInt(document.getElementById('goalFiber').value) || 25;
  } else {
    goals.cal = parseInt(document.getElementById('goalCal').value) || 2000;
    goals.prot = parseInt(document.getElementById('goalProt').value) || 150;
    goals.carbs = parseInt(document.getElementById('goalCarbs').value) || 200;
    goals.fat = parseInt(document.getElementById('goalFat').value) || 65;
    goals.fiber = parseInt(document.getElementById('goalFiber').value) || 25;
  }
  if (supaReady) { try { await supa('settings', 'PATCH', { query: 'user_id=eq.' + currentUser.id, body: { goal_cal: goals.cal, goal_prot: goals.prot, goal_carbs: goals.carbs, goal_fat: goals.fat, goal_fiber: goals.fiber } }); } catch(e) {} }
  updateGoalDisplay();
  renderToday();
}

function updateGoalDisplay() {
  const cal = goals.cal || 2000;
  const protCal = goals.prot * 4, carbsCal = goals.carbs * 4, fatCal = goals.fat * 9;
  const total = protCal + carbsCal + fatCal;
  if (goalMode === 'grams') {
    document.getElementById('goalProt').value = goals.prot;
    document.getElementById('goalCarbs').value = goals.carbs;
    document.getElementById('goalFat').value = goals.fat;
    document.getElementById('goalProtPct').textContent = total > 0 ? Math.round(protCal/total*100) + '% of cal' : '';
    document.getElementById('goalCarbsPct').textContent = total > 0 ? Math.round(carbsCal/total*100) + '% of cal' : '';
    document.getElementById('goalFatPct').textContent = total > 0 ? Math.round(fatCal/total*100) + '% of cal' : '';
  } else {
    document.getElementById('goalProt').value = total > 0 ? Math.round(protCal/total*100) : 30;
    document.getElementById('goalCarbs').value = total > 0 ? Math.round(carbsCal/total*100) : 40;
    document.getElementById('goalFat').value = total > 0 ? Math.round(fatCal/total*100) : 30;
    document.getElementById('goalProtPct').textContent = goals.prot + 'g';
    document.getElementById('goalCarbsPct').textContent = goals.carbs + 'g';
    document.getElementById('goalFatPct').textContent = goals.fat + 'g';
  }
}

function toggleGoalMode() {
  goalMode = goalMode === 'grams' ? 'pct' : 'grams';
  const labels = { prot: document.querySelector('#goalProt').closest('.goal-cell').querySelector('.goal-label'),
    carbs: document.querySelector('#goalCarbs').closest('.goal-cell').querySelector('.goal-label'),
    fat: document.querySelector('#goalFat').closest('.goal-cell').querySelector('.goal-label') };
  if (goalMode === 'pct') {
    labels.prot.textContent = 'Protein (%)';
    labels.carbs.textContent = 'Carbs (%)';
    labels.fat.textContent = 'Fat (%)';
    document.getElementById('goalModeBtn').textContent = 'Switch to grams';
  } else {
    labels.prot.textContent = 'Protein (g)';
    labels.carbs.textContent = 'Carbs (g)';
    labels.fat.textContent = 'Fat (g)';
    document.getElementById('goalModeBtn').textContent = 'Switch to % input';
  }
  updateGoalDisplay();
}

function exportCSV() {
  const header = 'Date,Time,Meal type,Meal name,Calories,Protein,Carbs,Fat,Fiber';
  const rows = meals.map(m => [m.date, m.time, m.type, '"'+m.meal_name.replace(/"/g,'""')+'"', m.calories, m.protein, m.carbs, m.fat, m.fiber||0].join(','));
  const blob = new Blob([header+'\n'+rows.join('\n')], {type:'text/csv'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'nutritracker_'+fmtDate(new Date())+'.csv'; a.click(); URL.revokeObjectURL(a.href);
}

async function resetAll() {
  if (!confirm('This will delete ALL data. Are you sure?')) return;
  if (supaReady) {
    try {
      await supa('meals', 'DELETE', { query: 'id=gt.0' });
      await supa('favorites', 'DELETE', { query: 'id=gt.0' });
      await supa('weight_log', 'DELETE', { query: 'id=gt.0' });
      await supa('exercise', 'DELETE', { query: 'id=gt.0' });
      await supa('recipes', 'DELETE', { query: 'id=gt.0' });
      await supa('calibrations', 'DELETE', { query: 'id=gt.0' });
      await supa('settings', 'PATCH', { query: 'user_id=eq.' + currentUser.id, body: { calibrations: '', goal_cal: 2000, goal_prot: 150, goal_carbs: 200, goal_fat: 65, goal_fiber: 25 } });
    } catch(e) { console.error(e); }
  }
  meals = []; favorites = []; weightLog = []; exerciseLog = []; recipes = []; calibrationNotes = []; memoryNotes = '';
  goals = { cal: 2000, prot: 150, carbs: 200, fat: 65, fiber: 25 };
  updateCalCount();
  document.getElementById('goalCal').value = 2000; document.getElementById('goalProt').value = 150;
  document.getElementById('goalCarbs').value = 200; document.getElementById('goalFat').value = 65;
  document.getElementById('goalFiber').value = 25;
  renderToday(); renderFavorites();
}

function renderToday() {
  const ds = fmtDate(viewDate);
  const isViewingToday = ds === fmtDate(new Date());
  document.getElementById('dateLabel').textContent = dateLabelFn(viewDate);
  document.getElementById('dateLabel').style.textDecoration = isViewingToday ? 'none' : 'underline';
  document.getElementById('dateLabel').title = isViewingToday ? '' : 'Click to return to today';
  const day = meals.filter(m => m.date === ds);
  const dayEx = exerciseLog.filter(e => e.date === ds);
  const exCal = dayEx.reduce((a,e) => a + e.calories_burned, 0);
  const t = day.reduce((a,m) => ({cal:a.cal+m.calories,prot:a.prot+m.protein,carbs:a.carbs+m.carbs,fat:a.fat+m.fat,fiber:a.fiber+(m.fiber||0)}),{cal:0,prot:0,carbs:0,fat:0,fiber:0});
  const netCal = t.cal - exCal;
  document.getElementById('totCal').textContent = netCal;
  document.getElementById('totProt').textContent = t.prot;
  document.getElementById('totCarbs').textContent = t.carbs;
  document.getElementById('totFat').textContent = t.fat;
  document.getElementById('totFiber').textContent = t.fiber;
  const wEntry = weightLog.find(w => w.date === ds);
  const wRow = document.getElementById('todayWeightRow');
  if (wEntry) { document.getElementById('todayWeight').textContent = wEntry.value; wRow.style.display = ''; }
  else { wRow.style.display = 'none'; }
  // Show exercise burned row
  const exRow = document.getElementById('todayExerciseRow');
  if (exCal > 0) { document.getElementById('todayExCal').textContent = exCal; exRow.style.display = ''; }
  else { exRow.style.display = 'none'; }
  // TDEE estimate
  renderTDEE();
  // Calorie remaining bar
  const remaining = goals.cal - netCal;
  const pctUsed = goals.cal > 0 ? Math.min(Math.round((netCal / goals.cal) * 100), 100) : 0;
  const barColor = pctUsed < 75 ? '#22C55E' : pctUsed < 95 ? '#F59E0B' : '#EF4444';
  document.getElementById('calRemainingFill').style.width = Math.min(pctUsed, 100) + '%';
  document.getElementById('calRemainingFill').style.background = barColor;
  if (remaining > 0) {
    document.getElementById('calRemainingText').textContent = remaining + (isViewingToday ? ' cal remaining' : ' cal under');
  } else {
    document.getElementById('calRemainingText').textContent = Math.abs(remaining) + ' cal over';
  }
  const bars = [
    {label:'Calories (net)',val:Math.max(0,netCal),goal:goals.cal,color:'#22C55E'},
    {label:'Protein',val:t.prot,goal:goals.prot,color:'#3B82F6'},
    {label:'Carbs',val:t.carbs,goal:goals.carbs,color:'#F59E0B'},
    {label:'Fat',val:t.fat,goal:goals.fat,color:'#EF4444'},
    {label:'Fiber',val:t.fiber,goal:goals.fiber,color:'#A855F7'}
  ];
  document.getElementById('progressBars').innerHTML = bars.map(b => {
    const pct = b.goal > 0 ? Math.round((b.val/b.goal)*100) : 0;
    const fillPct = Math.min(pct, 100);
    return `<div class="progress-row"><span class="progress-name">${b.label}</span><div class="progress-track"><div class="progress-fill" style="width:${fillPct}%;background:${b.color}"></div></div><span class="progress-pct">${pct}%</span></div>`;
  }).join('');
  const list = document.getElementById('logList');
  if (day.length === 0) {
    const isToday = ds === fmtDate(new Date());
    list.innerHTML = `<li class="empty-state">
      <div class="empty-state-icon">${isToday ? '🍽️' : '📅'}</div>
      <div class="empty-state-title">${isToday ? 'No meals logged yet' : 'Nothing logged this day'}</div>
      <div class="empty-state-hint">${isToday ? 'Switch to the Log tab to add your first meal.<br>Try typing something like "chicken salad for lunch"' : 'Navigate to today to start logging.'}</div>
    </li>`;
    return;
  }
  // Group by meal type
  const typeOrder = ['Breakfast','Lunch','Dinner','Snack'];
  const groups = {};
  day.forEach(m => {
    const key = typeOrder.includes(m.type) ? m.type : 'Other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  });
  const orderedKeys = [...typeOrder, 'Other'].filter(k => groups[k]);
  let html = '';
  const isPast = ds !== fmtDate(new Date());
  orderedKeys.forEach(type => {
    const items = groups[type];
    const sub = items.reduce((a,m) => ({cal:a.cal+m.calories,prot:a.prot+m.protein,carbs:a.carbs+m.carbs,fat:a.fat+m.fat,fiber:a.fiber+(m.fiber||0)}),{cal:0,prot:0,carbs:0,fat:0,fiber:0});
    html += `<li class="meal-group-header"><div class="meal-group-top"><span class="meal-group-label">${esc(type)}</span><div class="meal-group-btns">${isPast ? `<button class="log-today-btn" onclick="logMealGroupToToday('${esc(type)}','${ds}')">+Today</button>` : ''}<button class="log-today-btn" onclick="addMealGroupAsRecipe('${esc(type)}','${ds}')" style="background:var(--blue-light,#E8F0FE);color:var(--blue,#2B6CB0);">+Recipe</button></div></div><div class="meal-group-subtotal">${sub.cal} cal · ${sub.prot}g P · ${sub.carbs}g C · ${sub.fat}g F · ${sub.fiber}g f</div></li>`;
    items.forEach(m => {
      html += `<li>
        <div class="meal-item">
          <div class="meal-item-left"><div class="meal-item-name">${esc(m.meal_name)}</div><div class="meal-item-meta">${esc(m.time)} · ${m.protein}g P · ${m.carbs}g C · ${m.fat}g F · ${m.fiber||0}g f</div></div>
          <span class="meal-type-badge" onclick="cycleMealType(${m.id})" title="Click to change meal type">${esc(m.type)}</span>
          <span class="meal-item-cal" onclick="openEditModal(${m.id})" style="cursor:pointer;" title="Edit macros">${m.calories}</span>
          <div class="meal-actions">
            ${isPast ? `<button class="log-today-btn" onclick="logMealToToday(${m.id})">+Today</button>` : ''}
            <button class="edit-btn" onclick="editMeal(${m.id})" aria-label="Edit">✎</button>
            <button class="del-btn" onclick="deleteMeal(${m.id})" aria-label="Delete">✕</button>
          </div>
        </div>
      </li>`;
    });
  });
  list.innerHTML = html;
  // Render exercise list
  const exCard = document.getElementById('exerciseCard');
  const exList = document.getElementById('exerciseList');
  if (dayEx.length === 0) { exCard.style.display = 'none'; }
  else {
    exCard.style.display = '';
    exList.innerHTML = dayEx.map(e => `<div class="exercise-item">
      <span class="exercise-name">${esc(e.description)}</span>
      <span class="exercise-cal">-${e.calories_burned} cal</span>
      <button class="del-btn" onclick="deleteExercise(${e.id})" aria-label="Delete">✕</button>
    </div>`).join('');
  }
}

// Tab swiping
const TAB_NAMES = ['log','today','trends','recipes','settings'];
let tabSwipeStartX = 0, tabSwipeStartY = 0, tabSwiping = false;
document.addEventListener('touchstart', e => {
  tabSwipeStartX = e.touches[0].clientX;
  tabSwipeStartY = e.touches[0].clientY;
  tabSwiping = false;
}, {passive: true});
document.addEventListener('touchmove', e => {
  const dx = e.touches[0].clientX - tabSwipeStartX;
  const dy = e.touches[0].clientY - tabSwipeStartY;
  if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 30) tabSwiping = true;
}, {passive: true});
document.addEventListener('touchend', e => {
  if (!tabSwiping) return;
  const dx = e.changedTouches[0].clientX - tabSwipeStartX;
  if (Math.abs(dx) < 60) return;
  const currentTab = TAB_NAMES.find(n => document.getElementById('tab-'+n)?.classList.contains('active')) || 'log';
  const idx = TAB_NAMES.indexOf(currentTab);
  if (dx < -60 && idx < TAB_NAMES.length - 1) switchTab(TAB_NAMES[idx + 1]);
  else if (dx > 60 && idx > 0) switchTab(TAB_NAMES[idx - 1]);
}, {passive: true});

// Pull-to-refresh
let pullStartY = 0, pulling = false;
document.addEventListener('touchstart', e => {
  if (window.scrollY === 0) pullStartY = e.touches[0].clientY;
}, {passive: true});
document.addEventListener('touchmove', e => {
  if (pullStartY > 0 && e.touches[0].clientY - pullStartY > 60 && window.scrollY === 0) {
    pulling = true;
    document.getElementById('pullIndicator').classList.add('show');
  }
}, {passive: true});
document.addEventListener('touchend', () => {
  if (pulling) {
    pulling = false;
    document.getElementById('pullIndicator').classList.remove('show');
    if (supaReady) connectSupabase();
  }
  pullStartY = 0;
}, {passive: true});

function setRange(days) { trendRange = days; document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', parseInt(b.textContent)===days)); renderTrends(); }

function getDayTotals(numDays) {
  const days = [];
  for (let i = numDays-1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate()-i);
    const ds = fmtDate(d);
    const dm = meals.filter(m => m.date === ds);
    const t = dm.reduce((a,m) => ({cal:a.cal+m.calories,prot:a.prot+m.protein,carbs:a.carbs+m.carbs,fat:a.fat+m.fat,fiber:a.fiber+(m.fiber||0)}),{cal:0,prot:0,carbs:0,fat:0,fiber:0});
    days.push({ date: ds, label: d.toLocaleDateString(undefined,{weekday:'short',day:'numeric'}), ...t });
  }
  return days;
}

let chartMeta = {};

function drawChart(canvasId, datasets, labels, goalLine, minVal, maxValOverride) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.getBoundingClientRect().width;
  const h = parseInt(canvas.getAttribute('height')) || 200;
  canvas.width = w*dpr; canvas.height = h*dpr;
  canvas.style.width = w+'px'; canvas.style.height = h+'px';
  ctx.scale(dpr,dpr); ctx.clearRect(0,0,w,h);
  const padL=44, padR=36, padT=16, padB=32;
  const chartW=w-padL-padR, chartH=h-padT-padB;
  const allVals = datasets.flatMap(d=>d.data).filter(v=>v>0);
  if (goalLine) allVals.push(goalLine);
  const floor = minVal != null ? minVal : 0;
  const maxVal = maxValOverride != null ? maxValOverride : Math.max(...allVals,floor+1)*1.1;
  const range = maxVal - floor;
  const isDark = document.documentElement.classList.contains('dark-mode') || (!document.documentElement.classList.contains('light-mode') && window.matchMedia('(prefers-color-scheme:dark)').matches);
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = '#9C9B96';
  ctx.font = '11px DM Sans,sans-serif'; ctx.textAlign='right'; ctx.fillStyle=textColor;
  for (let i=0;i<=4;i++) {
    const y=padT+chartH-(i/4)*chartH;
    ctx.fillText(Math.round(floor+(i/4)*range),padL-8,y+4);
    ctx.beginPath(); ctx.strokeStyle=gridColor; ctx.lineWidth=1;
    ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();
  }
  if (goalLine) {
    const gy=padT+chartH-((goalLine-floor)/range)*chartH;
    ctx.beginPath(); ctx.setLineDash([4,4]);
    ctx.strokeStyle=isDark?'rgba(255,255,255,0.2)':'rgba(0,0,0,0.15)';
    ctx.moveTo(padL,gy); ctx.lineTo(w-padR,gy); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle=textColor; ctx.textAlign='left';
    ctx.fillText('goal',w-padR+2,gy+4); ctx.textAlign='right';
  }
  ctx.textAlign='center'; ctx.fillStyle=textColor;
  const step = labels.length>1 ? chartW/(labels.length-1) : 0;
  const showEvery = labels.length>14?3:labels.length>8?2:1;
  labels.forEach((lbl,i) => { if (i%showEvery===0||i===labels.length-1) ctx.fillText(lbl,padL+i*step,h-8); });
  datasets.forEach(ds => {
    ctx.beginPath(); ctx.strokeStyle=ds.color; ctx.lineWidth=2.5; ctx.lineJoin='round'; ctx.lineCap='round';
    ds.data.forEach((val,i) => { const x=padL+i*step,y=padT+chartH-((val-floor)/range)*chartH; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.stroke();
    ds.data.forEach((val,i) => { if(val>0){ctx.beginPath();ctx.fillStyle=ds.color;ctx.arc(padL+i*step,padT+chartH-((val-floor)/range)*chartH,3.5,0,Math.PI*2);ctx.fill();} });
  });
  // Store metadata for click navigation
  chartMeta[canvasId] = { labels, step, padL, w };
}

function drawBarChart(canvasId, datasets, labels, goalLine) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.getBoundingClientRect().width;
  const h = parseInt(canvas.getAttribute('height')) || 200;
  canvas.width = w*dpr; canvas.height = h*dpr;
  canvas.style.width = w+'px'; canvas.style.height = h+'px';
  ctx.scale(dpr,dpr); ctx.clearRect(0,0,w,h);
  const padL=44, padR=16, padT=16, padB=32;
  const chartW=w-padL-padR, chartH=h-padT-padB;
  const allVals = datasets.flatMap(d=>d.data);
  if (goalLine) allVals.push(goalLine);
  const maxVal = Math.max(...allVals, goalLine||1) * 1.15;
  const isDark = document.documentElement.classList.contains('dark-mode') || (!document.documentElement.classList.contains('light-mode') && window.matchMedia('(prefers-color-scheme:dark)').matches);
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const textColor = '#9C9B96';
  // Y axis labels and grid
  ctx.font = '11px DM Sans,sans-serif'; ctx.textAlign='right'; ctx.fillStyle=textColor;
  for (let i=0;i<=4;i++) {
    const y=padT+chartH-(i/4)*chartH;
    ctx.fillText(Math.round((i/4)*maxVal)+'%',padL-8,y+4);
    ctx.beginPath(); ctx.strokeStyle=gridColor; ctx.lineWidth=1;
    ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();
  }
  // Goal line at 100%
  if (goalLine) {
    const gy=padT+chartH-(goalLine/maxVal)*chartH;
    ctx.beginPath(); ctx.setLineDash([4,4]);
    ctx.strokeStyle=isDark?'rgba(255,255,255,0.25)':'rgba(0,0,0,0.2)';
    ctx.lineWidth=1.5;
    ctx.moveTo(padL,gy); ctx.lineTo(w-padR,gy); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle=textColor; ctx.textAlign='left';
    ctx.fillText('100%',w-padR+2,gy+4); ctx.textAlign='right';
  }
  // X axis labels
  ctx.textAlign='center'; ctx.fillStyle=textColor;
  const numDays = labels.length;
  const numBars = datasets.length;
  const groupGap = Math.max(6, chartW / numDays * 0.3);
  const groupWidth = (chartW - groupGap * (numDays - 1)) / numDays;
  const barGap = 1;
  const barWidth = Math.max(2, (groupWidth - (numBars+1)*barGap) / numBars);
  const showEvery = numDays > 14 ? 3 : numDays > 8 ? 2 : 1;
  labels.forEach((lbl, i) => {
    const groupX = padL + i * (groupWidth + groupGap);
    if (i % showEvery === 0 || i === numDays-1) ctx.fillText(lbl, groupX + groupWidth/2, h-8);
  });
  // Draw bars
  datasets.forEach((ds, di) => {
    ds.data.forEach((val, i) => {
      if (val <= 0) return;
      const groupX = padL + i * (groupWidth + groupGap);
      const x = groupX + barGap + di * (barWidth + barGap);
      const barH = (val / maxVal) * chartH;
      const y = padT + chartH - barH;
      ctx.fillStyle = ds.color;
      ctx.beginPath();
      const r = Math.min(2, barWidth/2);
      ctx.roundRect(x, y, barWidth, barH, [r, r, 0, 0]);
      ctx.fill();
    });
  });
  // Store metadata for click navigation
  chartMeta[canvasId] = { labels, groupWidth, groupGap, padL, w };
}

function renderTrends() {
  const days = getDayTotals(trendRange), labels = days.map(d=>d.label);
  const cs = getComputedStyle(document.documentElement);
  const col = n => cs.getPropertyValue(n).trim();
  // Calculate net calories (consumed minus exercise)
  const netCalData = days.map(d => {
    const dayEx = exerciseLog.filter(e => e.date === d.date);
    const exBurned = dayEx.reduce((a,e) => a + e.calories_burned, 0);
    return d.cal > 0 ? d.cal - exBurned : 0;
  });
  drawChart('calChart',[
    {data:days.map(d=>d.cal),color:col('--blue')||'#2B6CB0'},
    {data:netCalData,color:'#22C55E'}
  ],labels,goals.cal);
  drawChart('macroChart',[
    {data:days.map(d=>d.prot),color:col('--accent')||'#2E6B3E'},
    {data:days.map(d=>d.carbs),color:col('--amber')||'#B7791F'},
    {data:days.map(d=>d.fat),color:col('--coral')||'#C53D2F'},
    {data:days.map(d=>d.fiber),color:col('--purple')||'#A855F7'}
  ],labels,null);
  // Macro percentage of target chart (grouped bars)
  const pctData = days.map(d => ({
    prot: goals.prot > 0 ? Math.round((d.prot/goals.prot)*100) : 0,
    carbs: goals.carbs > 0 ? Math.round((d.carbs/goals.carbs)*100) : 0,
    fat: goals.fat > 0 ? Math.round((d.fat/goals.fat)*100) : 0,
    fiber: goals.fiber > 0 ? Math.round((d.fiber/goals.fiber)*100) : 0
  }));
  drawBarChart('macroPctChart', [
    {data:pctData.map(d=>d.prot),color:col('--accent')||'#2E6B3E',label:'P'},
    {data:pctData.map(d=>d.carbs),color:col('--amber')||'#B7791F',label:'C'},
    {data:pctData.map(d=>d.fat),color:col('--coral')||'#C53D2F',label:'F'},
    {data:pctData.map(d=>d.fiber),color:col('--purple')||'#A855F7',label:'f'}
  ], labels, 100);
  const dwd=days.filter(d=>d.cal>0), n=dwd.length||1;
  const sum=dwd.reduce((a,d)=>({cal:a.cal+d.cal,prot:a.prot+d.prot,carbs:a.carbs+d.carbs,fat:a.fat+d.fat,fiber:a.fiber+d.fiber}),{cal:0,prot:0,carbs:0,fat:0,fiber:0});
  document.getElementById('avgCal').textContent=Math.round(sum.cal/n);
  document.getElementById('avgProt').textContent=Math.round(sum.prot/n);
  document.getElementById('avgCarbs').textContent=Math.round(sum.carbs/n);
  document.getElementById('avgFat').textContent=Math.round(sum.fat/n);
  document.getElementById('avgFiber').textContent=Math.round(sum.fiber/n);
  document.getElementById('avgLabel').textContent='Daily averages ('+trendRange+'d)';
  renderSummary(days, dwd, sum, n);
  renderDonut(sum, n);
  renderWeightChart();
  renderCompare();
  // Store dates for chart click navigation
  const dates = days.map(d => d.date);
  if (chartMeta['calChart']) chartMeta['calChart'].dates = dates;
  if (chartMeta['macroChart']) chartMeta['macroChart'].dates = dates;
  if (chartMeta['macroPctChart']) chartMeta['macroPctChart'].dates = dates;
}

function setCompare(mode) {
  compareMode = mode;
  document.querySelectorAll('#compareToggle .range-btn').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase().includes(mode==='week'?'week':mode)));
  renderCompare();
}

function getDateRange(numDays, offset) {
  const days = [];
  let weightSum = 0, weightCount = 0, exSum = 0, exDays = 0;
  for (let i = numDays - 1 + offset; i >= offset; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = fmtDate(d);
    const dm = meals.filter(m => m.date === ds);
    const t = dm.reduce((a,m) => ({cal:a.cal+m.calories,prot:a.prot+m.protein,carbs:a.carbs+m.carbs,fat:a.fat+m.fat,fiber:a.fiber+(m.fiber||0)}),{cal:0,prot:0,carbs:0,fat:0,fiber:0});
    days.push(t);
    const w = weightLog.find(w => w.date === ds);
    if (w) { weightSum += w.value; weightCount++; }
    const dayEx = exerciseLog.filter(e => e.date === ds);
    const exCal = dayEx.reduce((a,e) => a + e.calories_burned, 0);
    if (exCal > 0) { exSum += exCal; exDays++; }
  }
  const n = days.filter(d=>d.cal>0).length || 1;
  const sum = days.reduce((a,d)=>({cal:a.cal+d.cal,prot:a.prot+d.prot,carbs:a.carbs+d.carbs,fat:a.fat+d.fat,fiber:a.fiber+d.fiber}),{cal:0,prot:0,carbs:0,fat:0,fiber:0});
  return {
    avg: {cal:Math.round(sum.cal/n),prot:Math.round(sum.prot/n),carbs:Math.round(sum.carbs/n),fat:Math.round(sum.fat/n),fiber:Math.round(sum.fiber/n)},
    days: n,
    avgWeight: weightCount > 0 ? Math.round(weightSum/weightCount*10)/10 : null,
    avgExercise: exDays > 0 ? Math.round(exSum/exDays) : 0
  };
}

function renderCompare() {
  const numDays = compareMode === 'week' ? 7 : compareMode === '14d' ? 14 : 30;
  const current = getDateRange(numDays, 0);
  const prior = getDateRange(numDays, numDays);
  const labels = compareMode === 'week' ? ['This week','Last week'] : compareMode === '14d' ? ['Last 14d','Prior 14d'] : ['Last 30d','Prior 30d'];
  const metrics = [
    {label:'Avg cal/day', cur:current.avg.cal, prev:prior.avg.cal, lessIsBetter:true},
    {label:'Avg protein', cur:current.avg.prot, prev:prior.avg.prot, lessIsBetter:false},
    {label:'Avg carbs', cur:current.avg.carbs, prev:prior.avg.carbs, lessIsBetter:true},
    {label:'Avg fat', cur:current.avg.fat, prev:prior.avg.fat, lessIsBetter:true},
    {label:'Avg fiber', cur:current.avg.fiber, prev:prior.avg.fiber, lessIsBetter:false},
    {label:'Avg exercise', cur:current.avgExercise, prev:prior.avgExercise, lessIsBetter:false, suffix:' cal'},
    {label:'Avg weight', cur:current.avgWeight, prev:prior.avgWeight, lessIsBetter:true, suffix:' lbs'},
    {label:'Days tracked', cur:current.days, prev:prior.days, lessIsBetter:false}
  ];
  const container = document.getElementById('compareResult');
  let html = `<div class="compare-header"><span></span><span style="text-align:center;">${labels[0]}</span><span style="text-align:center;">${labels[1]}</span></div>`;
  metrics.forEach(m => {
    if (m.cur === null && m.prev === null) return; // skip if no data
    const curDisplay = m.cur !== null ? m.cur + (m.suffix||'') : '—';
    const prevDisplay = m.prev !== null ? m.prev + (m.suffix||'') : '—';
    const diff = (m.cur || 0) - (m.prev || 0);
    const pct = m.prev > 0 ? Math.round(Math.abs(diff)/m.prev*100) : 0;
    const isGood = diff === 0 || m.cur === null || m.prev === null ? null : (m.lessIsBetter ? diff < 0 : diff > 0);
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '';
    const deltaClass = isGood === null ? '' : isGood ? 'down' : 'up';
    html += `<div class="compare-row">
      <span class="compare-label">${m.label}</span>
      <span class="compare-val">${curDisplay} ${diff!==0 && m.cur!==null && m.prev!==null?`<span class="compare-delta ${deltaClass}">${arrow}${pct}%</span>`:''}</span>
      <span class="compare-val">${prevDisplay}</span>
    </div>`;
  });
  container.innerHTML = html;
}

function renderSummary(days, dwd, sum, n) {
  // All-time stats: days tracked, streaks
  const allDates = [...new Set(meals.map(m => m.date))].sort();
  const totalDaysTracked = allDates.length;

  // Build all-time day-by-day data for streaks
  if (allDates.length > 0) {
    const first = new Date(allDates[0] + 'T12:00:00');
    const last = new Date();
    const allDays = [];
    for (let d = new Date(first); d <= last; d.setDate(d.getDate()+1)) {
      const ds = fmtDate(d);
      const dayMeals = meals.filter(m => m.date === ds);
      const cal = dayMeals.reduce((a,m) => a + m.calories, 0);
      allDays.push({ date: ds, cal });
    }
    // Current streak (from today backwards)
    var currentStreak = 0;
    for (let i = allDays.length - 1; i >= 0; i--) {
      if (allDays[i].cal > 0 && allDays[i].cal <= goals.cal * 1.05) currentStreak++;
      else break;
    }
    // Longest streak ever
    var longestStreak = 0, tempStreak = 0;
    for (let i = 0; i < allDays.length; i++) {
      if (allDays[i].cal > 0 && allDays[i].cal <= goals.cal * 1.05) { tempStreak++; longestStreak = Math.max(longestStreak, tempStreak); }
      else tempStreak = 0;
    }
  } else {
    var currentStreak = 0, longestStreak = 0;
  }

  // 14-day average calories
  const days14 = getDayTotals(14);
  const dwd14 = days14.filter(d => d.cal > 0);
  const n14 = dwd14.length || 1;
  const avgCal14 = Math.round(dwd14.reduce((a,d) => a + d.cal, 0) / n14);

  document.getElementById('summaryGrid').innerHTML = `
    <div class="summary-cell"><div class="summary-num">${totalDaysTracked}</div><div class="summary-label">days tracked</div></div>
    <div class="summary-cell"><div class="summary-num">${currentStreak}</div><div class="summary-label">current streak</div></div>
    <div class="summary-cell"><div class="summary-num">${avgCal14}</div><div class="summary-label">avg cal (14d)</div></div>
  `;

  document.getElementById('streakRow').innerHTML = `
    <div class="streak-pill"><div class="streak-num">${longestStreak}</div><div class="streak-label">longest streak</div></div>
  `;

  // Deficit/surplus based on last 14 days of weight data (linear regression)
  const defRow = document.getElementById('deficitRow');
  const cutoff14 = new Date(); cutoff14.setDate(cutoff14.getDate() - 15);
  const recentWeight = weightLog.filter(w => new Date(w.date + 'T12:00:00') >= cutoff14);
  if (recentWeight.length >= 2) {
    const startDate = new Date(recentWeight[0].date + 'T12:00:00');
    const points = recentWeight.map(w => ({
      x: (new Date(w.date + 'T12:00:00') - startDate) / (1000*60*60*24),
      y: w.value
    }));
    const n2 = points.length;
    const sumX = points.reduce((a,p) => a+p.x, 0);
    const sumY = points.reduce((a,p) => a+p.y, 0);
    const sumXY = points.reduce((a,p) => a+p.x*p.y, 0);
    const sumX2 = points.reduce((a,p) => a+p.x*p.x, 0);
    const slope = (n2*sumXY - sumX*sumY) / (n2*sumX2 - sumX*sumX);
    if (isFinite(slope) && !isNaN(slope)) {
      const lbsPerWeek = slope * 7;
      const calPerWeek = Math.round(lbsPerWeek * 3500);
      const isDeficit = calPerWeek < 0;
      defRow.style.display = '';
      defRow.innerHTML = `<span>Estimated weekly</span> <span class="deficit-val ${isDeficit ? 'deficit' : 'surplus'}">${isDeficit ? '' : '+'}${calPerWeek} cal</span> <span>${isDeficit ? 'deficit' : 'surplus'}</span>`;
    } else { defRow.style.display = 'none'; }
  } else { defRow.style.display = 'none'; }
}

function renderDonut(sum, n) {
  const canvas = document.getElementById('donutChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const size = 140;
  canvas.width = size * dpr; canvas.height = size * dpr;
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, size, size);

  const protCal = sum.prot * 4, carbCal = sum.carbs * 4, fatCal = sum.fat * 9;
  const total = protCal + carbCal + fatCal;
  if (total === 0) {
    document.getElementById('donutLegend').innerHTML = '<span style="font-size:13px;color:var(--text-3);">No data yet</span>';
    return;
  }
  const pcts = [protCal/total, carbCal/total, fatCal/total];
  const colors = ['#3B82F6', '#F59E0B', '#EF4444'];
  const labels = ['Protein', 'Carbs', 'Fat'];
  const cx = size/2, cy = size/2, outerR = 62, innerR = 40;
  let startAngle = -Math.PI / 2;
  pcts.forEach((pct, i) => {
    const sweep = pct * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, startAngle, startAngle + sweep);
    ctx.arc(cx, cy, innerR, startAngle + sweep, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    startAngle += sweep;
  });
  const avgCal = Math.round(total / n);
  const isDark = document.documentElement.classList.contains('dark-mode') || (!document.documentElement.classList.contains('light-mode') && window.matchMedia('(prefers-color-scheme:dark)').matches);
  ctx.fillStyle = isDark ? '#E8E6E1' : '#1A1A1A';
  ctx.font = '600 18px DM Sans, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(avgCal, cx, cy - 6);
  ctx.fillStyle = '#9C9B96';
  ctx.font = '11px DM Sans, sans-serif';
  ctx.fillText('avg cal', cx, cy + 10);

  // Calculate target percentages from goals (by calorie contribution)
  const targetProtCal = goals.prot * 4, targetCarbCal = goals.carbs * 4, targetFatCal = goals.fat * 9;
  const targetTotal = targetProtCal + targetCarbCal + targetFatCal;
  const targetPcts = targetTotal > 0 ? [targetProtCal/targetTotal, targetCarbCal/targetTotal, targetFatCal/targetTotal] : [0,0,0];

  document.getElementById('donutLegend').innerHTML = labels.map((l, i) =>
    `<div class="donut-legend-item"><span class="donut-legend-dot" style="background:${colors[i]}"></span>${l}<span class="donut-legend-pct">${Math.round(pcts[i]*100)}%/${Math.round(targetPcts[i]*100)}%</span></div>`
  ).join('');
}

async function addToFavorites(meal) {
  if (favorites.some(f => f.meal_name.toLowerCase() === meal.meal_name.toLowerCase())) return;
  const fav = { meal_name:meal.meal_name, calories:meal.calories, protein:meal.protein, carbs:meal.carbs, fat:meal.fat, fiber:meal.fiber||0, type:meal.type, description:meal.description||meal.meal_name };
  if (supaReady) {
    try { const rows = await supa('favorites','POST',{body:{meal_name:fav.meal_name,calories:fav.calories,protein:fav.protein,carbs:fav.carbs,fat:fav.fat,fiber:fav.fiber,meal_type:fav.type,description:fav.description}}); fav.id=rows[0].id; } catch(e){fav.id=Date.now();}
  } else { fav.id=Date.now(); }
  favorites.unshift(fav);
  if (favorites.length>30) favorites=favorites.slice(0,30);
}

async function removeFavorite(id) {
  favorites=favorites.filter(f=>f.id!==id); renderFavorites();
  if (supaReady) { try { await supa('favorites','DELETE',{query:`id=eq.${id}`}); } catch(e){} }
}

async function quickLog(id) {
  const fav=favorites.find(f=>f.id===id); if(!fav)return;
  const now=new Date();
  const mealData = {date:fmtDate(now),time:now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),type:fav.type,meal_name:fav.meal_name,description:fav.description,calories:fav.calories,protein:fav.protein,carbs:fav.carbs,fat:fav.fat,fiber:fav.fiber||0};
  if (supaReady) {
    setSyncStatus('busy','saving…');
    try { const rows=await supa('meals','POST',{body:{date:mealData.date,time:mealData.time,meal_type:mealData.type,meal_name:mealData.meal_name,description:mealData.description,calories:mealData.calories,protein:mealData.protein,carbs:mealData.carbs,fat:mealData.fat,fiber:mealData.fiber}}); mealData.id=rows[0].id; setSyncStatus('ok','synced'); } catch(e){mealData.id=Date.now();setSyncStatus('err','sync error');}
  } else { mealData.id=Date.now(); }
  meals.unshift(mealData); viewDate=new Date();
  showQuickToast(esc(fav.meal_name) + ' logged');
}

function showQuickToast(msg) {
  const toast = document.getElementById('quickToast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

function renderFavorites() {
  const card=document.getElementById('favoritesCard'), list=document.getElementById('favList');
  if (favorites.length===0){card.style.display='none';return;}
  card.style.display='';
  list.innerHTML=favorites.map(f=>`<div class="fav-item"><div class="fav-item-left"><div class="fav-item-name">${esc(f.meal_name)}</div><div class="fav-item-macros">${f.calories} cal · ${f.protein}g P · ${f.carbs}g C · ${f.fat}g F · ${f.fiber||0}g f</div></div><div class="fav-item-actions"><button class="fav-relog" onclick="quickLog(${f.id})">Log</button><button class="fav-remove" onclick="removeFavorite(${f.id})" aria-label="Remove">✕</button></div></div>`).join('');
}

async function logWeight() {
  const input=document.getElementById('weightInput').value.trim(); if(!input)return;
  const justNum=parseFloat(input);
  if (!isNaN(justNum)&&/^\d+\.?\d*$/.test(input.trim())) { await saveWeightEntry(fmtDate(new Date()),justNum); return; }
  const key=document.getElementById('apiKey').value.trim(); if(!key)return;
  try {
    const today=fmtDate(new Date());
    const data=await callClaude(key,{model:'claude-sonnet-4-6',max_tokens:60,system:`Extract a weight in lbs and a date. Today is ${today}. Respond ONLY with JSON: {"weight":number,"date":"YYYY-MM-DD"}. Resolve relative dates relative to today.`,messages:[{role:'user',content:input}]});
    const parsed=JSON.parse(data.content[0].text.trim().replace(/```json|```/g,''));
    if(parsed.weight&&parsed.date) await saveWeightEntry(parsed.date,parsed.weight);
  } catch(e) { const m=input.match(/(\d+\.?\d*)/); if(m) await saveWeightEntry(fmtDate(new Date()),parseFloat(m[1])); }
}

async function saveWeightEntry(date,value) {
  if(!value||value<=0)return;
  const existing=weightLog.findIndex(w=>w.date===date);
  if (supaReady) {
    setSyncStatus('busy','saving…');
    try {
      if (existing>=0) { await supa('weight_log','PATCH',{query:`id=eq.${weightLog[existing].id}`,body:{value}}); weightLog[existing].value=value; }
      else { const rows=await supa('weight_log','POST',{body:{date,value}}); weightLog.push({id:rows[0].id,date,value}); }
      setSyncStatus('ok','synced');
    } catch(e) {
      if(existing>=0) weightLog[existing].value=value; else weightLog.push({date,value,id:Date.now()});
      setSyncStatus('err','sync error');
    }
  } else { if(existing>=0) weightLog[existing].value=value; else weightLog.push({date,value,id:Date.now()}); }
  weightLog.sort((a,b)=>a.date.localeCompare(b.date));
  document.getElementById('weightInput').value='';
  if(document.getElementById('tab-trends').classList.contains('active')) renderTrends();
  renderToday();
}

function renderWeightChart() {
  const chart=document.getElementById('weightChart'),empty=document.getElementById('weightEmpty');
  if(weightLog.length<1){chart.style.display='none';empty.style.display='';return;}
  chart.style.display='';empty.style.display='none';
  const recent=weightLog.slice(-trendRange);
  const labels=recent.map(w=>{const d=new Date(w.date+'T12:00:00');return d.toLocaleDateString(undefined,{month:'short',day:'numeric'});});
  const cs=getComputedStyle(document.documentElement);
  const vals = recent.map(w=>w.value);
  const minW = Math.min(...vals);
  const maxW = Math.max(...vals);
  const chartMin = Math.floor(minW - 3);
  const chartMax = Math.ceil(maxW + 3);
  drawChart('weightChart',[{data:vals,color:cs.getPropertyValue('--teal').trim()||'#1A7A6D'}],labels,null,chartMin,chartMax);
  if (chartMeta['weightChart']) chartMeta['weightChart'].dates = recent.map(w => w.date);
}

function renderTDEE() {
  const tdeeRow = document.getElementById('tdeeRow');
  if (weightLog.length < 2) { tdeeRow.style.display = 'none'; return; }
  const refDate = viewDate;
  const refDs = fmtDate(refDate);
  // Get 14 days of calorie data ending on the viewed date
  const days14 = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(refDate); d.setDate(d.getDate() - i);
    const ds = fmtDate(d);
    const dm = meals.filter(m => m.date === ds);
    const dayEx = exerciseLog.filter(e => e.date === ds);
    const cal = dm.reduce((a,m) => a + m.calories, 0);
    const ex = dayEx.reduce((a,e) => a + e.calories_burned, 0);
    if (cal > 0) days14.push({ date: ds, cal, ex });
  }
  if (days14.length < 7) { tdeeRow.style.display = 'none'; return; }
  // Get weight data for 15 days before viewed date
  const cutoff = new Date(refDate); cutoff.setDate(cutoff.getDate() - 15);
  const recentWeight = weightLog.filter(w => {
    const wd = new Date(w.date + 'T12:00:00');
    return wd >= cutoff && wd <= refDate;
  });
  if (recentWeight.length < 2) { tdeeRow.style.display = 'none'; return; }
  const startDate = new Date(recentWeight[0].date + 'T12:00:00');
  const points = recentWeight.map(w => ({
    x: (new Date(w.date + 'T12:00:00') - startDate) / (1000*60*60*24),
    y: w.value
  }));
  const n2 = points.length;
  const sumX = points.reduce((a,p) => a+p.x, 0);
  const sumY = points.reduce((a,p) => a+p.y, 0);
  const sumXY = points.reduce((a,p) => a+p.x*p.y, 0);
  const sumX2 = points.reduce((a,p) => a+p.x*p.x, 0);
  const slope = (n2*sumXY - sumX*sumY) / (n2*sumX2 - sumX*sumX);
  if (!isFinite(slope) || isNaN(slope)) { tdeeRow.style.display = 'none'; return; }
  // TDEE = avg daily intake - (daily weight change in lbs × 3500 cal/lb)
  // If losing weight (negative slope), TDEE > intake. If gaining, TDEE < intake.
  const avgIntake = days14.reduce((a,d) => a + d.cal, 0) / days14.length;
  const avgExercise = days14.reduce((a,d) => a + d.ex, 0) / days14.length;
  const tdee = Math.round(avgIntake - avgExercise - (slope * 3500));
  if (tdee < 500 || tdee > 8000) { tdeeRow.style.display = 'none'; return; } // sanity check
  document.getElementById('tdeeValue').textContent = tdee;
  tdeeRow.style.display = '';
}

function exportPDF() {
  // Build a printable report
  const today = fmtDate(new Date());
  const days30 = getDayTotals(30);
  const dwd = days30.filter(d => d.cal > 0);
  const n = dwd.length || 1;
  const sum = dwd.reduce((a,d) => ({cal:a.cal+d.cal,prot:a.prot+d.prot,carbs:a.carbs+d.carbs,fat:a.fat+d.fat,fiber:a.fiber+d.fiber}),{cal:0,prot:0,carbs:0,fat:0,fiber:0});
  const avgCal = Math.round(sum.cal/n), avgProt = Math.round(sum.prot/n), avgCarbs = Math.round(sum.carbs/n), avgFat = Math.round(sum.fat/n), avgFiber = Math.round(sum.fiber/n);
  // Recent meals (last 7 days)
  const recent = meals.filter(m => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    return new Date(m.date + 'T12:00:00') >= cutoff;
  }).sort((a,b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  // Weight
  const wRecent = weightLog.slice(-14);
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>nutritracker Report — ${today}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:700px;margin:40px auto;padding:0 20px;color:#1a1a1a;font-size:14px;}
h1{font-size:22px;margin-bottom:4px;}
h2{font-size:16px;margin-top:28px;margin-bottom:10px;border-bottom:1px solid #ddd;padding-bottom:6px;}
.subtitle{color:#666;font-size:13px;margin-bottom:24px;}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px;}
th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #eee;}
th{font-weight:600;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;}
.stat-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:10px 0;}
.stat{text-align:center;padding:12px 6px;background:#f5f5f4;border-radius:8px;}
.stat-num{font-size:20px;font-weight:600;}
.stat-label{font-size:11px;color:#666;margin-top:2px;}
.goals{color:#666;font-size:12px;margin-top:6px;}
@media print{body{margin:20px;}}
</style></head><body>
<h1>nutritracker Report</h1>
<p class="subtitle">Generated ${new Date().toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
<h2>30-Day Averages</h2>
<div class="stat-grid">
<div class="stat"><div class="stat-num">${avgCal}</div><div class="stat-label">cal/day</div></div>
<div class="stat"><div class="stat-num">${avgProt}g</div><div class="stat-label">protein</div></div>
<div class="stat"><div class="stat-num">${avgCarbs}g</div><div class="stat-label">carbs</div></div>
<div class="stat"><div class="stat-num">${avgFat}g</div><div class="stat-label">fat</div></div>
<div class="stat"><div class="stat-num">${avgFiber}g</div><div class="stat-label">fiber</div></div>
</div>
<p class="goals">Goals: ${goals.cal} cal · ${goals.prot}g P · ${goals.carbs}g C · ${goals.fat}g F · ${goals.fiber}g f</p>
<p class="goals">Days tracked: ${dwd.length} of 30</p>
${wRecent.length >= 2 ? `<h2>Weight (last 14 entries)</h2><table><tr><th>Date</th><th>Weight (lbs)</th></tr>${wRecent.map(w => `<tr><td>${w.date}</td><td>${w.value}</td></tr>`).join('')}</table>` : ''}
<h2>Meals (last 7 days)</h2>
<table><tr><th>Date</th><th>Time</th><th>Meal</th><th>Cal</th><th>P</th><th>C</th><th>F</th><th>f</th></tr>
${recent.map(m => `<tr><td>${m.date}</td><td>${m.time}</td><td>${esc(m.meal_name)}</td><td>${m.calories}</td><td>${m.protein}</td><td>${m.carbs}</td><td>${m.fat}</td><td>${m.fiber||0}</td></tr>`).join('')}
</table>
<p class="goals" style="margin-top:30px;text-align:center;">Generated by nutritracker</p>
</body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 500);
}

async function suggestMeal() {
  const key=document.getElementById('apiKey').value.trim(); if(!key)return;
  const btn=document.getElementById('suggestBtn'); btn.disabled=true;
  document.getElementById('suggestLoading').classList.add('show');
  const result=document.getElementById('suggestResult'); result.classList.remove('show');
  const today=fmtDate(new Date());
  const dayMeals=meals.filter(m=>m.date===today);
  const t=dayMeals.reduce((a,m)=>({cal:a.cal+m.calories,prot:a.prot+m.protein,carbs:a.carbs+m.carbs,fat:a.fat+m.fat,fiber:a.fiber+(m.fiber||0)}),{cal:0,prot:0,carbs:0,fat:0,fiber:0});
  const rem={cal:Math.max(0,goals.cal-t.cal),prot:Math.max(0,goals.prot-t.prot),carbs:Math.max(0,goals.carbs-t.carbs),fat:Math.max(0,goals.fat-t.fat),fiber:Math.max(0,goals.fiber-t.fiber)};
  const memCtx=memoryNotes?`\nUser's food preferences:\n${memoryNotes}`:'';
  try {
    const data=await callClaude(key,{model:'claude-sonnet-4-6',max_tokens:500,
      system:`You are a helpful nutrition assistant. Suggest a specific, practical meal. Be concrete — name actual dishes. Respond ONLY with a JSON object, no markdown:\n{"meal_name":"short name","description":"1-2 sentence description","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number}\nAll numbers integers.${memCtx}`,
      messages:[{role:'user',content:`I've eaten ${t.cal} cal today (${t.prot}g P, ${t.carbs}g C, ${t.fat}g F, ${t.fiber}g f). Remaining: ~${rem.cal} cal, ${rem.prot}g P, ${rem.carbs}g C, ${rem.fat}g F, ${rem.fiber}g f. What should I eat?`}]});
    const text=data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    const jsonMatch=text.match(/\{[\s\S]*?"meal_name"[\s\S]*?\}/);
    if (jsonMatch) {
      let s;
      try { s=JSON.parse(jsonMatch[0].replace(/```json|```/g,'').trim()); }
      catch(e) { try { s=JSON.parse(jsonMatch[0].replace(/```json|```/g,'').replace(/,\s*}/g,'}').trim()); } catch(e2) { result.innerText=text; result.classList.add('show'); return; } }
      const macros=[
        {label:'cal',val:s.calories,goal:rem.cal,color:'var(--blue)'},
        {label:'protein',val:s.protein,goal:rem.prot,color:'var(--accent)'},
        {label:'carbs',val:s.carbs,goal:rem.carbs,color:'var(--amber)'},
        {label:'fat',val:s.fat,goal:rem.fat,color:'var(--coral)'},
        {label:'fiber',val:s.fiber||0,goal:rem.fiber,color:'var(--purple)'}
      ];
      result.innerHTML=`<div class="suggest-card">
        <div class="suggest-card-name">${esc(s.meal_name)}</div>
        <div class="suggest-card-desc">${esc(s.description)}</div>
        <div class="suggest-macros">${macros.map(m=>{
          const pct=m.goal>0?Math.min(Math.round((m.val/m.goal)*100),100):100;
          return `<div class="suggest-macro-cell"><div class="suggest-macro-val">${m.val}</div><div class="suggest-macro-label">${m.label}</div><div class="suggest-macro-bar"><div class="suggest-macro-fill" style="width:${pct}%;background:${m.color}"></div></div></div>`;
        }).join('')}</div></div>`;
    } else {
      result.innerText=text;
    }
    result.classList.add('show');
  } catch(e) { result.innerText='Error: '+e.message; result.classList.add('show'); }
  finally { document.getElementById('suggestLoading').classList.remove('show'); btn.disabled=false; }
}

// === EXERCISE ===
async function logExercise() {
  const input = document.getElementById('exerciseInput').value.trim();
  if (!input) return;
  const key = document.getElementById('apiKey').value.trim();
  if (!key) return;
  try {
    const today = fmtDate(new Date());
    const data = await callClaude(key, {
      model: 'claude-sonnet-4-6', max_tokens: 100,
      system: `Extract exercise info. Today is ${today}. Respond ONLY with JSON: {"description":"short name","calories_burned":number,"date":"YYYY-MM-DD"}. Estimate calories burned based on typical values. If no date mentioned, use "${today}".`,
      messages: [{ role: 'user', content: input }]
    });
    const text = data.content[0].text.trim().replace(/```json|```/g,'');
    const parsed = JSON.parse(text);
    if (parsed.calories_burned && parsed.date) {
      const entry = { date: parsed.date, description: parsed.description || input, calories_burned: parsed.calories_burned };
      if (supaReady) {
        setSyncStatus('busy','saving…');
        try {
          const rows = await supa('exercise','POST',{body:entry});
          entry.id = rows[0].id;
          setSyncStatus('ok','synced');
        } catch(e) { entry.id = Date.now(); setSyncStatus('err','sync error'); }
      } else { entry.id = Date.now(); }
      exerciseLog.unshift(entry);
      document.getElementById('exerciseInput').value = '';
      renderToday();
    }
  } catch(e) {
    const numMatch = input.match(/(\d+)/);
    if (numMatch) {
      const entry = { date: fmtDate(new Date()), description: input, calories_burned: parseInt(numMatch[1]) };
      if (supaReady) {
        try { const rows = await supa('exercise','POST',{body:entry}); entry.id=rows[0].id; } catch(e) { entry.id=Date.now(); }
      } else { entry.id = Date.now(); }
      exerciseLog.unshift(entry);
      document.getElementById('exerciseInput').value = '';
      renderToday();
    }
  }
}

async function deleteExercise(id) {
  exerciseLog = exerciseLog.filter(e => e.id !== id);
  renderToday();
  if (supaReady) { try { await supa('exercise','DELETE',{query:`id=eq.${id}`}); } catch(e) {} }
}

// === RECIPES ===
let pendingRecipe = null;
let recipeLogId = null;

async function estimateRecipe() {
  const key = document.getElementById('apiKey').value.trim();
  const desc = document.getElementById('recipeInput').value.trim();
  const portions = parseInt(document.getElementById('recipePortions').value) || 1;
  if (!desc || !key) return;
  const btn = document.getElementById('recipeEstBtn');
  btn.disabled = true;
  document.getElementById('recipeEstimating').classList.add('show');
  document.getElementById('recipeError').classList.remove('show');
  document.getElementById('recipePreview').classList.remove('show');
  try {
    const data = await callClaude(key, {
      model: 'claude-sonnet-4-6', max_tokens: 300,
      system: `You are a nutrition assistant. The user describes a recipe that makes ${portions} serving(s). Estimate TOTAL nutrition for the entire recipe, not per serving. Respond ONLY with JSON:\n{"recipe_name":"short name","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number}\nAll numbers integers. No markdown.`,
      messages: [{ role: 'user', content: desc }]
    });
    const text = data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    const match = text.match(/\{[\s\S]*?"recipe_name"[\s\S]*?\}/);
    if (!match) throw new Error('Could not parse recipe. Try rephrasing.');
    let r;
    try { r = JSON.parse(match[0].replace(/```json|```/g,'').trim()); }
    catch(e) { try { r = JSON.parse(match[0].replace(/```json|```/g,'').replace(/,\s*}/g,'}').trim()); } catch(e2) { throw new Error('Could not parse recipe response. Try again.'); } }
    // Store per-serving values
    pendingRecipe = {
      recipe_name: r.recipe_name, description: desc, portions,
      calories: Math.round(r.calories / portions),
      protein: Math.round(r.protein / portions),
      carbs: Math.round(r.carbs / portions),
      fat: Math.round(r.fat / portions),
      fiber: Math.round((r.fiber||0) / portions)
    };
    document.getElementById('recipePreviewName').textContent = r.recipe_name;
    document.getElementById('recipePreviewPortions').textContent = portions > 1 ? `Per serving (${portions} servings total)` : '1 serving';
    document.getElementById('rpCal').textContent = pendingRecipe.calories;
    document.getElementById('rpProt').textContent = pendingRecipe.protein;
    document.getElementById('rpCarbs').textContent = pendingRecipe.carbs;
    document.getElementById('rpFat').textContent = pendingRecipe.fat;
    document.getElementById('rpFiber').textContent = pendingRecipe.fiber;
    document.getElementById('recipePreview').classList.add('show');
  } catch(e) {
    document.getElementById('recipeError').textContent = 'Error: ' + e.message;
    document.getElementById('recipeError').classList.add('show');
  } finally {
    document.getElementById('recipeEstimating').classList.remove('show');
    btn.disabled = false;
  }
}

async function confirmRecipe() {
  if (!pendingRecipe) return;
  const recipe = { ...pendingRecipe };
  if (supaReady) {
    setSyncStatus('busy','saving…');
    try {
      const rows = await supa('recipes','POST',{body:recipe});
      recipe.id = rows[0].id;
      setSyncStatus('ok','synced');
    } catch(e) { recipe.id = Date.now(); setSyncStatus('err','sync error'); }
  } else { recipe.id = Date.now(); }
  recipes.unshift(recipe);
  pendingRecipe = null;
  document.getElementById('recipeInput').value = '';
  document.getElementById('recipePortions').value = 1;
  document.getElementById('recipePreview').classList.remove('show');
  renderRecipes();
  showQuickToast(esc(recipe.recipe_name) + ' saved');
}

function cancelRecipe() {
  pendingRecipe = null;
  document.getElementById('recipePreview').classList.remove('show');
}

function renderRecipes() {
  const card = document.getElementById('recipeListCard');
  const list = document.getElementById('recipeList');
  if (recipes.length === 0) { card.style.display = 'none'; return; }
  card.style.display = '';
  const sorted = [...recipes].sort((a,b) => a.recipe_name.localeCompare(b.recipe_name));
  list.innerHTML = sorted.map(r => `<div class="recipe-item">
    <div class="recipe-item-left">
      <div class="recipe-item-name" contenteditable="false" onclick="startInlineRename(this,${r.id},'recipe')" data-id="${r.id}">${esc(r.recipe_name)}</div>
      <div class="recipe-item-macros">${r.calories} cal · ${r.protein}g P · ${r.carbs}g C · ${r.fat}g F · ${r.fiber||0}g f${r.portions && r.portions > 1 ? ' · '+r.portions+' servings' : ''}</div>
    </div>
    <div class="recipe-item-actions">
      <button class="recipe-use" onclick="openRecipeLogModal(${r.id})">+ Today</button>
      <button class="fav-remove" onclick="deleteRecipe(${r.id})" aria-label="Remove">✕</button>
    </div>
  </div>`).join('');
}

function openRecipeLogModal(id) {
  const r = recipes.find(x => x.id === id);
  if (!r) return;
  recipeLogId = id;
  document.getElementById('recipeLogTitle').textContent = 'Log: ' + r.recipe_name;
  document.getElementById('recipeLogType').value = 'Lunch';
  document.getElementById('recipeLogPortions').value = 1;
  updateRecipeLogPreview();
  document.getElementById('recipeLogOverlay').style.display = '';
  document.getElementById('recipeLogPortions').oninput = updateRecipeLogPreview;
}

function updateRecipeLogPreview() {
  const r = recipes.find(x => x.id === recipeLogId);
  if (!r) return;
  const p = parseFloat(document.getElementById('recipeLogPortions').value) || 1;
  document.getElementById('recipeLogPreview').textContent =
    `${Math.round(r.calories*p)} cal · ${Math.round(r.protein*p)}g P · ${Math.round(r.carbs*p)}g C · ${Math.round(r.fat*p)}g F · ${Math.round((r.fiber||0)*p)}g f`;
}

function closeRecipeLogModal() {
  document.getElementById('recipeLogOverlay').style.display = 'none';
  recipeLogId = null;
}

async function confirmRecipeLog() {
  const r = recipes.find(x => x.id === recipeLogId);
  if (!r) return;
  const p = parseFloat(document.getElementById('recipeLogPortions').value) || 1;
  const type = document.getElementById('recipeLogType').value;
  const now = new Date();
  const mealData = {
    date: fmtDate(now), time: now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),
    type, meal_name: p !== 1 ? `${r.recipe_name} (×${p})` : r.recipe_name,
    description: r.description,
    calories: Math.round(r.calories*p), protein: Math.round(r.protein*p),
    carbs: Math.round(r.carbs*p), fat: Math.round(r.fat*p), fiber: Math.round((r.fiber||0)*p)
  };
  if (supaReady) {
    setSyncStatus('busy','saving…');
    try {
      const rows = await supa('meals','POST',{body:{date:mealData.date,time:mealData.time,meal_type:mealData.type,meal_name:mealData.meal_name,description:mealData.description,calories:mealData.calories,protein:mealData.protein,carbs:mealData.carbs,fat:mealData.fat,fiber:mealData.fiber}});
      mealData.id = rows[0].id;
      setSyncStatus('ok','synced');
    } catch(e) { mealData.id = Date.now(); setSyncStatus('err','sync error'); }
  } else { mealData.id = Date.now(); }
  meals.unshift(mealData);
  closeRecipeLogModal();
  showQuickToast(esc(mealData.meal_name) + ' logged');
}

async function logRecipe(id) {
  openRecipeLogModal(id);
}

async function deleteRecipe(id) {
  recipes = recipes.filter(r => r.id !== id);
  renderRecipes();
  if (supaReady) { try { await supa('recipes','DELETE',{query:`id=eq.${id}`}); } catch(e) {} }
}

// Add meal group as recipe
async function addMealGroupAsRecipe(type, date) {
  const groupMeals = meals.filter(m => m.date === date && m.type === type);
  if (groupMeals.length === 0) return;
  const combined = groupMeals.reduce((a,m) => ({
    cal:a.cal+m.calories, prot:a.prot+m.protein, carbs:a.carbs+m.carbs,
    fat:a.fat+m.fat, fiber:a.fiber+(m.fiber||0)
  }),{cal:0,prot:0,carbs:0,fat:0,fiber:0});
  const name = type + ' — ' + groupMeals.map(m => m.meal_name).join(', ');
  const desc = groupMeals.map(m => m.description || m.meal_name).join('; ');
  const recipe = { recipe_name: name, description: desc, portions: 1, calories: combined.cal, protein: combined.prot, carbs: combined.carbs, fat: combined.fat, fiber: combined.fiber };
  if (supaReady) {
    setSyncStatus('busy','saving…');
    try {
      const rows = await supa('recipes','POST',{body:recipe});
      recipe.id = rows[0].id;
      setSyncStatus('ok','synced');
    } catch(e) { recipe.id = Date.now(); setSyncStatus('err','sync error'); }
  } else { recipe.id = Date.now(); }
  recipes.unshift(recipe);
  renderRecipes();
  showQuickToast(type + ' saved as recipe');
}

// === THEME ===
function setTheme(mode) {
  document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.theme === mode));
  document.documentElement.classList.remove('dark-mode','light-mode');
  if (mode === 'dark') document.documentElement.classList.add('dark-mode');
  else if (mode === 'light') document.documentElement.classList.add('light-mode');
  try { localStorage.setItem('nutritracker_theme', mode); } catch(e) {}
  if (supaReady && currentUser) { supa('settings','PATCH',{query:'user_id=eq.'+currentUser.id,body:{theme:mode}}).catch(()=>{}); }
}
function loadTheme() {
  const saved = localStorage.getItem('nutritracker_theme') || 'system';
  setTheme(saved);
}
function loadThemeFromSupabase(theme) {
  if (theme && theme !== 'system') {
    setTheme(theme);
  }
}

// Refresh auth token every 45 minutes to prevent expiry
setInterval(async () => {
  if (authToken && currentUser) {
    const refreshed = await refreshSession();
    if (refreshed) console.log('Token refreshed');
    else console.warn('Token refresh failed');
  }
}, 45 * 60 * 1000);

// Chart click navigation
['calChart','macroChart','macroPctChart','weightChart'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', e => {
    const meta = chartMeta[id];
    if (!meta || !meta.dates) return;
    const rect = el.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    // Find nearest data point
    let nearestIdx = 0, nearestDist = Infinity;
    meta.dates.forEach((d, i) => {
      let pointX;
      if (meta.step) {
        pointX = meta.padL + i * meta.step;
      } else if (meta.groupWidth != null) {
        pointX = meta.padL + i * (meta.groupWidth + (meta.groupGap||0)) + meta.groupWidth/2;
      } else return;
      const dist = Math.abs(clickX - pointX);
      if (dist < nearestDist) { nearestDist = dist; nearestIdx = i; }
    });
    if (nearestDist < 40 && meta.dates[nearestIdx]) {
      viewDate = new Date(meta.dates[nearestIdx] + 'T12:00:00');
      switchTab('today');
    }
  });
});

init();
