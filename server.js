require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));


async function getPayzyToken() {
  try {
    const response = await axios.get('https://payzy.site/api/get_token.php');
    console.log('[DEBUG] Token recebido:', response.data);
    return response.data.access_token;
  } catch (err) {
    console.error('[ERRO] Falha ao obter token:', err.response?.data || err.message);
    throw err;
  }
}

app.post('/v1/pix/qrcodes', async (req, res) => {
  const { amount, payer } = req.body;
  const valor = (Number(amount) / 100).toFixed(2);

  try {
    const token = await getPayzyToken();

    const params = new URLSearchParams();
    params.append('nome', payer?.name || 'Cliente');
    params.append('cpf', payer?.document || '00000000000');
    params.append('valor', valor);
    params.append('descricao', 'Depósito via PIX');
    params.append('urlnoty', 'https://payzyra.com/api/webhook.php');
    params.append('token', token);  // Envia o token no POST

    console.log('[DEBUG] Enviando POST para generate_qrcode.php com:');
    console.log(params.toString());
    

    const response = await axios.post(
      'https://payzy.site/api/generate_qrcode.php',
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    console.log('[DEBUG] Resposta do Payzy:', response.data);

    const pagamentosDir = path.join(__dirname, 'pagamentos');
    if (!fs.existsSync(pagamentosDir)) fs.mkdirSync(pagamentosDir);

    const fileData = {
      transactionId: response.data?.transactionId || 'indefinido',
      status: 'PENDING',
      amount: valor,
      external_id: response.data?.external_id || 'indefinido'
    };
    fs.writeFileSync(path.join(pagamentosDir, 'pagamento.txt'), JSON.stringify(fileData, null, 2));

    res.json(response.data);
  } catch (err) {
    console.error('[ERRO] Erro ao criar pagamento:');
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao criar pagamento', details: err.response?.data || err.message });
  }
});


// ----------------- BANCO DE DADOS -----------------
const db = new sqlite3.Database('./db/raspoulevou.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      saldo REAL DEFAULT 0,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS saques (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      valor REAL NOT NULL,
      status TEXT DEFAULT 'PENDING',
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
  `);
});

// ----------------- MIDDLEWARES -----------------
const allowedAdminEmails = [
  'viniguerras@hotmail.com',
  'mblojavirtual01@gmail.com',
  'pedrohenriqueh7_26@hotmail.com',
  'Pedrohenriqueh7_26@hotmail.com'
];

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token JWT obrigatório' });
  }

  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
}

function adminOnly(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Acesso negado: apenas admins' });
  }
  next();
}

// ----------------- ROTAS DE AUTENTICAÇÃO -----------------
app.post('/cadastro', async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) {
    return res.status(400).json({ error: 'Nome, email e senha são obrigatórios.' });
  }

  db.get('SELECT id FROM usuarios WHERE email = ?', [email], async (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro no servidor.' });
    if (row) return res.status(400).json({ error: 'Email já cadastrado.' });

    const hash = await bcrypt.hash(senha, 10);
    db.run('INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)', [nome, email, hash], function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao cadastrar usuário.' });
      res.json({ message: 'Cadastro realizado com sucesso!' });
    });
  });
});

app.post('/login', (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: "Email e senha são obrigatórios." });

  db.get("SELECT * FROM usuarios WHERE email = ?", [email], async (err, user) => {
    if (err) return res.status(500).json({ error: "Erro no servidor." });
    if (!user) return res.status(401).json({ error: "Credenciais inválidas." });

    const valid = await bcrypt.compare(senha, user.senha);
    if (!valid) return res.status(401).json({ error: "Credenciais inválidas." });

    const isAdmin = allowedAdminEmails.includes(user.email);
    const token = jwt.sign(
      {
        id: user.id,
        nome: user.nome,
        email: user.email,
        is_admin: isAdmin
      },
      JWT_SECRET,
      { expiresIn: '4h' }
    );

    res.json({
      message: "Login realizado com sucesso!",
      token,
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        is_admin: isAdmin
      }
    });
  });
});

// ----------------- ROTAS FINANCEIRAS -----------------
app.get('/api/saldo', (req, res) => {
  const usuarioId = req.query.usuarioId;
  if (!usuarioId) return res.status(400).json({ error: 'Usuário não informado' });
  db.get('SELECT saldo FROM usuarios WHERE id = ?', [usuarioId], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar saldo' });
    if (!row) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ saldo: row.saldo });
  });
});

app.post('/v1/pix/cashout', authenticateJWT, (req, res) => {
  const { amount } = req.body;
  const valor = (Number(amount) / 100).toFixed(2);

  if (!valor || valor <= 0) return res.status(400).json({ error: 'Valor inválido' });

  db.run(
    `INSERT INTO saques (usuario_id, valor, status) VALUES (?, ?, 'PENDING')`,
    [req.user.id, valor],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao registrar saque' });
      res.json({
        status: 'pending',
        message: 'Solicitação de saque registrada e pendente de aprovação',
        saqueId: this.lastID
      });
    }
  );
});

app.get('/admin/saques', authenticateJWT, adminOnly, (req, res) => {
  db.all(
    `SELECT s.id, s.valor, s.status, s.criado_em, u.nome, u.email
     FROM saques s
     JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.status = 'PENDING'
     ORDER BY s.criado_em ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro ao listar saques' });
      res.json(rows);
    }
  );
});

app.post('/admin/saques/:id/aprovar', authenticateJWT, adminOnly, (req, res) => {
  const saqueId = req.params.id;
  db.run(
    `UPDATE saques SET status = 'APPROVED', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDING'`,
    [saqueId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao aprovar saque' });
      if (this.changes === 0) return res.status(400).json({ error: 'Saque não encontrado ou já processado' });
      res.json({ message: 'Saque aprovado com sucesso' });
    }
  );
});

app.post('/admin/saques/:id/negar', authenticateJWT, adminOnly, (req, res) => {
  const saqueId = req.params.id;
  db.run(
    `UPDATE saques SET status = 'DENIED', atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PENDING'`,
    [saqueId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao negar saque' });
      if (this.changes === 0) return res.status(400).json({ error: 'Saque não encontrado ou já processado' });
      res.json({ message: 'Saque negado com sucesso' });
    }
  );
});

// ----------------- PÁGINA INICIAL -----------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------- INICIAR SERVIDOR -----------------
app.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000');
});
