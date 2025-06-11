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
    params.append('token', token);

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

    const pixContent = response.data?.qrcode?.content;

    if (!pixContent) {
      console.error('[ERRO] Conteúdo PIX (qrcode.content) não encontrado na resposta do Payzy.');
      return res.status(500).json({ error: 'Erro ao gerar QR Code: Conteúdo PIX não recebido.' });
    }

    const qrCodeImageBase64 = await qrcode.toDataURL(pixContent, { type: 'image/png' });
    const base64Data = qrCodeImageBase64.replace(/^data:image\/png;base64,/, '');

    const pagamentosDir = path.join(__dirname, 'pagamentos');
    if (!fs.existsSync(pagamentosDir)) fs.mkdirSync(pagamentosDir);

    const fileData = {
      transactionId: response.data?.transactionId || 'indefinido',
      status: 'PENDING',
      amount: valor,
      external_id: response.data?.external_id || 'indefinido',
      pix_content: pixContent
    };
    fs.writeFileSync(path.join(pagamentosDir, `pagamento_${Date.now()}.json`), JSON.stringify(fileData, null, 2));

    res.json({
        pix: {
            qr_code_image: base64Data,
            qr_code: pixContent
        },
        status: 'pending',
        message: 'Depósito iniciado com sucesso'
    });

  } catch (err) {
    console.error('[ERRO] Erro ao criar pagamento:');
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao criar pagamento', details: err.response?.data || err.message });
  }
});

// Nova rota para cashout (saque via PIX) usando FormData no padrão solicitado
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

    console.log("RESPOSTA:", response.data);

    if (response.data?.erro) {
      return res.status(500).json({ error: 'Erro ao solicitar saque', details: response.data });
    }

    res.json({
      status: 'pending',
      message: 'Solicitação de saque enviada com sucesso',
      data: response.data
    });

  } catch (err) {
    if (err.response) {
      console.error("ERRO:", err.response.data);
      res.status(500).json({ error: 'Erro ao solicitar saque', details: err.response.data });
    } else {
      console.error("ERRO GERAL:", err.message);
      res.status(500).json({ error: 'Erro ao solicitar saque', details: err.message });
    }
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
