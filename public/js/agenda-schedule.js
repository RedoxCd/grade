const DAYS = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi'];
const DAY_START = 7, DAY_END = 20, HOUR_H = 60;
const TOTAL_H = (DAY_END - DAY_START) * HOUR_H;

let scheduleCreneaux = [], scheduleMatieres = [], scheduleTests = [], scheduleWeekOffset = 0;

function getWeekDates(offset) {
  const now = new Date();
  const day = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  return Array.from({ length: 5 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
}
function isToday(d) {
  const n = new Date();
  return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
}
function timeToMin(t) { const [h,m] = t.split(':').map(Number); return h*60+m; }
function getTop(t)    { return (timeToMin(t) - DAY_START*60) / 60 * HOUR_H; }
function getHeight(s,e){ return (timeToMin(e) - timeToMin(s)) / 60 * HOUR_H; }

async function renderSchedule() {
  document.getElementById('main-content').innerHTML = `
    <div class="page-header">
      <h2>Emploi du temps</h2>
      <div class="schedule-controls">
        <button class="btn btn-ghost btn-sm" onclick="shiftWeek(-1)">← Préc.</button>
        <span class="week-label" id="week-label"></span>
        <button class="btn btn-ghost btn-sm" onclick="shiftWeek(1)">Suiv. →</button>
        <button class="btn btn-primary btn-sm" onclick="openCreneauModal()">+ Créneau</button>
      </div>
    </div>
    <div class="page-content">
      <div id="schedule-container"></div>
      <div class="tests-section" style="margin-top:22px">
        <h3 style="font-size:.85rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:10px">
          Tests à venir
        </h3>
        <div id="tests-upcoming-list"><p style="color:var(--text-muted);font-size:.82rem">Chargement…</p></div>
      </div>
    </div>`;
  [scheduleCreneaux, scheduleMatieres, scheduleTests] = await Promise.all([
    API.getCreneaux(), API.getMatieres(), API.getTestsUpcoming().catch(() => [])
  ]);
  drawSchedule();
  renderTestsUpcoming();
}

async function renderTestsUpcoming() {
  const el = document.getElementById('tests-upcoming-list');
  if (!el) return;
  let tests;
  try { tests = await API.getTestsUpcoming(); }
  catch { el.innerHTML = '<p style="color:var(--text-muted);font-size:.82rem">Impossible de charger les tests.</p>'; return; }

  if (!tests.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:.82rem;text-align:center;padding:12px 0">Aucun test planifié — ajoute-en un depuis l\'app Notes.</p>';
    return;
  }

  const now = new Date(); now.setHours(0,0,0,0);
  el.innerHTML = `<div class="test-cards-grid">${tests.map(t => {
    const date = new Date(t.date_test + 'T00:00:00');
    const diff  = (date - now) / 86400000;
    let badgeCls, badgeTxt;
    if      (diff < 0)  { badgeCls = 'tbadge-past';   badgeTxt = 'Passé'; }
    else if (diff === 0){ badgeCls = 'tbadge-red';    badgeTxt = 'Aujourd\'hui'; }
    else if (diff < 3)  { badgeCls = 'tbadge-red';    badgeTxt = `Dans ${Math.ceil(diff)}j`; }
    else if (diff < 7)  { badgeCls = 'tbadge-orange'; badgeTxt = `Dans ${Math.ceil(diff)}j`; }
    else                { badgeCls = 'tbadge-green';  badgeTxt = `Dans ${Math.ceil(diff)}j`; }

    const fmtDate = date.toLocaleDateString('fr-FR', { weekday:'short', day:'2-digit', month:'short' });
    const noteHtml = t.note ? `<span class="test-card-note">${t.note}/6</span>` : '';
    return `<div class="test-card ${diff < 0 ? 'test-card-past' : ''}">
      <div class="test-card-left">
        <div class="test-card-subject">${escHtml(t.subject_name || '—')}</div>
        <div class="test-card-date">${fmtDate}</div>
      </div>
      <div class="test-card-right">
        ${noteHtml}
        <span class="test-badge ${badgeCls}">${badgeTxt}</span>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function shiftWeek(d) { scheduleWeekOffset += d; drawSchedule(); }

function drawSchedule() {
  const dates = getWeekDates(scheduleWeekOffset);
  const fmt = d => d.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
  document.getElementById('week-label').textContent = `${fmt(dates[0])} – ${fmt(dates[4])}`;

  let hourLines = '';
  for (let h = DAY_START; h <= DAY_END; h++) {
    const top = (h - DAY_START) * HOUR_H;
    hourLines += `<div class="hour-line" style="top:${top}px"></div>`;
    if (h < DAY_END) hourLines += `<div class="half-line" style="top:${top+30}px"></div>`;
  }
  let timeLabels = '';
  for (let h = DAY_START; h <= DAY_END; h++)
    timeLabels += `<div class="time-label" style="top:${(h-DAY_START)*HOUR_H}px">${String(h).padStart(2,'0')}:00</div>`;

  let dayHeaders = `<div class="schedule-day-header time-col"></div>`;
  let dayBodies  = `<div class="time-col-body" style="position:relative;height:${TOTAL_H}px">${timeLabels}</div>`;

  DAYS.forEach((name, i) => {
    const date = dates[i];
    const todayCls = isToday(date) ? 'today' : '';
    const dayStr = date.toISOString().slice(0, 10);
    const dayTests = scheduleTests.filter(t => t.date_test === dayStr);

    // Tests without time → pill in header; tests with time → block on grid
    const pills = dayTests.filter(t => !t.time_test).map(t =>
      `<div class="test-day-pill" title="${escHtml(t.subject_name)}: ×${t.weight}%">📝 ${escHtml(t.name)}</div>`
    ).join('');
    dayHeaders += `<div class="schedule-day-header ${todayCls}"><div class="day-name">${name.slice(0,3)}</div><div class="day-date">${date.getDate()}</div>${pills}</div>`;

    const creneauBlocks = scheduleCreneaux.filter(c => c.jour === i).map(c => {
      const top = getTop(c.heure_debut);
      const h   = Math.max(getHeight(c.heure_debut, c.heure_fin), 24);
      return `<div class="creneau-block" style="top:${top}px;height:${h}px;background:${c.matiere_couleur||'#a78bfa'}"
                   onclick='openCreneauModal(${JSON.stringify(c).replace(/"/g,"&quot;")})'>
                <div>${c.matiere_nom||'Sans matière'}</div>
                <div class="cb-time">${c.heure_debut}–${c.heure_fin}</div>
                ${c.salle ? `<div style="opacity:.75;font-size:.62rem">${c.salle}</div>` : ''}
              </div>`;
    }).join('');

    const testBlocks = dayTests.filter(t => t.time_test).map(t => {
      const [h, m] = t.time_test.split(':').map(Number);
      const endH = Math.min(h + 1, DAY_END);
      const timeEnd = `${String(endH).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      const top  = getTop(t.time_test);
      const ht   = Math.max(getHeight(t.time_test, timeEnd), 40);
      return `<div class="creneau-block test-grid-block" style="top:${top}px;height:${ht}px;background:#7f1d1d;border-left:3px solid #fb7185"
                   title="${escHtml(t.subject_name)}: ${escHtml(t.name)}">
                <div style="font-size:.68rem;font-weight:700;color:#fca5a5">📝 TEST</div>
                <div style="font-size:.67rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.name)}</div>
                <div class="cb-time">${t.time_test}</div>
              </div>`;
    }).join('');

    dayBodies += `<div class="day-col" style="height:${TOTAL_H}px;position:relative">${hourLines}${creneauBlocks}${testBlocks}</div>`;
  });

  const hint = scheduleCreneaux.length === 0
    ? `<p class="schedule-add-hint">Aucun créneau — cliquez sur <strong>+ Créneau</strong> pour commencer</p>` : '';

  document.getElementById('schedule-container').innerHTML = `
    <div class="schedule-wrapper">
      <div class="schedule-grid">${dayHeaders}${dayBodies}</div>
    </div>${hint}`;
}

function openCreneauModal(existing) {
  if (scheduleMatieres.length === 0) {
    toast('Ajoutez d\'abord une matière', 'error');
    navigate('matieres');
    return;
  }
  const isEdit = !!existing;
  const matOpts = scheduleMatieres.map(m =>
    `<option value="${m.id}" ${existing && existing.matiere_id == m.id ? 'selected' : ''}>${m.nom}</option>`).join('');
  const dayOpts = DAYS.map((d,i) =>
    `<option value="${i}" ${existing && existing.jour == i ? 'selected' : ''}>${d}</option>`).join('');

  const body = `
    <div class="form-group"><label>Matière</label><select class="form-control" id="f-matiere">${matOpts}</select></div>
    <div class="form-group"><label>Jour</label><select class="form-control" id="f-jour">${dayOpts}</select></div>
    <div class="form-row">
      <div class="form-group"><label>Début</label><input type="time" class="form-control" id="f-debut" value="${existing ? existing.heure_debut : '08:00'}"></div>
      <div class="form-group"><label>Fin</label><input type="time" class="form-control" id="f-fin" value="${existing ? existing.heure_fin : '10:00'}"></div>
    </div>
    <div class="form-group"><label>Salle (optionnel)</label><input type="text" class="form-control" id="f-salle" value="${existing ? (existing.salle||'') : ''}" placeholder="Ex: B204"></div>`;

  const buttons = [];
  if (isEdit) buttons.push({ label:'Supprimer', cls:'btn-danger', onclick: () => {
    confirmAction('Supprimer ce créneau ?', async () => {
      await API.deleteCreneau(existing.id); toast('Créneau supprimé','success'); closeModal();
      scheduleCreneaux = await API.getCreneaux(); drawSchedule();
    });
  }});
  buttons.push({ label:'Annuler', cls:'btn-ghost', onclick: closeModal });
  buttons.push({ label: isEdit ? 'Enregistrer' : 'Ajouter', cls:'btn-primary', onclick: () => saveCreneauModal(isEdit ? existing.id : null) });
  openModal(isEdit ? 'Modifier le créneau' : 'Nouveau créneau', body, buttons);
}

async function saveCreneauModal(id) {
  const debut = document.getElementById('f-debut').value;
  const fin   = document.getElementById('f-fin').value;
  if (debut >= fin) { toast('L\'heure de début doit être avant la fin','error'); return; }
  const data = {
    matiere_id: parseInt(document.getElementById('f-matiere').value),
    jour: parseInt(document.getElementById('f-jour').value),
    heure_debut: debut, heure_fin: fin,
    salle: document.getElementById('f-salle').value.trim() || null
  };
  try {
    if (id) { await API.updateCreneau(id, data); toast('Créneau modifié','success'); }
    else     { await API.createCreneau(data);    toast('Créneau ajouté','success'); }
    closeModal();
    scheduleCreneaux = await API.getCreneaux();
    drawSchedule();
  } catch(e) { toast(e.message,'error'); }
}
