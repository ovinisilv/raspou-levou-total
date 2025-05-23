const express = require('express');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bodyParser = require('body-parser');

const app = express();

// Configurações iniciais
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());
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








const axios = require('axios');

// Rota para criar pagamento via PrimePag
app.post('/v1/pix/checkout', async (req, res) => {
  const { amount, payer } = req.body;

  // Ajuste o payload conforme a documentação
  const payload = {
    value_cents: amount, // já em centavos
    generator_name: payer?.name,
    generator_document: payer?.document,
    expiration_time: "1800", // 30 minutos
    external_link: "raspaganha.net"
  };

  try {
    const response = await axios.post(
      'https://api-stg.primepag.com.br/v1/pix/checkout', // ambiente de homologação
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer 9ba1a483-9f65-4c2f-9917-76e6702f14da'
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    console.error('Erro PrimePag:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao criar pagamento', details: err.response?.data || err.message });
  }
});

// ...existing code...

// Login
app.post('/login', (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha são obrigatórios." });
  }

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

// Iniciar servidor
app.listen(3000, () => {
  console.log('Servidor rodando em http://localhost:3000');
});

// Função de redirecionamento (exemplo)
function jogarGalinha() {
  window.location.href = "/raspadinha/achou-ganhou";
}