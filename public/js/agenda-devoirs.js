let allDevoirs = [], devoirsMatieres = [], devoirFilterMatiere = '', devoirFilterPrio = '', draggedId = null;

async function renderDevoirs() {
  document.getElementById('main-content').innerHTML = `
    <div class="page-header">
      <h2>Devoirs</h2>
      <button class="btn btn-primary btn-sm" onclick="openDevoirModal()">+ Devoir</button>
    </div>
    <div class="page-content">
      <div class="kanban-filters" style="margin-bottom:10px">
        <select class="form-control" style="width:auto;padding:5px 10px;font-size:.8rem" id="filter-matiere" onchange="applyDevoirFilters()">
          <option value="">Toutes les matières</option>
        </select>
        <select class="form-control" style="width:auto;padding:5px 10px;font-size:.8rem" id="filter-prio" onchange="applyDevoirFilters()">
          <option value="">Toutes les priorités</option>
          <option value="haute">Haute</option>
          <option value="moyenne">Moyenne</option>
          <option value="basse">Basse</option>
        </select>
      </div>
      <div class="kanban-board" id="kanban-board"></div>
    </div>`;
  [allDevoirs, devoirsMatieres] = await Promise.all([API.getDevoirs(), API.getMatieres()]);
  populateMatiereFilter();
  drawKanban();
}

function populateMatiereFilter() {
  const sel = document.getElementById('filter-matiere');
  if (!sel) return;
  sel.innerHTML = '<option value="">Toutes les matières</option>' +
    devoirsMatieres.map(m => `<option value="${m.id}">${m.nom}</option>`).join('');
  sel.value = devoirFilterMatiere;
}

function applyDevoirFilters() {
  devoirFilterMatiere = document.getElementById('filter-matiere')?.value || '';
  devoirFilterPrio    = document.getElementById('filter-prio')?.value    || '';
  drawKanban();
}

function filteredDevoirs() {
  return allDevoirs.filter(d => {
    if (devoirFilterMatiere && String(d.matiere_id) !== devoirFilterMatiere) return false;
    if (devoirFilterPrio    && d.priorite !== devoirFilterPrio) return false;
    return true;
  });
}

function drawKanban() {
  const board = document.getElementById('kanban-board');
  if (!board) return;
  const COLS = [
    { key:'todo',       label:'À faire',  cls:'col-todo' },
    { key:'inprogress', label:'En cours', cls:'col-inprogress' },
    { key:'done',       label:'Rendu',    cls:'col-done' },
  ];
  const devoirs = filteredDevoirs();
  board.innerHTML = COLS.map(col => {
    const cards = devoirs.filter(d => d.statut === col.key);
    return `
      <div class="kanban-col ${col.cls}" id="col-${col.key}"
           ondragover="onDragOver(event)" ondrop="onDrop(event,'${col.key}')">
        <div class="kanban-col-header">
          <h3>${col.label}</h3><span class="col-count">${cards.length}</span>
        </div>
        <div class="kanban-cards" id="cards-${col.key}">
          ${cards.map(renderDevoirCard).join('')}
          ${cards.length === 0 ? `<div style="text-align:center;color:var(--text-muted);font-size:.75rem;padding:14px 0">Vide</div>` : ''}
        </div>
      </div>`;
  }).join('');
}


function renderDevoirCard(d) {
  const dlClass = deadlineClass(d.deadline);
  const dlLabel = d.deadline ? formatDate(d.deadline) : '';
  return `
    <div class="devoir-card" draggable="true"
         ondragstart="onDragStart(event,${d.id})" ondragend="onDragEnd(event)"
         style="border-left-color:${d.matiere_couleur||'var(--border)'}">
      <div class="devoir-card-title">${escHtml(d.titre)}</div>
      <div class="devoir-card-meta">
        ${matiereBadge(d.matiere_nom, d.matiere_couleur)}
        ${priorityBadge(d.priorite)}
        ${dlLabel ? `<span class="badge badge-deadline ${dlClass}">📅 ${dlLabel}</span>` : ''}
      </div>
      ${d.description ? `<div class="text-sm text-muted" style="margin-top:5px;font-size:.75rem">${escHtml(d.description)}</div>` : ''}
      <div class="devoir-card-actions">
        <button class="btn btn-ghost btn-sm btn-icon" onclick="openDevoirModal(${d.id})">✏️</button>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="deleteDevoir(${d.id})">🗑️</button>
      </div>
    </div>`;
}

// ── Drag & drop ───────────────────────────────────
function onDragStart(e, id) { draggedId = id; e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); }
function onDragEnd(e)       { e.currentTarget.classList.remove('dragging'); }
function onDragOver(e)      { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.querySelector('.kanban-cards')?.classList.add('drag-over'); }
document.addEventListener('dragleave', e => { if (e.target.classList?.contains('kanban-cards')) e.target.classList.remove('drag-over'); });

async function onDrop(e, newStatut) {
  e.preventDefault();
  document.querySelectorAll('.kanban-cards').forEach(el => el.classList.remove('drag-over'));
  if (!draggedId) return;
  const d = allDevoirs.find(x => x.id === draggedId);
  if (!d || d.statut === newStatut) return;
  try {
    const updated = await API.updateDevoir(draggedId, { statut: newStatut });
    allDevoirs[allDevoirs.findIndex(x => x.id === draggedId)] = updated;
    drawKanban();
  } catch(e) { toast(e.message,'error'); }
  draggedId = null;
}

// ── CRUD ──────────────────────────────────────────
function openDevoirModal(id) {
  const d = id ? allDevoirs.find(x => x.id === id) : null;
  const matOpts = `<option value="">— Sans matière —</option>` +
    devoirsMatieres.map(m => `<option value="${m.id}" ${d && d.matiere_id == m.id ? 'selected' : ''}>${m.nom}</option>`).join('');
  const body = `
    <div class="form-group"><label>Titre *</label><input type="text" class="form-control" id="f-titre" value="${d ? escHtml(d.titre) : ''}" placeholder="Ex: Résumé chapitre 3"></div>
    <div class="form-row">
      <div class="form-group"><label>Matière</label><select class="form-control" id="f-matiere">${matOpts}</select></div>
      <div class="form-group"><label>Deadline</label><input type="date" class="form-control" id="f-deadline" value="${d ? (d.deadline||'') : ''}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Priorité</label>
        <select class="form-control" id="f-priorite">
          <option value="basse"   ${d && d.priorite==='basse'   ? 'selected':''}>Basse</option>
          <option value="moyenne" ${!d||d.priorite==='moyenne'  ? 'selected':''}>Moyenne</option>
          <option value="haute"   ${d && d.priorite==='haute'   ? 'selected':''}>Haute</option>
        </select>
      </div>
      <div class="form-group"><label>Statut</label>
        <select class="form-control" id="f-statut">
          <option value="todo"       ${!d||d.statut==='todo'       ? 'selected':''}>À faire</option>
          <option value="inprogress" ${d && d.statut==='inprogress'? 'selected':''}>En cours</option>
          <option value="done"       ${d && d.statut==='done'      ? 'selected':''}>Rendu</option>
        </select>
      </div>
    </div>
    <div class="form-group"><label>Notes</label><textarea class="form-control" id="f-description" placeholder="Détails...">${d ? escHtml(d.description||'') : ''}</textarea></div>`;

  const buttons = [];
  if (d) buttons.push({ label:'Supprimer', cls:'btn-danger', onclick: () => deleteDevoir(d.id, true) });
  buttons.push({ label:'Annuler', cls:'btn-ghost', onclick: closeModal });
  buttons.push({ label: d ? 'Enregistrer' : 'Ajouter', cls:'btn-primary', onclick: () => saveDevoirModal(d ? d.id : null) });
  openModal(d ? 'Modifier le devoir' : 'Nouveau devoir', body, buttons);
}

async function saveDevoirModal(id) {
  const titre = document.getElementById('f-titre').value.trim();
  if (!titre) { toast('Le titre est requis','error'); return; }
  const data = {
    titre,
    matiere_id:  document.getElementById('f-matiere').value   || null,
    deadline:    document.getElementById('f-deadline').value   || null,
    priorite:    document.getElementById('f-priorite').value,
    statut:      document.getElementById('f-statut').value,
    description: document.getElementById('f-description').value.trim() || null,
  };
  try {
    if (id) {
      allDevoirs[allDevoirs.findIndex(d => d.id === id)] = await API.updateDevoir(id, data);
      toast('Devoir modifié','success');
    } else {
      allDevoirs.unshift(await API.createDevoir(data));
      toast('Devoir ajouté','success');
    }
    closeModal(); drawKanban();
  } catch(e) { toast(e.message,'error'); }
}

async function deleteDevoir(id, fromModal = false) {
  confirmAction('Supprimer ce devoir ?', async () => {
    try {
      await API.deleteDevoir(id);
      allDevoirs = allDevoirs.filter(d => d.id !== id);
      toast('Devoir supprimé','success');
      if (fromModal) closeModal();
      drawKanban();
    } catch(e) { toast(e.message,'error'); }
  });
}
