const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const auth = admin.auth();

const HOTMART_TOKEN = process.env.HOTMART_TOKEN || '';
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN   || 'admin123';

async function ativarAssinante(email, nome, transacao) {
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    const senha = Math.random().toString(36).slice(-8) + 'Aa1!';
    user = await auth.createUser({ email, displayName: nome, emailVerified: true, password: senha });
  }
  const resetLink = await auth.generatePasswordResetLink(email);
  console.log('Link de acesso para ' + email + ': ' + resetLink);
  await db.collection('assinantes').doc(user.uid).set({
    email, nome, ativo: true, transacao,
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
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
  } catch { console.warn('Usuario nao encontrado: ' + email); }
}

app.post('/webhook/hotmart', async (req, res) => {
  const token = req.headers['x-hotmart-webhook-token'];
  if (HOTMART_TOKEN && token !== HOTMART_TOKEN) return res.status(401).json({ error: 'Token invalido' });
  const { event, data = {} } = req.body;
  console.log('Webhook: ' + event);
  const email = data?.buyer?.email || data?.subscriber?.email;
  const nome  = data?.buyer?.name  || data?.subscriber?.name || 'Assinante';
  const trans = data?.purchase?.transaction || '';
  if (!email) return res.status(400).json({ error: 'Email nao encontrado' });
  const ATIVAR    = ['PURCHASE_COMPLETE','PURCHASE_APPROVED','SUBSCRIPTION_REACTIVATED'];
  const DESATIVAR = ['PURCHASE_REFUNDED','PURCHASE_CHARGEBACK','SUBSCRIPTION_CANCELLATION'];
  try {
    if (ATIVAR.includes(event))    { await ativarAssinante(email, nome, trans); return res.json({ ok: true, acao: 'ativado' }); }
    if (DESATIVAR.includes(event)) { await desativarAssinante(email);           return res.json({ ok: true, acao: 'desativado' }); }
    return res.json({ ok: true, acao: 'ignorado' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post('/admin/ativar', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(401).json({ error: 'Nao autorizado' });
  const { email, nome } = req.body;
  try { const r = await ativarAssinante(email, nome || 'Admin', 'manual'); res.json({ ok: true, resetLink: r.resetLink }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
