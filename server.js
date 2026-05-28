const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── Firebase Admin SDK ───────────────────────────────────────────────────────
let fbCredential;
if (process.env.FIREBASE_SERVICE_ACCOUNT && process.env.FIREBASE_SERVICE_ACCOUNT !== '{}') {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  fbCredential = admin.credential.cert(sa);
} else {
  fbCredential = admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  });
}
admin.initializeApp({ credential: fbCredential });
const db = admin.firestore();
const auth = admin.auth();

const HOTMART_TOKEN = process.env.HOTMART_TOKEN || '';
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN   || 'mude-esta-senha-admin';

async function ativarAssinante(email, nome, transacao) {
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    const senha = Math.random().toString(36).slice(-8) + 'Aa1!';
    user = await auth.createUser({ email, displayName: nome, emailVerified: true, password: senha });
  }
  const resetLink = await auth.generatePasswordResetLink(email);
  console.log(`🔗 Link de acesso para ${email}: ${resetLink}`);
  await db.collection('assinantes').doc(user.uid).set({
    email, nome, ativo: true, transacao,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    inicioAssinatura: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return { user, resetLink };
}

async function desativarAssinante(email) {
  try {
    const user = await auth.getUserByEmail(email);
    await db.collection('assinantes').doc(user.uid).set(
      { ativo: false, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log(`❌ Desativado: ${email}`);
  } catch {
    console.warn(`⚠️ Usuário não encontrado para desativar: ${email}`);
  }
}

app.post('/webhook/hotmart', async (req, res) => {
  const token = req.headers['x-hotmart-webhook-token'];
  if (HOTMART_TOKEN && token !== HOTMART_TOKEN)
    return res.status(401).json({ error: 'Token inválido' });
  const body = req.body;
  const event = body.event;
  const data  = body.data || {};
  console.log(`📩 Webhook: ${event}`);
  const email = data?.buyer?.email || data?.subscriber?.email;
  const nome  = data?.buyer?.name  || data?.subscriber?.name || 'Assinante';
  const trans = data?.purchase?.transaction || data?.subscription?.subscriber_code || '';
  if (!email) return res.status(400).json({ error: 'Email não encontrado' });
  const ATIVAR    = ['PURCHASE_COMPLETE','PURCHASE_APPROVED','SUBSCRIPTION_REACTIVATED'];
  const DESATIVAR = ['PURCHASE_REFUNDED','PURCHASE_CHARGEBACK','SUBSCRIPTION_CANCELLATION','PURCHASE_CANCELED'];
  try {
    if (ATIVAR.includes(event)) {
      const { resetLink } = await ativarAssinante(email, nome, trans);
      return res.json({ ok: true, acao: 'ativado', email, resetLink });
    }
    if (DESATIVAR.includes(event)) {
      await desativarAssinante(email);
      return res.json({ ok: true, acao: 'desativado', email });
    }
    return res.json({ ok: true, acao: 'ignorado', event });
  } catch (err) {
    console.error('Erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/admin/ativar', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(401).json({ error: 'Não autorizado' });
  const { email, nome } = req.body;
  try {
    const { user, resetLink } = await ativarAssinante(email, nome || 'Admin', 'manual');
    res.json({ ok: true, uid: user.uid, resetLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/desativar', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(401).json({ error: 'Não autorizado' });
  const { email } = req.body;
  try {
    await desativarAssinante(email);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor na porta ${PORT}`));
