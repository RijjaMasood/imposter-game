/* Imposter — client. Plain JS, no build step. */

const $ = (id) => document.getElementById(id);

const LS = {
  get id() { return localStorage.getItem('imposter.playerId') || ''; },
  set id(v) { v ? localStorage.setItem('imposter.playerId', v) : localStorage.removeItem('imposter.playerId'); },
  get code() { return localStorage.getItem('imposter.code') || ''; },
  set code(v) { v ? localStorage.setItem('imposter.code', v) : localStorage.removeItem('imposter.code'); },
  get name() { return localStorage.getItem('imposter.name') || ''; },
  set name(v) { v ? localStorage.setItem('imposter.name', v) : localStorage.removeItem('imposter.name'); }
};

let state = null;
let pollTimer = null;
let busy = false;
let lastPlayersSig = '';
let lastVoteSig = '';

/* ------------------------------------------------------------------ utils */

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Wrap a button action: disable while in flight, toast failures. */
function action(button, fn) {
  return async (...args) => {
    if (busy) return;
    busy = true;
    if (button) button.disabled = true;
    try {
      await fn(...args);
    } catch (err) {
      toast(err.message);
      if (err.status === 403 || err.status === 404) goHome();
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  };
}

/* ------------------------------------------------------------ home / join */

function goHome(message) {
  stopPolling();
  state = null;
  LS.code = '';
  LS.id = '';
  lastPlayersSig = lastVoteSig = '';
  $('screen-room').hidden = true;
  $('screen-home').hidden = false;
  $('input-name').value = LS.name;
  if (message) toast(message);
}

function enterRoom(payload) {
  LS.id = payload.playerId;
  LS.code = payload.code;
  $('screen-home').hidden = true;
  $('screen-room').hidden = false;
  lastPlayersSig = lastVoteSig = '';
  render(payload.state);
  startPolling();
}

$('btn-create').onclick = action($('btn-create'), async () => {
  const name = $('input-name').value.trim();
  if (!name) return toast('Enter your name first.');
  LS.name = name;
  enterRoom(await api('POST', '/api/rooms', { name }));
});

$('btn-join').onclick = action($('btn-join'), async () => {
  const name = $('input-name').value.trim();
  const code = $('input-code').value.trim().toUpperCase();
  if (!name) return toast('Enter your name first.');
  if (code.length !== 4) return toast('Room codes are 4 characters.');
  LS.name = name;
  enterRoom(await api('POST', `/api/rooms/${code}/join`, { name, playerId: LS.id }));
});

$('input-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

for (const el of [$('input-name'), $('input-code')]) {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    ($('input-code').value.trim().length === 4 ? $('btn-join') : $('btn-create')).click();
  });
}

/* --------------------------------------------------------------- polling */

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 1500);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function poll() {
  if (!LS.code || !LS.id || document.hidden || busy) return;
  try {
    const { state: next } = await api('GET', `/api/rooms/${LS.code}?playerId=${encodeURIComponent(LS.id)}`);
    render(next);
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      goHome(err.message);
    }
    // network blips: keep polling silently
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && LS.code) poll();
});

/* ---------------------------------------------------------------- render */

function render(next) {
  const prev = state;
  state = next;
  const you = state.you;
  if (!you) return goHome('You left this room.');

  const isAdmin = you.isHost;
  const phase = state.phase;

  $('room-code').textContent = state.code;
  $('player-count').textContent = String(state.players.length);
  $('round-badge').hidden = state.round === 0;
  $('round-badge').textContent = `Round ${state.round}`;

  if (!prev || prev.phase !== phase || prev.round !== state.round) {
    hideWord();
  }

  renderPlayers(isAdmin, phase);

  $('panel-lobby').hidden = phase !== 'lobby';
  $('panel-reveal').hidden = phase !== 'reveal';
  $('panel-voting').hidden = phase !== 'voting';
  $('panel-results').hidden = phase !== 'results';

  if (phase === 'lobby') renderLobby(isAdmin);
  if (phase === 'reveal') renderReveal(isAdmin);
  if (phase === 'voting') renderVoting(isAdmin);
  if (phase === 'results') renderResults(isAdmin);
}

function renderPlayers(isAdmin, phase) {
  const sig = JSON.stringify([
    isAdmin,
    phase,
    state.players.map((p) => [p.id, p.name, p.isHost, p.online, p.hasVoted])
  ]);
  if (sig === lastPlayersSig) return;
  lastPlayersSig = sig;

  const list = $('player-list');
  list.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = 'dot' + (p.online ? '' : ' off');
    li.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = p.name;
    li.appendChild(name);

    if (p.id === state.you.id) li.appendChild(tag('you', 'you'));
    if (p.isHost) li.appendChild(tag('admin'));
    if (phase === 'voting' && p.hasVoted) li.appendChild(tag('voted', 'voted'));

    if (isAdmin && p.id !== state.you.id) {
      const kick = document.createElement('button');
      kick.className = 'kick';
      kick.textContent = '×';
      kick.title = `Remove ${p.name}`;
      kick.onclick = action(kick, async () => {
        const { state: s } = await api('POST', `/api/rooms/${state.code}/kick`, {
          playerId: state.you.id,
          targetId: p.id
        });
        render(s);
      });
      li.appendChild(kick);
    }

    list.appendChild(li);
  }
}

function tag(text, extra) {
  const el = document.createElement('span');
  el.className = 'tag' + (extra ? ` ${extra}` : '');
  el.textContent = text;
  return el;
}

/* ----------------------------------------------------------------- lobby */

function renderLobby(isAdmin) {
  $('admin-lobby').hidden = !isAdmin;
  const enough = state.players.length >= 3;
  $('btn-start').disabled = !enough;
  $('lobby-hint').textContent = enough
    ? (isAdmin ? 'Everyone in? Deal the words.' : "The admin starts the round when everyone's in.")
    : `Need at least 3 players — ${3 - state.players.length} more to go.`;

  for (const btn of document.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('on', Number(btn.dataset.imposters) === state.imposterCount);
    btn.disabled = state.players.length < Number(btn.dataset.imposters) + 2;
  }
}

for (const btn of document.querySelectorAll('.seg-btn')) {
  btn.onclick = action(null, async () => {
    const { state: s } = await api('POST', `/api/rooms/${state.code}/imposters`, {
      playerId: state.you.id,
      count: Number(btn.dataset.imposters)
    });
    render(s);
  });
}

$('btn-start').onclick = action($('btn-start'), async () => {
  const { state: s } = await api('POST', `/api/rooms/${state.code}/start`, { playerId: state.you.id });
  render(s);
});

/* ---------------------------------------------------------------- reveal */

function renderReveal(isAdmin) {
  $('btn-open-voting').hidden = !isAdmin;
  $('reveal-wait').hidden = isAdmin;
}

function showWord() {
  if (!state || state.phase !== 'reveal') return;
  const card = $('reveal-card');
  const isImposter = state.you.role === 'imposter';
  const wordEl = $('reveal-word');

  wordEl.textContent = isImposter ? "YOU'RE THE IMPOSTER" : state.you.word || '';
  wordEl.classList.toggle('imposter', isImposter);
  $('reveal-role').textContent = isImposter
    ? 'Blend in. Work out the word before they work out you.'
    : 'Everyone else sees this too — except the imposter.';

  card.querySelector('.reveal-hidden').hidden = true;
  card.querySelector('.reveal-shown').hidden = false;
  card.classList.add('open');
}

function hideWord() {
  const card = $('reveal-card');
  card.querySelector('.reveal-hidden').hidden = false;
  card.querySelector('.reveal-shown').hidden = true;
  card.classList.remove('open');
  $('reveal-word').textContent = '';
}

const revealCard = $('reveal-card');
revealCard.addEventListener('pointerdown', (e) => { e.preventDefault(); showWord(); });
for (const evt of ['pointerup', 'pointercancel', 'pointerleave']) {
  revealCard.addEventListener(evt, hideWord);
}
revealCard.addEventListener('contextmenu', (e) => e.preventDefault());
revealCard.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); showWord(); }
});
revealCard.addEventListener('keyup', hideWord);
revealCard.addEventListener('blur', hideWord);

$('btn-open-voting').onclick = action($('btn-open-voting'), async () => {
  const { state: s } = await api('POST', `/api/rooms/${state.code}/open-voting`, { playerId: state.you.id });
  render(s);
});

/* ---------------------------------------------------------------- voting */

function renderVoting(isAdmin) {
  $('btn-close-voting').hidden = !isAdmin;
  $('vote-progress').textContent =
    `${state.votesCast} of ${state.players.length} voted` +
    (state.you.votedFor ? '' : ' — pick someone');

  const sig = JSON.stringify([state.players.map((p) => [p.id, p.name]), state.you.votedFor]);
  if (sig === lastVoteSig) return;
  lastVoteSig = sig;

  const grid = $('vote-options');
  grid.innerHTML = '';
  for (const p of state.players) {
    if (p.id === state.you.id) continue;
    const btn = document.createElement('button');
    btn.className = 'vote-btn' + (state.you.votedFor === p.id ? ' picked' : '');
    btn.textContent = p.name;
    btn.onclick = action(null, async () => {
      const { state: s } = await api('POST', `/api/rooms/${state.code}/vote`, {
        playerId: state.you.id,
        targetId: p.id
      });
      render(s);
    });
    grid.appendChild(btn);
  }
}

$('btn-close-voting').onclick = action($('btn-close-voting'), async () => {
  const { state: s } = await api('POST', `/api/rooms/${state.code}/close-voting`, { playerId: state.you.id });
  render(s);
});

/* --------------------------------------------------------------- results */

function renderResults(isAdmin) {
  const r = state.result;
  if (!r) return;

  const nameOf = (id) => {
    const hit = r.tally.find((t) => t.playerId === id);
    return hit ? hit.name : 'Someone';
  };
  const imposterNames = r.imposterIds.map(nameOf);

  let emoji, title, cls, sub;
  if (r.tie) {
    emoji = '🤷';
    title = 'No one was voted out';
    cls = '';
    sub = 'The vote was tied — the imposter walks free.';
  } else if (r.caught) {
    emoji = '🎉';
    title = 'Imposter caught!';
    cls = 'good';
    sub = `${nameOf(r.eliminatedId)} was voted out.`;
  } else {
    emoji = '😈';
    title = 'Wrong person!';
    cls = 'bad';
    sub = `${nameOf(r.eliminatedId)} was innocent. The imposter got away.`;
  }

  $('verdict').innerHTML = '';
  $('verdict').append(
    div('verdict-emoji', emoji),
    div(`verdict-title ${cls}`.trim(), title),
    div('verdict-sub', sub)
  );

  $('result-word').textContent = r.word || '—';

  const impEl = $('result-imposters');
  impEl.innerHTML = '';
  impEl.append(
    document.createTextNode(imposterNames.length > 1 ? 'The imposters were ' : 'The imposter was '),
    Object.assign(document.createElement('b'), { textContent: imposterNames.join(' & ') })
  );

  const max = Math.max(1, ...r.tally.map((t) => t.votes));
  const list = $('result-tally');
  list.innerHTML = '';
  for (const t of r.tally) {
    const li = document.createElement('li');
    li.append(div('bar-name', t.name));

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill' + (r.imposterIds.includes(t.playerId) ? ' was-imposter' : '');
    fill.style.width = `${(t.votes / max) * 100}%`;
    track.appendChild(fill);
    li.append(track, div('bar-num', String(t.votes)));

    list.appendChild(li);
  }

  $('admin-results').hidden = !isAdmin;
  $('results-wait').hidden = isAdmin;
}

function div(className, text) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

$('btn-again').onclick = action($('btn-again'), async () => {
  const { state: s } = await api('POST', `/api/rooms/${state.code}/start`, { playerId: state.you.id });
  render(s);
});

$('btn-lobby').onclick = action($('btn-lobby'), async () => {
  const { state: s } = await api('POST', `/api/rooms/${state.code}/lobby`, { playerId: state.you.id });
  render(s);
});

/* ------------------------------------------------------------ room chrome */

$('btn-code').onclick = async () => {
  const link = `${location.origin}/?room=${state.code}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Imposter', text: `Join room ${state.code}`, url: link });
      return;
    }
    await navigator.clipboard.writeText(link);
    toast('Invite link copied.');
  } catch {
    toast(`Room code: ${state.code}`);
  }
};

// Two taps rather than a native confirm() — no blocking dialog on phones.
let leaveArmed = null;
$('btn-leave').onclick = action($('btn-leave'), async () => {
  const btn = $('btn-leave');
  if (!leaveArmed) {
    btn.textContent = 'Tap to confirm';
    leaveArmed = setTimeout(() => {
      leaveArmed = null;
      btn.textContent = 'Leave';
    }, 3000);
    return;
  }
  clearTimeout(leaveArmed);
  leaveArmed = null;
  btn.textContent = 'Leave';
  try {
    await api('POST', `/api/rooms/${state.code}/leave`, { playerId: state.you.id });
  } catch { /* already gone */ }
  goHome();
});

/* ------------------------------------------------------------------ boot */

(async function boot() {
  $('input-name').value = LS.name;

  const fromUrl = new URLSearchParams(location.search).get('room');
  if (fromUrl) {
    $('input-code').value = fromUrl.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    history.replaceState(null, '', location.pathname);
  }

  if (LS.code && LS.id) {
    try {
      const { state: s } = await api('GET', `/api/rooms/${LS.code}?playerId=${encodeURIComponent(LS.id)}`);
      $('screen-home').hidden = true;
      $('screen-room').hidden = false;
      render(s);
      startPolling();
      return;
    } catch {
      LS.code = '';
    }
  }
  $('screen-home').hidden = false;
})();
