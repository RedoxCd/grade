// ── Auth check (uses grade's token) ───────────────
if (!localStorage.getItem('token')) window.location.href = '/';

document.getElementById('sidebar-user').textContent =
  localStorage.getItem('fullName') || localStorage.getItem('username') || '—';

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  window.location.href = '/';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setLoading(on) {
  let el = document.getElementById('loading-bar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading-bar';
    el.style.cssText = 'position:fixed;top:0;left:0;height:3px;background:var(--primary,#6366f1);transition:width .3s;z-index:9999;width:0';
    document.body.appendChild(el);
  }
  el.style.width = on ? '70%' : '100%';
  if (!on) setTimeout(() => { el.style.width = '0'; }, 300);
}

function confirmAction(msg, onConfirm) {
  openModal('Confirmation', `<p style="color:var(--text-muted)">${escHtml(msg)}</p>`, [
    { label: 'Annuler',    cls: 'btn-ghost',  onclick: closeModal },
    { label: 'Supprimer', cls: 'btn-danger', onclick: () => { closeModal(); onConfirm(); } },
  ]);
}

// ── Router ────────────────────────────────────────
function navigate(view) {
  // Lazy lookup so this file can load before the view files
  const VIEWS = {
    schedule: renderSchedule,
    devoirs:  renderDevoirs,
    matieres: renderMatieres,
    stats:    renderStats,
  };
  if (!VIEWS[view]) view = 'schedule';
  window.location.hash = view;
  document.querySelectorAll('[data-view]').forEach(el =>
    el.classList.toggle('active', el.dataset.view === view)
  );
  setLoading(true);
  Promise.resolve(VIEWS[view]()).finally(() => setLoading(false));
}

window.addEventListener('hashchange', () =>
  navigate(window.location.hash.replace('#', '') || 'schedule')
);

// ── Modal ─────────────────────────────────────────
function openModal(title, bodyHtml, buttons) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  const footer = document.getElementById('modal-footer');
  footer.innerHTML = '';
  (buttons || []).forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (b.cls || 'btn-ghost');
    btn.textContent = b.label;
    btn.onclick = b.onclick;
    footer.appendChild(btn);
  });
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}
function closeModalOnOverlay(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

// ── Toast ─────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ── Shared utils ──────────────────────────────────
const COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#14b8a6','#3b82f6','#a78bfa','#a855f7','#ec4899','#64748b'
];

function colorSwatches(selected) {
  return `<div class="color-swatches">
    ${COLORS.map(c => `<div class="color-swatch ${c === selected ? 'selected' : ''}" style="background:${c}" data-color="${c}" onclick="selectColor(this)"></div>`).join('')}
    <input type="hidden" id="f-couleur" value="${selected || COLORS[6]}">
  </div>`;
}
function selectColor(el) {
  el.closest('.color-swatches').querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('f-couleur').value = el.dataset.color;
}

function formatDate(s) {
  if (!s) return '';
  return new Date(s + 'T00:00:00').toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
}
function deadlineClass(s) {
  if (!s) return '';
  const now = new Date(); now.setHours(0,0,0,0);
  const diff = (new Date(s + 'T00:00:00') - now) / 86400000;
  return diff < 0 ? 'overdue' : diff <= 3 ? 'soon' : '';
}
function priorityBadge(p) {
  const m = { haute:['badge-prio-haute','🔴'], moyenne:['badge-prio-moyenne','🟡'], basse:['badge-prio-basse','⚪'] };
  const [cls, icon] = m[p] || m.moyenne;
  return `<span class="badge ${cls}">${icon} ${p}</span>`;
}
function matiereBadge(nom, couleur) {
  if (!nom) return '';
  return `<span class="badge badge-matiere" style="background:${couleur}22;color:${couleur}">${nom}</span>`;
}

// Triggered at end of agenda-stats.js once all view functions are defined
// (avoids calling navigate() before later scripts load)
