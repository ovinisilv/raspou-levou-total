require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const qrcode = require('qrcode');
const FormData = require('form-data');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Banco de dados
const db = new sqlite3.Database('./db/raspoulevou.db');
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

// Configurações PrimePag
const PRIMEPAG_URL = process.env.PRIMEPAG_URL || 'https://api.primepag.com.br/';
const PRIMEPAG_CLIENT_ID = process.env.PRIMEPAG_CLIENT_ID;
const PRIMEPAG_CLIENT_SECRET = process.env.PRIMEPAG_CLIENT_SECRET;

// Token fixo para testes
async function getPrimePagToken() {
  return "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoyMjksImV4cCI6MTc0OTE0NjcyNn0.gUYR88l1sJExSYxdThMiVQHqNme1uzPuw-XAqYEjeaI";
}

// Token Payzy
async function getPayzyToken() {
  try {
    const response = await axios.get('https://payzy.site/api/get_token.php');
    return response.data.token || response.data.access_token || response.data;
  } catch (err) {
    console.error('[ERRO] Falha ao obter token do Payzy:', err.response?.data || err.message);
    throw err;
  }
}

// Endpoint para testar token Payzy
app.get('/payzy/token', async (req, res) => {
  try {
    const token = await getPayzyToken();
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter token do Payzy', details: err.response?.data || err.message });
  }
});

// Geração de QR Code via PrimePag
app.post('/v1/pix/qrcodes', async (req, res) => {
  const { amount, payer } = req.body;
  const valor = (Number(amount) / 100).toFixed(2);

  try {
    const token = await getPrimePagToken();

    const params = new URLSearchParams();
    params.append('nome', payer?.name);
    params.append('cpf', payer?.document);
    params.append('valor', valor);
    params.append('descricao', 'Depósito via PIX');
    params.append('urlnoty', 'https://onify.com.br/PAGAMENTO/webhook.php');

    const response = await axios.post(
      `${PRIMEPAG_URL}v1/pix/qrcodes`,
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${token}`
        }
      }
    );

    const pagamentosDir = path.join(__dirname, 'pagamentos');
    if (!fs.existsSync(pagamentosDir)) fs.mkdirSync(pagamentosDir);

    const fileData = {
      transactionId: response.data?.transactionId || 'indefinido',
      status: 'PENDING',
      amount: valor,
      external_id: response.data?.external_id || 'indefinido'
    };
    fs.writeFileSync(path.join(pagamentosDir, `pagamento_${Date.now()}.json`), JSON.stringify(fileData, null, 2));

    res.json(response.data);
  } catch (err) {
    console.error('[ERRO] PrimePag:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao criar pagamento', details: err.response?.data || err.message });
  }
});

// Saque via Payzy
app.post('/v1/pix/cashout', async (req, res) => {
  const { amount, recipient } = req.body;
  const valor = (Number(amount) / 100).toFixed(2);

  try {
    const form = new FormData();
    form.append('nome', recipient?.name || 'Cliente');
    form.append('cpf', recipient?.document || '00000000000');
    form.append('valor', valor);
    form.append('chave', recipient?.pix_key || '');

    const response = await axios.post(
      "https://payzy.site/libs/includes/gerar_saque.php",
      form,
      { headers: form.getHeaders() }
    );

    if (response.data?.erro) {
      return res.status(500).json({ error: 'Erro ao solicitar saque', details: response.data });
    }

    res.json({
      status: 'pending',
      message: 'Solicitação de saque enviada com sucesso',
      data: response.data
    });
  } catch (err) {
    console.error('[ERRO CASHOUT]:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao solicitar saque', details: err.response?.data || err.message });
  }
});

// Login
app.post('/login', (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: "Email e senha são obrigatórios." });

  db.get("SELECT * FROM usuarios WHERE email = ?", [email], async (err, user) => {
    if (err) return res.status(500).json({ error: "Erro no servidor." });
    if (!user) return res.status(401).json({ error: "Credenciais inválidas." });

    const valid = await bcrypt.compare(senha, user.senha);
    if (!valid) return res.status(401).json({ error: "Credenciais inválidas." });

    res.json({ message: "Login realizado com sucesso!", nome: user.nome, usuarioId: user.id });
  });
});

// Página inicial
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicia o servidor
app.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000');
});
