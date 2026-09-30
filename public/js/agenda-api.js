const API = {
  base: '/api',

  token() { return localStorage.getItem('token'); },

  async request(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    const t = this.token();
    if (t) opts.headers['Authorization'] = 'Bearer ' + t;
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(this.base + path, opts);
    if (res.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('username');
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');
    return data;
  },

  get(p)       { return this.request('GET', p); },
  post(p, b)   { return this.request('POST', p, b); },
  put(p, b)    { return this.request('PUT', p, b); },
  delete(p)    { return this.request('DELETE', p); },

  getMatieres()       { return this.get('/matieres'); },
  createMatiere(d)    { return this.post('/matieres', d); },
  updateMatiere(id,d) { return this.put('/matieres/' + id, d); },
  deleteMatiere(id)   { return this.delete('/matieres/' + id); },

  getCreneaux()       { return this.get('/creneaux'); },
  createCreneau(d)    { return this.post('/creneaux', d); },
  updateCreneau(id,d) { return this.put('/creneaux/' + id, d); },
  deleteCreneau(id)   { return this.delete('/creneaux/' + id); },

  getDevoirs()        { return this.get('/devoirs'); },
  createDevoir(d)     { return this.post('/devoirs', d); },
  updateDevoir(id,d)  { return this.put('/devoirs/' + id, d); },
  deleteDevoir(id)    { return this.delete('/devoirs/' + id); },

  getStats()          { return this.get('/stats-agenda'); },
  getTestsUpcoming()  { return this.get('/tests-upcoming'); },
};
