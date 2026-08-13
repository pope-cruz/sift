const TOKEN_KEY = 'sift.demo.session.v1';
const state = { token: localStorage.getItem(TOKEN_KEY) || '', phase: 'initializing', busy: false, online: navigator.onLine, turnsRemaining: 12, file: null, lastPayload: null, expiresAt: null, typing: null };
const $ = (selector) => document.querySelector(selector);
const transcript = $('#transcript');
const emptyState = $('#empty-state');
const form = $('#composer');
const input = $('#message-input');
const fileInput = $('#file-input');
const notice = $('#notice');
const noticeText = $('#notice-text');
const sessionRetry = $('#session-retry');
const quotaLabel = $('#quota-label');
const statusLabel = $('#conversation-status');
const sendButton = $('#send-button');
const demoControl = $('#demo-control');
const demoControlTime = $('#demo-control-time');
const jumpButton = $('#jump-button');
const starters = [...document.querySelectorAll('[data-scenario]')];
const attachButton = document.querySelector('.attach-button');

function uuid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function showNotice(message, kind = 'error', retry = false) { notice.hidden = !message; noticeText.textContent = message || ''; notice.dataset.kind = kind; sessionRetry.hidden = !retry; }
function isReady() { return state.phase === 'ready' && state.online && state.turnsRemaining > 0; }
function syncControls() {
  const disabled = state.busy || !isReady();
  sendButton.disabled = disabled;
  input.disabled = disabled;
  fileInput.disabled = disabled;
  starters.forEach((button) => { button.disabled = disabled; });
  attachButton.setAttribute('aria-disabled', String(disabled));
  attachButton.classList.toggle('disabled', disabled);
  form.setAttribute('aria-busy', String(state.busy));
  const labels = { initializing: 'Starting your demo…', ready: 'Ready when you are', capped: 'Demo limit reached', expired: 'Demo expired', exhausted: 'Turn limit reached', unavailable: 'Demo unavailable' };
  statusLabel.textContent = state.busy ? 'Working through it…' : (labels[state.phase] || 'Ready when you are');
}
function setPhase(value) { state.phase = value; syncControls(); }
function setBusy(value) { state.busy = value; syncControls(); }
function scrollEnd() { requestAnimationFrame(() => transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'auto' })); }
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
function addBubble(side, text, attachment, animate = true) {
  hideEmpty(); const row = document.createElement('div'); row.className = `row ${side}-row${animate ? ' is-new' : ''}`; const bubble = document.createElement('div'); bubble.className = `bubble ${side}-bubble`;
  if (attachment) { const file = document.createElement('div'); file.className = 'message-file'; const icon = document.createElement('span'); icon.className = 'mini-file'; icon.textContent = attachment.mimeType === 'application/pdf' ? 'PDF' : 'IMG'; file.append(icon, document.createTextNode(attachment.name)); bubble.append(file); }
  bubble.append(textWithLinks(text)); row.append(bubble); transcript.append(row); scrollEnd();
}
function removeTyping() { state.typing?.remove(); state.typing = null; }
function setTyping(active) { removeTyping(); if (!active) return; hideEmpty(); state.typing = $('#typing-template').content.firstElementChild.cloneNode(true); transcript.append(state.typing); scrollEnd(); }
function addError(message, retry = false) { removeTyping(); hideEmpty(); const row = document.createElement('div'); row.className = 'error-row'; row.setAttribute('role', 'status'); row.append(document.createTextNode(message)); if (retry && state.lastPayload) { const button = document.createElement('button'); button.className = 'retry-button'; button.type = 'button'; button.textContent = 'Retry'; button.onclick = () => { row.remove(); sendPayload(state.lastPayload); }; row.append(button); } transcript.append(row); scrollEnd(); }
function applyPresentation(data) {
  if (!data || typeof data !== 'object') return;
  // Structured metadata stays available to the product, but only the
  // fast-forward control is visible here. Sift's Messages replies are plain
  // text, so deadline/task/place cards would misrepresent the real channel.
  if (data.type === 'reminder_cleared') {
    demoControl.hidden = true;
    return;
  }
  if (data.type === 'reminder_jump') {
    demoControlTime.textContent = `Reminder scheduled for ${new Intl.DateTimeFormat([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(data.targetTime))}`;
    demoControl.hidden = false;
  }
}
function consumeEvent(event, restoring = false) {
  if (!event || !event.type) return;
  if (event.type === 'user') addBubble('user', event.text || '', event.attachment, !restoring);
  if (event.type === 'assistant') { removeTyping(); addBubble('assistant', event.text, undefined, !restoring); }
  if (event.type === 'typing' && !restoring) setTyping(event.active);
  if (event.type === 'presentation') applyPresentation(event.presentation);
  if (event.type === 'quota') { state.turnsRemaining = event.turnsRemaining; quotaLabel.textContent = `${event.turnsRemaining} ${event.turnsRemaining === 1 ? 'turn' : 'turns'} left`; if (event.turnsRemaining <= 0) setPhase('exhausted'); else syncControls(); }
  if (event.type === 'error') addError(event.message, ['PROCESSING_FAILED','TURN_IN_PROGRESS'].includes(event.code));
}
async function api(path, options = {}) { const headers = new Headers(options.headers || {}); if (state.token) headers.set('Authorization', `Bearer ${state.token}`); const response = await fetch(`/api/demo/${path}`, { ...options, headers }); if (!response.ok) { const body = await response.json().catch(() => ({})); const error = new Error(body.error?.message || 'The demo could not be reached.'); error.code = body.error?.code; throw error; } return response; }
async function openSession() {
  setPhase('initializing'); setBusy(true); showNotice('');
  try { const response = await fetch('/api/demo/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: state.token || undefined, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }) }); const body = await response.json().catch(() => null); if (!body) throw new Error('The interactive API is unavailable in this preview.'); if (!response.ok) { const error = new Error(body.error?.message || 'Could not start the demo.'); error.code = body.error?.code; throw error; } state.token = body.token; state.expiresAt = body.expiresAt; state.turnsRemaining = body.quota.turnsRemaining; localStorage.setItem(TOKEN_KEY, state.token); quotaLabel.textContent = `${body.quota.turnsRemaining} turns left`; for (const event of body.transcript || []) consumeEvent(event, true); setPhase(body.quota.turnsRemaining > 0 ? 'ready' : 'exhausted'); tickExpiry(); }
  catch (error) { setPhase(error.code === 'SESSION_CREATION_CAP' ? 'capped' : 'unavailable'); showNotice(error.message, 'error', error.code !== 'SESSION_CREATION_CAP'); }
  finally { setBusy(false); }
}
async function sendPayload(payload) {
  if (state.busy) return; if (!state.token || !isReady()) { showNotice(state.online ? 'The demo is not ready yet.' : 'You’re offline. Reconnect to send.'); return; } state.lastPayload = payload; setBusy(true); showNotice('');
  const clientMessageId = payload.clientMessageId || uuid(); const data = new FormData(); data.set('clientMessageId', clientMessageId); if (payload.text) data.set('text', payload.text); if (payload.scenarioId) data.set('scenarioId', payload.scenarioId);
  let reservation = null; let turnStarted = false;
  try {
    if (payload.file) {
      const reservationResponse = await api('upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientMessageId, filename: payload.file.name, mimeType: payload.file.type, size: payload.file.size }) });
      reservation = await reservationResponse.json();
      if (!reservation.alreadyUploaded) {
        const uploadBody = new FormData(); uploadBody.append('cacheControl', '3600'); uploadBody.append('', payload.file);
        const uploaded = await fetch(reservation.signedUrl, { method: 'PUT', headers: { 'x-upsert': 'false' }, body: uploadBody });
        if (!uploaded.ok) throw new Error('The file upload did not finish. Try attaching it again.');
      }
      data.set('uploadId', reservation.uploadId);
    }
    turnStarted = true; const response = await api('turn', { method: 'POST', body: data }); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; for (const line of lines) if (line.trim()) consumeEvent(JSON.parse(line)); if (done) { if (buffer.trim()) consumeEvent(JSON.parse(buffer)); break; } }
  }
  catch (error) { if (reservation && !turnStarted) await api('upload/release', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: reservation.uploadId }) }).catch(() => {}); addError(error.message, !['SESSION_EXPIRED','TURN_QUOTA_EXHAUSTED','ATTACHMENT_QUOTA_EXHAUSTED','ATTACHMENT_BYTES_EXHAUSTED'].includes(error.code)); if (error.code === 'SESSION_EXPIRED') { localStorage.removeItem(TOKEN_KEY); state.token = ''; setPhase('expired'); } else if (String(error.code || '').includes('QUOTA')) setPhase('exhausted'); }
  finally { removeTyping(); setBusy(false); }
}
async function fastForward() { if (state.busy) return false; setBusy(true); try { const response = await api('reminders/fast-forward', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientMessageId: uuid() }) }); const body = await response.json(); for (const event of body.events || []) consumeEvent(event); return (body.events || []).some((event) => event.type === 'assistant'); } catch (error) { addError(error.message); return false; } finally { setBusy(false); } }
jumpButton.addEventListener('click', async () => {
  jumpButton.disabled = true;
  const delivered = await fastForward();
  if (delivered) demoControl.hidden = true;
  jumpButton.disabled = false;
});
function setFile(file) { if (!file) return clearFile(); if (file.size > 8 * 1024 * 1024) return showNotice('That file is over the demo’s 8 MB limit.'); if (!['application/pdf','image/jpeg','image/png','image/webp'].includes(file.type)) return showNotice('Use a PDF, JPEG, PNG, or WebP file.'); state.file = file; $('#file-preview').hidden = false; $('#file-name').textContent = file.name; $('#file-size').textContent = formatBytes(file.size); showNotice(''); }
function clearFile() { state.file = null; fileInput.value = ''; $('#file-preview').hidden = true; }
function tickExpiry() { if (!state.expiresAt) return; const left = new Date(state.expiresAt).getTime() - Date.now(); if (left <= 0) { $('#expiry-label').textContent = 'Demo expired'; setPhase('expired'); return; } const hours = Math.max(1, Math.ceil(left / 3600000)); $('#expiry-label').textContent = `${hours}h access left`; }
form.addEventListener('submit', (event) => { event.preventDefault(); const text = input.value.trim(); if (!text && !state.file) return; const payload = { text, file: state.file, clientMessageId: uuid() }; input.value = ''; input.style.height = ''; $('#character-count').textContent = '0 / 2,000'; clearFile(); sendPayload(payload); });
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight,150)}px`; $('#character-count').textContent = `${input.value.length.toLocaleString()} / 2,000`; });
input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
fileInput.addEventListener('change', () => setFile(fileInput.files[0])); $('#remove-file').addEventListener('click', clearFile);
const drop = $('#drop-target'); for (const type of ['dragenter','dragover']) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add('dragging'); }); for (const type of ['dragleave','drop']) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove('dragging'); }); drop.addEventListener('drop', (event) => setFile(event.dataTransfer.files[0]));
starters.forEach((button) => button.addEventListener('click', () => sendPayload({ scenarioId: button.dataset.scenario, clientMessageId: uuid() })));
$('#reset-button').addEventListener('click', async () => { if (!state.token || !confirm('Delete this demo and everything it saved?')) return; setBusy(true); try { const response = await api('session', { method: 'DELETE' }); const fresh = await response.json(); localStorage.setItem(TOKEN_KEY, fresh.token); location.reload(); } catch (error) { showNotice(error.message); setBusy(false); } });
function onlineState() { state.online = navigator.onLine; $('#connection-dot').classList.toggle('offline', !state.online); if (!state.online) showNotice('You’re offline. Your saved demo will still be here when you reconnect.'); else if (noticeText.textContent.startsWith('You’re offline')) showNotice(''); syncControls(); }
sessionRetry.addEventListener('click', openSession);
addEventListener('online', onlineState); addEventListener('offline', onlineState); addEventListener('storage', (event) => { if (event.key === TOKEN_KEY && event.newValue !== state.token) location.reload(); }); setInterval(tickExpiry, 60000); onlineState(); openSession();
