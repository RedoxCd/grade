let allMatieres = [];

async function renderMatieres() {
  document.getElementById('main-content').innerHTML = `
    <div class="page-header">
      <h2>Matières</h2>
      <button class="btn btn-primary btn-sm" onclick="openMatiereModal()">+ Matière</button>
    </div>
    <div class="page-content"><div id="matieres-list"></div></div>`;
  allMatieres = await API.getMatieres();
  drawMatieres();
}

function drawMatieres() {
  const el = document.getElementById('matieres-list');
  if (!el) return;
  if (allMatieres.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🎨</div><p>Aucune matière — commencez par en créer une !</p></div>`;
    return;
  }
  el.innerHTML = `<div class="matiere-list">
    ${allMatieres.map(m => `
      <div class="matiere-item">
        <div class="matiere-dot" style="background:${m.couleur}"></div>
        <div class="matiere-info">
          <div class="matiere-name">${escHtml(m.nom)}</div>
          <div class="matiere-dates">${matieresPeriode(m)}</div>
        </div>
        <div class="matiere-actions">
          <button class="btn btn-ghost btn-sm btn-icon" onclick="openMatiereModal(${m.id})">✏️</button>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="deleteMatiere(${m.id})">🗑️</button>
        </div>
      </div>`).join('')}
  </div>`;
}

function matieresPeriode(m) {
  if (!m.date_debut && !m.date_fin) return 'Toute l\'année';
  if (m.date_debut && m.date_fin)   return `${formatDate(m.date_debut)} → ${formatDate(m.date_fin)}`;
  if (m.date_debut)                 return `Depuis le ${formatDate(m.date_debut)}`;
  return `Jusqu'au ${formatDate(m.date_fin)}`;
}

function openMatiereModal(id) {
  const m = id ? allMatieres.find(x => x.id === id) : null;
  const body = `
    <div class="form-group"><label>Nom *</label><input type="text" class="form-control" id="f-nom" value="${m ? escHtml(m.nom) : ''}" placeholder="Ex: Anglais CG, Module SQL..."></div>
    <div class="form-group"><label>Couleur</label>${colorSwatches(m ? m.couleur : COLORS[6])}</div>
    <div class="form-row">
      <div class="form-group"><label>Date début</label><input type="date" class="form-control" id="f-debut" value="${m ? (m.date_debut||'') : ''}"></div>
      <div class="form-group"><label>Date fin</label><input type="date" class="form-control" id="f-fin" value="${m ? (m.date_fin||'') : ''}"></div>
    </div>
    <p class="text-sm text-muted" style="margin-top:-6px">Ou entrer une durée :</p>
    <div class="form-group" style="margin-top:8px">
      <label>Durée en semaines</label>
      <input type="number" class="form-control" id="f-semaines" min="1" max="52" placeholder="Ex: 8" oninput="calcFinFromWeeks()">
    </div>`;

  const buttons = [];
  if (m) buttons.push({ label:'Supprimer', cls:'btn-danger', onclick: () => deleteMatiere(m.id, true) });
  buttons.push({ label:'Annuler', cls:'btn-ghost', onclick: closeModal });
  buttons.push({ label: m ? 'Enregistrer' : 'Ajouter', cls:'btn-primary', onclick: () => saveMatiereModal(m ? m.id : null) });
  openModal(m ? 'Modifier la matière' : 'Nouvelle matière', body, buttons);
}

function calcFinFromWeeks() {
  const weeks = parseInt(document.getElementById('f-semaines').value);
  if (!weeks || weeks < 1) return;
  const debutVal = document.getElementById('f-debut').value;
  const base = debutVal ? new Date(debutVal + 'T00:00:00') : new Date();
  const fin = new Date(base);
  fin.setDate(base.getDate() + weeks * 7);
  document.getElementById('f-fin').value = fin.toISOString().slice(0,10);
}

async function saveMatiereModal(id) {
  const nom = document.getElementById('f-nom').value.trim();
  if (!nom) { toast('Le nom est requis','error'); return; }
  const data = {
    nom,
    couleur:    document.getElementById('f-couleur').value,
    date_debut: document.getElementById('f-debut').value || null,
    date_fin:   document.getElementById('f-fin').value   || null,
  };
  try {
    if (id) {
      allMatieres[allMatieres.findIndex(m => m.id === id)] = await API.updateMatiere(id, data);
      toast('Matière modifiée','success');
    } else {
      allMatieres.push(await API.createMatiere(data));
      allMatieres.sort((a,b) => a.nom.localeCompare(b.nom));
      toast('Matière ajoutée','success');
    }
    closeModal(); drawMatieres();
  } catch(e) { toast(e.message,'error'); }
}

async function deleteMatiere(id, fromModal = false) {
  confirmAction('Supprimer cette matière ? Les créneaux associés seront aussi supprimés.', async () => {
    try {
      await API.deleteMatiere(id);
      allMatieres = allMatieres.filter(m => m.id !== id);
      toast('Matière supprimée','success');
      if (fromModal) closeModal();
      drawMatieres();
    } catch(e) { toast(e.message,'error'); }
  });
}
