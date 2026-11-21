const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});
const q = (sql, p) => pool.query(sql, p).then(r => r.rows);
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

const app = express();
app.set('view engine', 'ejs');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));
app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 864e5 },
}));
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.msg = req.session.msg; delete req.session.msg;
  next();
});

// Rôles : admin > moderator > creator > reader
const need = (...roles) => (req, res, next) => {
  const u = req.session.user;
  if (!u) return res.redirect('/login');
  if (!roles.includes(u.role)) return res.status(403).render('error', { text: 'Accès refusé.' });
  next();
};
const flash = (req, m) => { req.session.msg = m; };

// ---------- Public ----------
app.get('/', async (req, res) => {
  const { cat, s } = req.query;
  const guides = await q(`SELECT g.*, c.name AS cat, u.name AS author FROM guides g
    LEFT JOIN categories c ON c.id=g.category_id JOIN users u ON u.id=g.author_id
    WHERE ($1::int IS NULL OR g.category_id=$1) AND ($2::text IS NULL OR g.title ILIKE '%'||$2||'%')
    ORDER BY g.created_at DESC`, [cat || null, s || null]);
  const cats = await q('SELECT * FROM categories ORDER BY name');
  res.render('home', { guides, cats, cat, s });
});

app.get('/guide/:id', async (req, res) => {
  const [g] = await q(`SELECT g.*, c.name AS cat, u.name AS author FROM guides g
    LEFT JOIN categories c ON c.id=g.category_id JOIN users u ON u.id=g.author_id WHERE g.id=$1`, [req.params.id]);
  if (!g) return res.status(404).render('error', { text: 'Guide introuvable.' });
  const comments = await q(`SELECT m.*, u.name FROM comments m JOIN users u ON u.id=m.user_id
    WHERE guide_id=$1 ORDER BY m.created_at`, [g.id]);
  res.render('guide', { g, comments });
});

// ---------- Compte ----------
app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const name = (req.body.name || '').trim().slice(0, 40);
  const pw = req.body.password || '';
  if (!/^\S+@\S+\.\S+$/.test(email) || !name || pw.length < 8) {
    flash(req, 'Email valide, pseudo et mot de passe (8 caractères min.) requis.');
    return res.redirect('/register');
  }
  if ((await q('SELECT 1 FROM users WHERE email=$1', [email])).length) {
    flash(req, 'Cet email a déjà un compte.'); return res.redirect('/register');
  }
  const role = email === (process.env.ADMIN_EMAIL || '').toLowerCase() ? 'admin' : 'reader';
  const [u] = await q('INSERT INTO users(email,name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,name,role',
    [email, name, await bcrypt.hash(pw, 10), role]);
  if (mailer) mailer.sendMail({ from: process.env.SMTP_FROM, to: email, subject: 'Bienvenue sur RepairHub',
    text: `Bonjour ${name}, votre compte est créé. Vous pouvez dès maintenant commenter les guides.` }).catch(console.error);
  req.session.user = u; flash(req, 'Compte créé, bienvenue !'); res.redirect('/');
});
app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
  const [u] = await q('SELECT * FROM users WHERE email=$1', [(req.body.email || '').trim().toLowerCase()]);
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) {
    flash(req, 'Identifiants incorrects.'); return res.redirect('/login');
  }
  if (u.banned) { flash(req, 'Ce compte est suspendu.'); return res.redirect('/login'); }
  req.session.user = { id: u.id, name: u.name, role: u.role };
  res.redirect('/');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// ---------- Commentaires ----------
app.post('/guide/:id/comment', need('reader', 'creator', 'moderator', 'admin'), async (req, res) => {
  const [u] = await q('SELECT banned FROM users WHERE id=$1', [req.session.user.id]);
  const body = (req.body.body || '').trim().slice(0, 2000);
  if (u && !u.banned && body) await q('INSERT INTO comments(guide_id,user_id,body) VALUES($1,$2,$3)', [req.params.id, req.session.user.id, body]);
  res.redirect('/guide/' + req.params.id);
});
app.post('/comment/:id/delete', need('moderator', 'admin'), async (req, res) => {
  const [c] = await q('DELETE FROM comments WHERE id=$1 RETURNING guide_id', [req.params.id]);
  res.redirect(c ? '/guide/' + c.guide_id : '/');
});

// ---------- Guides (créateurs) ----------
app.get('/new', need('creator', 'admin'), async (req, res) =>
  res.render('form', { g: {}, cats: await q('SELECT * FROM categories ORDER BY name') }));
app.post('/new', need('creator', 'admin'), async (req, res) => {
  const b = req.body;
  const [g] = await q('INSERT INTO guides(title,intro,steps,category_id,author_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [b.title, b.intro, b.steps, b.category_id || null, req.session.user.id]);
  res.redirect('/guide/' + g.id);
});
const canEdit = async (req, res, next) => {
  const [g] = await q('SELECT * FROM guides WHERE id=$1', [req.params.id]);
  const u = req.session.user;
  if (!g) return res.status(404).render('error', { text: 'Guide introuvable.' });
  if (!u || !(u.role === 'admin' || (u.role === 'creator' && g.author_id === u.id)))
    return res.status(403).render('error', { text: 'Accès refusé.' });
  req.guide = g; next();
};
app.get('/edit/:id', canEdit, async (req, res) =>
  res.render('form', { g: req.guide, cats: await q('SELECT * FROM categories ORDER BY name') }));
app.post('/edit/:id', canEdit, async (req, res) => {
  const b = req.body;
  await q('UPDATE guides SET title=$1,intro=$2,steps=$3,category_id=$4 WHERE id=$5',
    [b.title, b.intro, b.steps, b.category_id || null, req.params.id]);
  res.redirect('/guide/' + req.params.id);
});
// suppression : auteur, modérateur ou admin
app.post('/delete/:id', need('creator', 'moderator', 'admin'), async (req, res) => {
  const u = req.session.user;
  await q('DELETE FROM guides WHERE id=$1 AND ($2 IN (\'admin\',\'moderator\') OR author_id=$3)', [req.params.id, u.role, u.id]);
  res.redirect('/');
});

// ---------- Administration ----------
app.get('/admin', need('admin', 'moderator'), async (req, res) => {
  res.render('admin', {
    users: await q('SELECT id,email,name,role,banned,created_at FROM users ORDER BY created_at DESC'),
    cats: await q('SELECT * FROM categories ORDER BY name'),
    comments: await q(`SELECT m.id,m.body,m.guide_id,u.name FROM comments m JOIN users u ON u.id=m.user_id
      ORDER BY m.created_at DESC LIMIT 30`),
  });
});
app.post('/admin/category', need('admin'), async (req, res) => {
  const n = (req.body.name || '').trim();
  if (n) await q('INSERT INTO categories(name) VALUES($1) ON CONFLICT DO NOTHING', [n]);
  res.redirect('/admin');
});
app.post('/admin/category/:id/delete', need('admin'), async (req, res) => {
  await q('DELETE FROM categories WHERE id=$1', [req.params.id]); res.redirect('/admin');
});
app.post('/admin/user/:id', need('admin'), async (req, res) => {
  if (+req.params.id !== req.session.user.id) {
    if (['reader', 'creator', 'moderator', 'admin'].includes(req.body.role))
      await q('UPDATE users SET role=$1 WHERE id=$2', [req.body.role, req.params.id]);
    await q('UPDATE users SET banned=$1 WHERE id=$2', [req.body.banned === 'on', req.params.id]);
  }
  res.redirect('/admin');
});
// Les modérateurs peuvent suspendre un lecteur
app.post('/admin/user/:id/ban', need('moderator', 'admin'), async (req, res) => {
  await q(`UPDATE users SET banned=NOT banned WHERE id=$1 AND role='reader'`, [req.params.id]);
  res.redirect('/admin');
});

app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { text: 'Erreur serveur.' }); });

(async () => {
  await q(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'reader', banned BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS categories(id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS guides(id SERIAL PRIMARY KEY, title TEXT NOT NULL, intro TEXT, steps TEXT,
      category_id INT REFERENCES categories(id) ON DELETE SET NULL, author_id INT REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS comments(id SERIAL PRIMARY KEY, guide_id INT REFERENCES guides(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());`);
  app.listen(process.env.PORT || 3000, () => console.log('RepairHub prêt'));
})();
