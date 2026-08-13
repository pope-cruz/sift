const TOKEN_KEY = 'sift.demo.session.v1';
const state = { token: localStorage.getItem(TOKEN_KEY) || '', busy: false, file: null, lastPayload: null, expiresAt: null, typing: null };
const $ = (selector) => document.querySelector(selector);
const transcript = $('#transcript');
const emptyState = $('#empty-state');
const form = $('#composer');
const input = $('#message-input');
const fileInput = $('#file-input');
const notice = $('#notice');
const quotaLabel = $('#quota-label');
const statusLabel = $('#conversation-status');
const sendButton = $('#send-button');
const starters = [...document.querySelectorAll('[data-scenario]')];

function uuid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function showNotice(message, kind = 'error') { notice.hidden = !message; notice.textContent = message || ''; notice.dataset.kind = kind; }
function setBusy(value) { state.busy = value; sendButton.disabled = value; starters.forEach((button) => { button.disabled = value; }); statusLabel.textContent = value ? 'Working through it…' : 'Ready when you are'; }
function scrollEnd() { requestAnimationFrame(() => transcript.scrollTo({ top: transcript.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })); }
function hideEmpty() { if (emptyState) emptyState.hidden = true; }
function formatBytes(value) { return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function textWithLinks(text) {
  const fragment = document.createDocumentFragment();
  const matcher = /(https?:\/\/[^\s]+)/g; let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    fragment.append(document.createTextNode(text.slice(cursor, match.index)));
    const link = document.createElement('a'); link.href = match[0]; link.textContent = match[0]; link.target = '_blank'; link.rel = 'noreferrer noopener'; fragment.append(link);
    cursor = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(text.slice(cursor))); return fragment;
}
function addBubble(side, text, attachment) {
  hideEmpty(); const row = document.createElement('div'); row.className = `row ${side}-row`; const bubble = document.createElement('div'); bubble.className = `bubble ${side}-bubble`;
  if (attachment) { const file = document.createElement('div'); file.className = 'message-file'; const icon = document.createElement('span'); icon.className = 'mini-file'; icon.textContent = attachment.mimeType === 'application/pdf' ? 'PDF' : 'IMG'; file.append(icon, document.createTextNode(attachment.name)); bubble.append(file); }
  bubble.append(textWithLinks(text)); row.append(bubble); transcript.append(row); scrollEnd();
}
function removeTyping() { state.typing?.remove(); state.typing = null; }
function setTyping(active) { removeTyping(); if (!active) return; hideEmpty(); state.typing = $('#typing-template').content.firstElementChild.cloneNode(true); transcript.append(state.typing); scrollEnd(); }
function addError(message, retry = false) { removeTyping(); hideEmpty(); const row = document.createElement('div'); row.className = 'error-row'; row.append(document.createTextNode(message)); if (retry && state.lastPayload) { const button = document.createElement('button'); button.className = 'retry-button'; button.type = 'button'; button.textContent = 'Retry'; button.onclick = () => sendPayload({ ...state.lastPayload, clientMessageId: uuid() }); row.append(button); } transcript.append(row); scrollEnd(); }
function addPresentation(data) {
  if (!data || typeof data !== 'object') return; hideEmpty();
  if (data.type === 'source') { const chip = document.createElement('div'); chip.className = 'source-chip'; chip.textContent = [data.label, data.detail].filter(Boolean).join(' · '); transcript.append(chip); scrollEnd(); return; }
  const card = document.createElement('div'); card.className = 'presentation';
  if (data.type === 'saved_place') { card.classList.add('place-card'); const title = document.createElement('strong'); title.textContent = data.title; const detail = document.createElement('span'); detail.className = 'presentation-detail'; detail.textContent = data.detail || 'Saved place'; card.append(title, detail); }
  else if (data.type === 'reminder_jump') { card.classList.add('reminder-card'); const copy = document.createElement('div'); const title = document.createElement('strong'); title.textContent = 'Reminder is ready to test'; const time = document.createElement('span'); time.textContent = `Jump to ${new Intl.DateTimeFormat([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(data.targetTime))}`; copy.append(title, time); const button = document.createElement('button'); button.className = 'jump-button'; button.type = 'button'; button.textContent = 'Jump to reminder'; button.onclick = async () => { button.disabled = true; await fastForward(); button.textContent = 'Checked'; }; card.append(copy, button); }
  else { const head = document.createElement('div'); head.className = 'presentation-head'; head.textContent = data.title || (data.type === 'deadline_list' ? 'Deadlines' : 'Tasks'); const list = document.createElement('ul'); list.className = 'presentation-list'; for (const item of data.items || []) { const li = document.createElement('li'); const label = document.createElement('span'); label.textContent = item.label; const date = document.createElement('time'); date.textContent = item.date ? new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).format(new Date(`${item.date}T12:00:00`)) : 'Saved'; li.append(label, date); list.append(li); } card.append(head, list); }
  transcript.append(card); scrollEnd();
}
function consumeEvent(event, restoring = false) {
  if (!event || !event.type) return;
  if (event.type === 'user') addBubble('user', event.text || '', event.attachment);
  if (event.type === 'assistant') { removeTyping(); addBubble('assistant', event.text); }
  if (event.type === 'typing' && !restoring) setTyping(event.active);
  if (event.type === 'presentation') addPresentation(event.presentation);
  if (event.type === 'quota') quotaLabel.textContent = `${event.turnsRemaining} ${event.turnsRemaining === 1 ? 'turn' : 'turns'} left`;
  if (event.type === 'error') addError(event.message, event.code === 'PROCESSING_FAILED');
}
async function api(path, options = {}) { const headers = new Headers(options.headers || {}); if (state.token) headers.set('Authorization', `Bearer ${state.token}`); const response = await fetch(`/api/demo/${path}`, { ...options, headers }); if (!response.ok) { const body = await response.json().catch(() => ({})); const error = new Error(body.error?.message || 'The demo could not be reached.'); error.code = body.error?.code; throw error; } return response; }
async function openSession() {
  setBusy(true); showNotice('');
  try { const response = await fetch('/api/demo/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: state.token || undefined, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }) }); const body = await response.json().catch(() => null); if (!body) throw new Error('The interactive API is unavailable in this preview.'); if (!response.ok) throw new Error(body.error?.message || 'Could not start the demo.'); state.token = body.token; state.expiresAt = body.expiresAt; localStorage.setItem(TOKEN_KEY, state.token); quotaLabel.textContent = `${body.quota.turnsRemaining} turns left`; for (const event of body.transcript || []) consumeEvent(event, true); tickExpiry(); }
  catch (error) { showNotice(error.message); }
  finally { setBusy(false); }
}
async function sendPayload(payload) {
  if (state.busy || !state.token) return; state.lastPayload = payload; setBusy(true); showNotice('');
  const clientMessageId = payload.clientMessageId || uuid(); const data = new FormData(); data.set('clientMessageId', clientMessageId); if (payload.text) data.set('text', payload.text); if (payload.scenarioId) data.set('scenarioId', payload.scenarioId);
  try {
    if (payload.file) {
      const reservationResponse = await api('upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientMessageId, filename: payload.file.name, mimeType: payload.file.type, size: payload.file.size }) });
      const reservation = await reservationResponse.json();
      if (!reservation.alreadyUploaded) {
        const uploadBody = new FormData(); uploadBody.append('cacheControl', '3600'); uploadBody.append('', payload.file);
        const uploaded = await fetch(reservation.signedUrl, { method: 'PUT', headers: { 'x-upsert': 'false' }, body: uploadBody });
        if (!uploaded.ok) throw new Error('The file upload did not finish. Try attaching it again.');
      }
      data.set('uploadId', reservation.uploadId);
    }
    const response = await api('turn', { method: 'POST', body: data }); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; for (const line of lines) if (line.trim()) consumeEvent(JSON.parse(line)); if (done) { if (buffer.trim()) consumeEvent(JSON.parse(buffer)); break; } }
  }
  catch (error) { addError(error.message, true); if (error.code === 'SESSION_EXPIRED') { localStorage.removeItem(TOKEN_KEY); state.token = ''; } }
  finally { removeTyping(); setBusy(false); }
}
async function fastForward() { if (state.busy) return; setBusy(true); try { const response = await api('reminders/fast-forward', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientMessageId: uuid() }) }); const body = await response.json(); for (const event of body.events || []) consumeEvent(event); } catch (error) { addError(error.message); } finally { setBusy(false); } }
function setFile(file) { if (!file) return clearFile(); if (file.size > 8 * 1024 * 1024) return showNotice('That file is over the demo’s 8 MB limit.'); if (!['application/pdf','image/jpeg','image/png','image/webp'].includes(file.type)) return showNotice('Use a PDF, JPEG, PNG, or WebP file.'); state.file = file; $('#file-preview').hidden = false; $('#file-name').textContent = file.name; $('#file-size').textContent = formatBytes(file.size); showNotice(''); }
function clearFile() { state.file = null; fileInput.value = ''; $('#file-preview').hidden = true; }
function tickExpiry() { if (!state.expiresAt) return; const left = new Date(state.expiresAt).getTime() - Date.now(); if (left <= 0) { $('#expiry-label').textContent = 'Demo expired'; sendButton.disabled = true; return; } const hours = Math.max(1, Math.ceil(left / 3600000)); $('#expiry-label').textContent = `${hours}h access left`; }
form.addEventListener('submit', (event) => { event.preventDefault(); const text = input.value.trim(); if (!text && !state.file) return; const payload = { text, file: state.file, clientMessageId: uuid() }; input.value = ''; input.style.height = ''; $('#character-count').textContent = '0 / 2,000'; clearFile(); sendPayload(payload); });
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight,150)}px`; $('#character-count').textContent = `${input.value.length.toLocaleString()} / 2,000`; });
input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
fileInput.addEventListener('change', () => setFile(fileInput.files[0])); $('#remove-file').addEventListener('click', clearFile);
const drop = $('#drop-target'); for (const type of ['dragenter','dragover']) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add('dragging'); }); for (const type of ['dragleave','drop']) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove('dragging'); }); drop.addEventListener('drop', (event) => setFile(event.dataTransfer.files[0]));
starters.forEach((button) => button.addEventListener('click', () => sendPayload({ scenarioId: button.dataset.scenario, clientMessageId: uuid() })));
$('#reset-button').addEventListener('click', async () => { if (!state.token || !confirm('Delete this demo and everything it saved?')) return; setBusy(true); try { const response = await api('session', { method: 'DELETE' }); const fresh = await response.json(); localStorage.setItem(TOKEN_KEY, fresh.token); location.reload(); } catch (error) { showNotice(error.message); setBusy(false); } });
function onlineState() { const online = navigator.onLine; $('#connection-dot').classList.toggle('offline', !online); if (!online) showNotice('You’re offline. Your saved demo will still be here when you reconnect.'); else if (notice.textContent.startsWith('You’re offline')) showNotice(''); }
addEventListener('online', onlineState); addEventListener('offline', onlineState); addEventListener('storage', (event) => { if (event.key === TOKEN_KEY && event.newValue !== state.token) location.reload(); }); setInterval(tickExpiry, 60000); onlineState(); openSession();
