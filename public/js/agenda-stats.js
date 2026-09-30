let chartDonut = null, chartBar = null;

async function renderStats() {
  document.getElementById('main-content').innerHTML = `
    <div class="page-header"><h2>Statistiques</h2></div>
    <div class="page-content">
      <div class="stats-summary" id="stats-summary">
        ${['…','…','…','…'].map((v,i) => `<div class="stat-card"><div class="stat-num">${v}</div><div class="stat-label">—</div></div>`).join('')}
      </div>
      <div class="charts-grid">
        <div class="chart-card"><h3>Par matière</h3><canvas id="chart-donut" height="220"></canvas></div>
        <div class="chart-card"><h3>Charge par semaine</h3><canvas id="chart-bar" height="220"></canvas></div>
      </div>
    </div>`;

  if (chartDonut) { chartDonut.destroy(); chartDonut = null; }
  if (chartBar)   { chartBar.destroy();   chartBar   = null; }

  try {
    const data = await API.getStats();
    drawStatsSummary(data.global);
    drawDonut(data.devoirsParMatiere);
    drawBar(data.chargeParSemaine);
  } catch(e) { toast('Erreur chargement stats','error'); }
}

function drawStatsSummary(g) {
  const el = document.getElementById('stats-summary');
  if (!el || !g) return;
  el.innerHTML = `
    <div class="stat-card"><div class="stat-num">${g.total}</div><div class="stat-label">Total devoirs</div></div>
    <div class="stat-card"><div class="stat-num">${g.todo}</div><div class="stat-label">À faire</div></div>
    <div class="stat-card success"><div class="stat-num">${g.done}</div><div class="stat-label">Rendus</div></div>
    <div class="stat-card ${g.en_retard > 0 ? 'danger' : ''}"><div class="stat-num">${g.en_retard}</div><div class="stat-label">En retard</div></div>`;
}

function drawDonut(data) {
  const canvas = document.getElementById('chart-donut');
  if (!canvas) return;
  if (!data || !data.length) { canvas.parentElement.innerHTML = `<div class="empty-state" style="padding:32px 0"><div class="empty-icon">📊</div><p>Aucun devoir</p></div>`; return; }
  Chart.defaults.color = '#94a3b8';
  chartDonut = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.nom),
      datasets: [{ data: data.map(d => d.total), backgroundColor: data.map(d => d.couleur), borderColor: '#111128', borderWidth: 3, hoverOffset: 8 }]
    },
    options: {
      responsive: true, cutout: '65%',
      plugins: {
        legend: { position:'bottom', labels: { padding:10, font:{size:10}, boxWidth:10, boxHeight:10 } },
        tooltip: { callbacks: { label: ctx => { const d = data[ctx.dataIndex]; return ` ${d.total} devoir${d.total>1?'s':''} (${d.done} rendu${d.done>1?'s':''})`; } } }
      }
    }
  });
}

function drawBar(data) {
  const canvas = document.getElementById('chart-bar');
  if (!canvas) return;
  if (!data || !data.length) { canvas.parentElement.innerHTML = `<div class="empty-state" style="padding:32px 0"><div class="empty-icon">📅</div><p>Aucune deadline</p></div>`; return; }
  const labels = data.map(d => {
    if (!d.debut_semaine) return d.semaine;
    return new Date(d.debut_semaine + 'T00:00:00').toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' });
  });
  chartBar = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label:'Total',  data: data.map(d => d.total), backgroundColor:'rgba(167,139,250,0.7)', borderRadius:6, borderSkipped:false },
        { label:'Rendus', data: data.map(d => d.done),  backgroundColor:'rgba(52,211,153,0.6)',  borderRadius:6, borderSkipped:false },
      ]
    },
    options: {
      responsive: true,
      interaction: { mode:'index', intersect:false },
      plugins: { legend: { position:'top', labels: { font:{size:10}, boxWidth:10, boxHeight:10, padding:8 } } },
      scales: {
        x: { grid:{color:'rgba(255,255,255,0.06)'}, ticks:{font:{size:9}} },
        y: { beginAtZero:true, ticks:{stepSize:1, font:{size:9}}, grid:{color:'rgba(255,255,255,0.06)'} }
      }
    }
  });
}

// All view functions are now defined — boot the router
navigate(window.location.hash.replace('#','') || 'schedule');
