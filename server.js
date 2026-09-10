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

// Links diretos das seções do app -> âncoras da página principal
app.get(['/planejador', '/planner'], (req, res) => res.redirect(301, '/#planejador'));
app.get(['/lista', '/lista-de-compras', '/compras'], (req, res) => res.redirect(301, '/#lista'));
app.get('/entrar', (req, res) => res.redirect(302, '/#login'));
app.get(['/materiais', '/bonus', '/materiais-e-bonus'], (req, res) => res.redirect(301, '/#materiais'));

// ── API DE RECEITAS (dados fora de /public, protegidos) ─────────────────────
const zlib = require('zlib');
const RECIPES_B64 = require('./recipes-data.js');
let VOLUMES_CACHE = null, DEMO_CACHE = null;
// Limpa nomes: remove "Receita N — ", "Tempo total: ...", tags " · " e texto colado após ")"
function cleanRecipeName(n) {
  let s = String(n || '').replace(/^Receita\s*\d+\s*[—–-]\s*/i, '');
  s = s.replace(/\s*Tempo total:[\s\S]*$/i, '');
  s = s.split(' · ')[0];
  s = s.replace(/\)(?=[A-ZÀ-Ú])[\s\S]*$/, ')');
  return s.replace(/\s+/g, ' ').trim();
}
// Normaliza: nomes limpos, remove receitas idênticas, diferencia homônimas
function normalizeVolumes(vols) {
  const seen = new Set(), byName = new Map();
  return vols.map(vol => {
    const recipes = [];
    for (const r of (vol.recipes || [])) {
      const name = cleanRecipeName(r.name);
      const key = name + '|' + JSON.stringify(r.ingredients || []) + '|' + JSON.stringify(r.steps || []);
      if (seen.has(key)) continue;           // idêntica: descarta
      seen.add(key);
      const n = (byName.get(name) || 0) + 1;
      byName.set(name, n);
      recipes.push({ ...r, name: n === 1 ? name : name + ' (versão ' + n + ')' });
    }
    return { ...vol, recipes, count: recipes.length };
  });
}
// Fragmentos de PDFs (guias/bônus picados) que estavam na grade como "receitas". Agora vivem em Materiais & Bônus.
const FRAGMENT_CATS = new Set(['doce_guide', 'ansiedade_guide', 'reset', 'bonus1', 'bonus4', 'bonus5', 'bonus7', 'bonus8']);
function isRealRecipe(r) {
  return !FRAGMENT_CATS.has(r.category) && Array.isArray(r.ingredients) && r.ingredients.length > 0;
}
function getVolumes() {
  if (!VOLUMES_CACHE) {
    const raw = JSON.parse(zlib.inflateSync(Buffer.from(RECIPES_B64, 'base64')).toString('utf8'))
      .filter(v => v.vol !== 7)                                   // Vol. 7 "Ferramentas Práticas" = só fragmentos
      .map(v => ({ ...v, recipes: (v.recipes || []).filter(isRealRecipe) }));
    VOLUMES_CACHE = normalizeVolumes(raw);
    console.log('🍽️ Receitas carregadas:', VOLUMES_CACHE.reduce((s, v) => s + v.recipes.length, 0));
  }
  return VOLUMES_CACHE;
}
app.get('/api/receitas/stats', (req, res) => {
  const vols = getVolumes();
  res.json({ total: vols.reduce((s, v) => s + v.recipes.length, 0), materiais: getMaterials().length, volumes: vols.map(v => ({ vol: v.vol || v.id || v.label, label: v.label || v.name || v.title, count: v.recipes.length })) });
});
// Demo: ~20 receitas completas (1 a cada 26), o restante só nome (sem ingredientes/passos)
const DEMO_STEP = 26;
function getDemoVolumes() {
  if (DEMO_CACHE) return DEMO_CACHE;
  let idx = 0;
  DEMO_CACHE = getVolumes().map(vol => ({
    ...vol,
    recipes: vol.recipes.map(r => {
      const unlocked = (idx++ % DEMO_STEP) === 0;
      return unlocked ? r : { ...r, ingredients: [], steps: [], benefit: '', locked: true };
    })
  }));
  return DEMO_CACHE;
}
app.get('/api/receitas/demo', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(getDemoVolumes());
});
// Verifica token Firebase + assinatura ativa. Responde o erro e devolve false se não autorizado.
async function exigirAssinante(req, res) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.t || null);
  if (!token) { res.status(401).json({ error: 'Não autenticado' }); return false; }
  let decoded;
  try { decoded = await auth.verifyIdToken(token); }
  catch { res.status(401).json({ error: 'Token inválido' }); return false; }
  const doc = await db.collection('assinantes').doc(decoded.uid).get();
  if (!doc.exists || doc.data().ativo !== true) { res.status(403).json({ error: 'Assinatura inativa' }); return false; }
  return true;
}
app.get('/api/receitas', async (req, res) => {
  try {
    if (!(await exigirAssinante(req, res))) return;
    res.set('Cache-Control', 'private, no-store');
    res.json(getVolumes());
  } catch (e) {
    res.status(500).json({ error: 'Erro ao carregar receitas' });
  }
});

// ── MATERIAIS & BÔNUS (guias, protocolos e planners — dados fora de /public, protegidos) ──
const MATERIALS_B64 = require('./materials-data.js');
let MATERIALS_CACHE = null;
function getMaterials() {
  if (!MATERIALS_CACHE) {
    MATERIALS_CACHE = JSON.parse(zlib.inflateSync(Buffer.from(MATERIALS_B64, 'base64')).toString('utf8'));
    console.log('📚 Materiais carregados:', MATERIALS_CACHE.length);
  }
  return MATERIALS_CACHE;
}
// Lista sem conteúdo (capa): id, título, subtítulo, emoji, tipo, nº de capítulos
function materialsIndex() {
  return getMaterials().map(m => ({ id: m.id, title: m.title, subtitle: m.subtitle, emoji: m.emoji, kind: m.kind, source: m.source,
    chapters: m.chapters.map(c => c.title), images: m.images.length }));
}
app.get('/api/materiais/demo', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(materialsIndex().map(m => ({ ...m, locked: true })));
});
app.get('/api/materiais', async (req, res) => {
  try {
    if (!(await exigirAssinante(req, res))) return;
    res.set('Cache-Control', 'private, no-store');
    res.json(materialsIndex());
  } catch (e) { res.status(500).json({ error: 'Erro ao carregar materiais' }); }
});
app.get('/api/materiais/img/:name', async (req, res) => {
  try {
    if (!(await exigirAssinante(req, res))) return;
    const name = String(req.params.name || '');
    if (!/^[a-z0-9-]+\.jpg$/i.test(name)) return res.status(400).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(__dirname, 'materials', 'img', name), err => { if (err && !res.headersSent) res.status(404).end(); });
  } catch (e) { res.status(500).end(); }
});
app.get('/api/materiais/:id', async (req, res) => {
  try {
    if (!(await exigirAssinante(req, res))) return;
    const m = getMaterials().find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'Material não encontrado' });
    res.set('Cache-Control', 'private, no-store');
    res.json(m);
  } catch (e) { res.status(500).json({ error: 'Erro ao carregar material' }); }
});


// ── BLOG ─────────────────────────────────────────────────────────────────────

const BLOG_POSTS = [
  {
    slug: 'como-planejar-alimentacao-semanal',
    title: 'Como Planejar a Alimentação da Semana em 30 Minutos',
    description: 'Pare de chegar em casa sem saber o que jantar. Veja como organizar toda a sua alimentação semanal em menos de meia hora — e nunca mais desperdiçar comida.',
    date: '2025-06-01',
    dateFormatted: '1 de junho de 2025',
    category: 'Planejamento',
    readTime: '5 min de leitura',
    content: `
      <p>Você já chegou em casa depois de um dia longo, abriu a geladeira e ficou olhando para ela sem saber o que fazer? Isso acontece com a maioria das pessoas — e tem um nome: <strong>fadiga de decisão alimentar</strong>.</p>
      <p>A boa notícia é que existe uma solução simples: <strong>planejar a alimentação da semana inteira em um único momento</strong>. Funciona, é rápido, e você vai economizar tempo, dinheiro e energia mental todos os dias.</p>

      <h2>Por que o planejamento alimentar muda tudo</h2>
      <p>Estudos mostram que pessoas que planejam refeições consomem mais nutrientes, gastam menos no supermercado e têm menos episódios de alimentação impulsiva. Não é sobre perfeição — é sobre ter um <em>sistema</em>.</p>
      <p>Quando você já sabe o que vai comer na terça à noite, não precisa decidir exausto depois do trabalho. Essa decisão foi tomada no domingo, com cabeça fria.</p>

      <h2>O método de 30 minutos (passo a passo)</h2>

      <h3>1. Escolha um dia fixo (10 min)</h3>
      <p>Domingo de manhã é o favorito de quem pratica. Reserve 30 minutos sem interrupções. Abra o cardápio da semana — pode ser um caderno, um aplicativo ou um planejador digital.</p>

      <h3>2. Monte o cardápio por refeição (10 min)</h3>
      <p>Pense em blocos: café da manhã, almoço, jantar e lanches. Você não precisa de uma receita diferente para cada dia — repetir pratos é inteligente, não preguiçoso.</p>
      <ul>
        <li><strong>Café da manhã:</strong> 2 a 3 opções que você rotaciona durante a semana</li>
        <li><strong>Almoço:</strong> 1 proteína + 1 carboidrato + vegetais (muda só o tempero)</li>
        <li><strong>Jantar:</strong> algo leve — sopa, omelete, salada com proteína</li>
        <li><strong>Lanches:</strong> frutas, iogurte, ovos cozidos</li>
      </ul>

      <h3>3. Gere a lista de compras (5 min)</h3>
      <p>Com o cardápio definido, liste os ingredientes necessários. Organize por seção do mercado: hortifrúti, proteínas, laticínios, grãos. Você vai passar pelo mercado com eficiência e sem compras por impulso.</p>

      <h3>4. Faça as compras e um mini pré-preparo (5 min de planejamento)</h3>
      <p>Ao chegar em casa do mercado, separe 20 a 30 minutos para lavar verduras, cozinhar ovos, temperar proteínas. Esse pré-preparo reduz o tempo de cozinhar nos dias seguintes para menos de 10 minutos.</p>

      <h2>O erro mais comum (e como evitar)</h2>
      <p>A maioria das pessoas planeja refeições muito elaboradas para a semana toda — e desiste no terceiro dia. O segredo é <strong>planejar simples</strong>. Receitas com no máximo 5 a 7 ingredientes e 20 minutos de preparo são as mais sustentáveis.</p>

      <h2>Como o NuvLev facilita isso</h2>
      <p>O <a href="https://saudenaturall.online" style="color:#E76F51">NuvLev</a> tem um planejador semanal integrado onde você monta toda a semana em minutos e gera a lista de compras com um clique — automticamente, já organizada por ingredientes. São mais de 500 receitas com filtros por refeição, objetivo e tempo de preparo para você nunca ficar sem ideia.</p>

      <h2>Recapitulando</h2>
      <ul>
        <li>Escolha um dia fixo para planejar (domingo é o mais popular)</li>
        <li>Monte o cardápio por blocos de refeição</li>
        <li>Prefira receitas simples e repita sem culpa</li>
        <li>Gere a lista de compras a partir do cardápio</li>
        <li>Faça um mini pré-preparo ao chegar do mercado</li>
      </ul>
      <p>Com esse método, você vai para a semana sabendo exatamente o que vai comer — e isso muda o jogo.</p>
    `
  },
  {
    slug: 'receitas-cafe-da-manha-saudavel-rapidas',
    title: '7 Receitas de Café da Manhã Saudável para Fazer em 10 Minutos',
    description: 'Café da manhã nutritivo e gostoso não precisa de muito tempo. Veja 7 receitas rápidas, com ingredientes simples, que vão transformar sua manhã.',
    date: '2025-06-05',
    dateFormatted: '5 de junho de 2025',
    category: 'Receitas',
    readTime: '7 min de leitura',
    content: `
      <p>O café da manhã é a refeição que mais pessoas pulam — e o motivo quase sempre é o mesmo: falta de tempo. A solução não é acordar mais cedo, é ter receitas rápidas e nutritivas que cabem na sua rotina.</p>
      <p>Separamos 7 opções que ficam prontas em até 10 minutos, com ingredientes fáceis de encontrar em qualquer mercado.</p>

      <h2>1. Overnight Oats de Banana e Mel</h2>
      <p><strong>Tempo de preparo:</strong> 5 minutos (prepara na noite anterior)</p>
      <p><strong>Ingredientes:</strong> 4 colheres de aveia em flocos, 150 ml de leite ou bebida vegetal, 1 banana amassada, 1 colher de mel, canela a gosto.</p>
      <p><strong>Como fazer:</strong> misture tudo em um pote com tampa e deixe na geladeira. Na manhã seguinte é só pegar e comer. Pode adicionar frutas frescas por cima.</p>

      <h2>2. Omelete de Espinafre com Queijo</h2>
      <p><strong>Tempo de preparo:</strong> 8 minutos</p>
      <p><strong>Ingredientes:</strong> 2 ovos, 1 punhado de espinafre, 2 fatias de queijo branco, sal e pimenta.</p>
      <p><strong>Como fazer:</strong> bata os ovos com sal e pimenta. Refogue o espinafre rapidamente numa frigideira antiaderente com fio de azeite. Adicione os ovos e o queijo. Dobre ao meio quando firmar.</p>

      <h2>3. Tapioca com Ricota e Tomate</h2>
      <p><strong>Tempo de preparo:</strong> 7 minutos</p>
      <p><strong>Ingredientes:</strong> 2 colheres de goma de tapioca hidratada, 2 colheres de ricota, 4 fatias de tomate, sal e orégano.</p>
      <p><strong>Como fazer:</strong> aqueça a frigideira e espalhe a tapioca. Quando firmar (1 a 2 minutos), vire. Recheie com ricota e tomate temperado. Dobre e sirva.</p>

      <h2>4. Vitamina Verde Proteica</h2>
      <p><strong>Tempo de preparo:</strong> 3 minutos</p>
      <p><strong>Ingredientes:</strong> 1 banana congelada, 1 punhado de espinafre, 200 ml de leite, 1 colher de pasta de amendoim, 1 colher de sementes de chia.</p>
      <p><strong>Como fazer:</strong> bata tudo no liquidificador. Sirva imediatamente. A banana congelada dá cremosidade sem precisar de sorvete.</p>

      <h2>5. Pão Integral com Abacate e Ovo Mexido</h2>
      <p><strong>Tempo de preparo:</strong> 8 minutos</p>
      <p><strong>Ingredientes:</strong> 2 fatias de pão integral, 1/2 abacate maduro, 2 ovos, sal, limão e pimenta-do-reino.</p>
      <p><strong>Como fazer:</strong> toste o pão. Amasse o abacate com limão e sal. Prepare os ovos mexidos na frigideira. Monte: pão, pasta de abacate, ovos por cima.</p>

      <h2>6. Iogurte Grego com Granola e Frutas Vermelhas</h2>
      <p><strong>Tempo de preparo:</strong> 2 minutos</p>
      <p><strong>Ingredientes:</strong> 1 pote de iogurte grego natural, 3 colheres de granola, frutas vermelhas frescas ou congeladas, mel a gosto.</p>
      <p><strong>Como fazer:</strong> monte em camadas num bowl ou copo. Nenhum cozimento necessário — ideal para dias corridos.</p>

      <h2>7. Panqueca de Banana com Aveia (2 ingredientes)</h2>
      <p><strong>Tempo de preparo:</strong> 10 minutos</p>
      <p><strong>Ingredientes:</strong> 1 banana madura, 2 ovos. Opcional: canela, gotas de chocolate.</p>
      <p><strong>Como fazer:</strong> amasse a banana com um garfo. Misture os ovos até formar uma massa. Frite colheradas na frigideira antiaderente com fio de azeite. Vire quando as bordas firmarem.</p>

      <h2>Dica extra: o pré-preparo salva seu café da manhã</h2>
      <p>Prepare os overnight oats e a vitamina do dia seguinte na noite anterior. Cozinhe ovos cozidos para a semana inteira num domingo. Esses pequenos hábitos reduzem o tempo de café da manhã para menos de 5 minutos nos dias mais corridos.</p>
      <p>No <a href="https://saudenaturall.online" style="color:#E76F51">NuvLev</a> você encontra essas e mais 86 receitas só de café da manhã, com instruções completas, ingredientes e dicas de substituição.</p>
    `
  },
  {
    slug: 'lista-de-compras-saudavel',
    title: 'Como Montar uma Lista de Compras Saudável (e Economizar no Mercado)',
    description: 'Uma lista de compras bem feita é a base de uma alimentação saudável. Saiba como organizar suas compras por categoria, evitar desperdício e gastar menos.',
    date: '2025-06-09',
    dateFormatted: '9 de junho de 2025',
    category: 'Organização',
    readTime: '6 min de leitura',
    content: `
      <p>Ir ao mercado sem lista é o caminho mais rápido para duas coisas: gastar mais do que o planejado e chegar em casa sem os ingredientes que você realmente precisava. A lista de compras saudável resolve os dois problemas de uma vez.</p>

      <h2>Por que sua lista de compras importa tanto</h2>
      <p>Pesquisas mostram que pessoas que fazem compras com lista gastam em média 23% menos do que as que vão sem planejamento. Além disso, compram mais alimentos frescos e menos produtos ultraprocessados — simplesmente porque não estão tomando decisões com fome ou sem critério.</p>

      <h2>O método das 5 categorias</h2>
      <p>Organize sua lista em 5 seções que correspondem às seções do mercado. Você vai economizar tempo e evitar voltar em corredores que já passou.</p>

      <h3>1. Proteínas</h3>
      <ul>
        <li>Ovos (compre sempre em quantidade — duram a semana toda)</li>
        <li>Frango (filé ou sobrecoxa para mais sabor)</li>
        <li>Peixe (atum em lata é prático e barato)</li>
        <li>Leguminosas: feijão, lentilha, grão-de-bico</li>
        <li>Iogurte grego e queijo cottage</li>
      </ul>

      <h3>2. Carboidratos de qualidade</h3>
      <ul>
        <li>Arroz integral ou branco</li>
        <li>Batata-doce e mandioca</li>
        <li>Aveia em flocos</li>
        <li>Pão integral (verifique se tem fibras no rótulo)</li>
        <li>Macarrão integral</li>
      </ul>

      <h3>3. Hortifrúti</h3>
      <ul>
        <li>Folhas: espinafre, rúcula, alface</li>
        <li>Legumes: abobrinha, cenoura, brócolis, tomate</li>
        <li>Frutas da estação (mais baratas e mais nutritivas)</li>
        <li>Temperos frescos: alho, cebola, limão</li>
      </ul>

      <h3>4. Gorduras boas</h3>
      <ul>
        <li>Azeite de oliva extravirgem</li>
        <li>Pasta de amendoim natural (sem açúcar adicionado)</li>
        <li>Abacate (compre verde e deixe amadurecer em casa)</li>
        <li>Sementes: chia, linhaça, girassol</li>
      </ul>

      <h3>5. Praticidade saudável</h3>
      <ul>
        <li>Atum e sardinha em lata</li>
        <li>Leite ou bebida vegetal (aveia, amêndoa, coco)</li>
        <li>Iogurte natural sem açúcar</li>
        <li>Castanhas e nozes para lanches</li>
      </ul>

      <h2>Regras de ouro para economizar sem abrir mão da qualidade</h2>

      <h3>Compre a estação</h3>
      <p>Frutas e verduras fora de estação custam até 3 vezes mais. Pergunte ao feirante o que está na safra — e adapte suas receitas.</p>

      <h3>Proteínas congeladas são aliadas</h3>
      <p>Comprar frango, peixe e carne em quantidade e congelar em porções individuais reduz o custo por refeição significativamente.</p>

      <h3>Evite ir ao mercado com fome</h3>
      <p>É um clichê porque é verdade. Com fome, tudo parece necessário — especialmente os produtos ultraprocessados nas gondolas no nível dos olhos.</p>

      <h3>Leia os rótulos de 3 em 3</h3>
      <p>Para produtos como pão, granola e iogurte, sempre compare 3 marcas. Os ingredientes no início da lista são os mais presentes — prefira os que têm nomes que você reconhece.</p>

      <h2>Como automatizar sua lista de compras</h2>
      <p>O método mais eficiente é gerar a lista diretamente do cardápio da semana. Se você sabe o que vai comer, sabe exatamente o que precisa comprar — sem sobras e sem falta.</p>
      <p>O <a href="https://saudenaturall.online" style="color:#E76F51">NuvLev</a> faz isso automaticamente: você monta o planejador semanal com as receitas que quer fazer, clica em "Gerar Lista de Compras" e recebe todos os ingredientes organizados. Sem esforço, sem esquecimento.</p>

      <h2>Resumo da lista base semanal</h2>
      <p>Para uma pessoa (adapte as quantidades para sua família): 12 ovos, 1 kg de frango, 500 g de atum em lata, 1 kg de arroz integral, 500 g de batata-doce, 1 maço de espinafre, 1 maço de brócolis, 4 tomates, 6 frutas variadas, 1 litro de iogurte natural, azeite, alho e cebola.</p>
      <p>Com essa base você consegue montar mais de 15 refeições diferentes durante a semana — variando o tempero, o modo de preparo e as combinações.</p>
    `
  }
];

function renderBlogIndex(posts) {
  const cards = posts.map(p => `
    <article class="post-card">
      <div class="post-meta"><span class="post-cat">${p.category}</span> · ${p.readTime}</div>
      <h2 class="post-title"><a href="/blog/${p.slug}">${p.title}</a></h2>
      <p class="post-excerpt">${p.description}</p>
      <div class="post-footer">
        <span class="post-date">${p.dateFormatted}</span>
        <a href="/blog/${p.slug}" class="post-read-more">Ler artigo →</a>
      </div>
    </article>
  `).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Blog NuvLev — Nutrição, Receitas e Planejamento Alimentar</title>
  <meta name="description" content="Dicas práticas de nutrição, receitas saudáveis e planejamento alimentar. Conteúdo gratuito do NuvLev para te ajudar a comer melhor todos os dias.">
  <link rel="canonical" href="https://saudenaturall.online/blog">
  <meta property="og:title" content="Blog NuvLev — Nutrição e Receitas Saudáveis">
  <meta property="og:description" content="Dicas práticas de nutrição, receitas saudáveis e planejamento alimentar.">
  <meta property="og:url" content="https://saudenaturall.online/blog">
  <meta property="og:type" content="website">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',system-ui,sans-serif;color:#2D2D2D;background:#fff;line-height:1.6}
    a{text-decoration:none;color:inherit}
    /* NAV */
    .blog-nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.97);backdrop-filter:blur(10px);border-bottom:1px solid #f0e8e4;padding:0 5%}
    .blog-nav-inner{max-width:860px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:60px}
    .blog-logo{font-size:1.4rem;font-weight:900;color:#E76F51}
    .blog-logo span{color:#2D2D2D}
    .blog-nav-links{display:flex;gap:1.5rem;align-items:center;font-size:.9rem}
    .blog-nav-links a{color:#6B6B6B;transition:.2s}
    .blog-nav-links a:hover{color:#E76F51}
    .btn-nav-cta{background:#E76F51;color:#fff!important;padding:.4rem 1.1rem;border-radius:50px;font-weight:600;transition:.2s}
    .btn-nav-cta:hover{background:#C85A3C!important}
    /* HERO */
    .blog-hero{background:linear-gradient(135deg,#2D2D2D,#3d3d3d);padding:4rem 5% 3rem;text-align:center}
    .blog-hero-inner{max-width:640px;margin:0 auto}
    .blog-hero-tag{display:inline-block;background:rgba(231,111,81,.2);border:1px solid rgba(231,111,81,.4);color:#F4A261;padding:.3rem .9rem;border-radius:50px;font-size:.75rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:1rem}
    .blog-hero h1{font-size:2.2rem;font-weight:900;color:#fff;margin-bottom:.8rem;line-height:1.2}
    .blog-hero p{color:rgba(255,255,255,.7);font-size:1rem}
    /* POSTS */
    .blog-main{max-width:860px;margin:0 auto;padding:3rem 5%}
    .post-card{border-bottom:1px solid #f0ebe8;padding:2rem 0}
    .post-card:last-child{border-bottom:none}
    .post-meta{font-size:.78rem;color:#E76F51;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.5rem}
    .post-title{font-size:1.5rem;font-weight:800;margin-bottom:.6rem;line-height:1.25}
    .post-title a{color:#2D2D2D;transition:.2s}
    .post-title a:hover{color:#E76F51}
    .post-excerpt{color:#6B6B6B;font-size:.95rem;margin-bottom:1rem;line-height:1.6}
    .post-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem}
    .post-date{font-size:.82rem;color:#aaa}
    .post-read-more{color:#E76F51;font-weight:600;font-size:.9rem;transition:.2s}
    .post-read-more:hover{color:#C85A3C}
    /* CTA BANNER */
    .blog-cta{background:linear-gradient(135deg,#E76F51,#C85A3C);padding:3rem 5%;text-align:center;margin-top:2rem}
    .blog-cta h2{color:#fff;font-size:1.6rem;font-weight:900;margin-bottom:.5rem}
    .blog-cta p{color:rgba(255,255,255,.85);margin-bottom:1.5rem;font-size:.95rem}
    .btn-cta-blog{display:inline-block;background:#fff;color:#E76F51;padding:.85rem 2.5rem;border-radius:50px;font-weight:800;font-size:1rem;transition:.2s}
    .btn-cta-blog:hover{transform:translateY(-2px);box-shadow:0 4px 20px rgba(0,0,0,.2)}
    /* FOOTER */
    .blog-footer{background:#1a1a1a;padding:1.5rem 5%;text-align:center;color:rgba(255,255,255,.4);font-size:.82rem}
    .blog-footer strong{color:#E76F51}
    @media(max-width:600px){.blog-hero h1{font-size:1.6rem}.post-title{font-size:1.2rem}.blog-nav-links{display:none}}
  </style>
</head>
<body>
  <nav class="blog-nav">
    <div class="blog-nav-inner">
      <a href="/" class="blog-logo">Nuv<span>Lev</span></a>
      <div class="blog-nav-links">
        <a href="/blog">Blog</a>
        <a href="/#receitas">Receitas</a>
        <a href="https://pay.hotmart.com/M106116851N" class="btn-nav-cta">Assinar — R$19,90/mês</a>
      </div>
    </div>
  </nav>
  <header class="blog-hero">
    <div class="blog-hero-inner">
      <div class="blog-hero-tag">✦ Blog NuvLev</div>
      <h1>Nutrição que funciona na vida real</h1>
      <p>Receitas, planejamento alimentar e dicas práticas para você comer melhor todo dia.</p>
    </div>
  </header>
  <main class="blog-main">
    ${cards}
  </main>
  <section class="blog-cta">
    <h2>Pronto para organizar sua alimentação?</h2>
    <p>500+ receitas + 33 materiais bônus + planejador semanal + lista de compras automática por R$19,90/mês.</p>
    <a href="https://pay.hotmart.com/M106116851N" class="btn-cta-blog">Quero Assinar Agora →</a>
  </section>
  <footer class="blog-footer">
    <p><strong>NuvLev</strong> · saudenaturall.online · © 2025 Todos os direitos reservados</p>
    <p style="margin-top:.4rem;font-size:.74rem;opacity:.6">⚕️ Conteúdo informativo. Não substitui orientação de nutricionista (CRN).</p>
  </footer>
</body>
</html>`;
}

function renderBlogPost(post, allPosts) {
  const related = allPosts.filter(p => p.slug !== post.slug).slice(0, 2);
  const relatedCards = related.map(p => `
    <div class="related-card">
      <div class="post-meta"><span class="post-cat">${p.category}</span> · ${p.readTime}</div>
      <h3><a href="/blog/${p.slug}">${p.title}</a></h3>
      <p>${p.description.substring(0, 100)}...</p>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${post.title} — Blog NuvLev</title>
  <meta name="description" content="${post.description}">
  <link rel="canonical" href="https://saudenaturall.online/blog/${post.slug}">
  <meta property="og:title" content="${post.title}">
  <meta property="og:description" content="${post.description}">
  <meta property="og:url" content="https://saudenaturall.online/blog/${post.slug}">
  <meta property="og:type" content="article">
  <meta property="article:published_time" content="${post.date}">
  <script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": post.title,
    "description": post.description,
    "datePublished": post.date,
    "author": {"@type": "Organization", "name": "NuvLev"},
    "publisher": {"@type": "Organization", "name": "NuvLev", "url": "https://saudenaturall.online"}
  })}</script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',system-ui,sans-serif;color:#2D2D2D;background:#fff;line-height:1.7}
    a{text-decoration:none;color:inherit}
    .blog-nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.97);backdrop-filter:blur(10px);border-bottom:1px solid #f0e8e4;padding:0 5%}
    .blog-nav-inner{max-width:860px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:60px}
    .blog-logo{font-size:1.4rem;font-weight:900;color:#E76F51}
    .blog-logo span{color:#2D2D2D}
    .blog-nav-links{display:flex;gap:1.5rem;align-items:center;font-size:.9rem}
    .blog-nav-links a{color:#6B6B6B;transition:.2s}
    .blog-nav-links a:hover{color:#E76F51}
    .btn-nav-cta{background:#E76F51;color:#fff!important;padding:.4rem 1.1rem;border-radius:50px;font-weight:600}
    .post-wrap{max-width:700px;margin:0 auto;padding:3rem 5%}
    .post-breadcrumb{font-size:.82rem;color:#aaa;margin-bottom:1.5rem}
    .post-breadcrumb a{color:#E76F51}
    .post-header-meta{display:flex;align-items:center;gap:.8rem;margin-bottom:1rem;font-size:.82rem;color:#aaa}
    .post-cat-badge{background:#FFF3EE;color:#E76F51;padding:.2rem .7rem;border-radius:50px;font-weight:700;font-size:.75rem;text-transform:uppercase}
    .post-wrap h1{font-size:2rem;font-weight:900;line-height:1.2;margin-bottom:1rem;color:#1a1a1a}
    .post-lead{font-size:1.1rem;color:#555;border-left:3px solid #E76F51;padding-left:1rem;margin-bottom:2rem;font-style:italic}
    .post-body h2{font-size:1.35rem;font-weight:800;margin:2rem 0 .7rem;color:#1a1a1a}
    .post-body h3{font-size:1.1rem;font-weight:700;margin:1.5rem 0 .5rem;color:#2D2D2D}
    .post-body p{margin-bottom:1rem;color:#3a3a3a;font-size:.97rem}
    .post-body ul,.post-body ol{padding-left:1.5rem;margin-bottom:1rem}
    .post-body li{margin-bottom:.4rem;color:#3a3a3a;font-size:.97rem}
    .post-body strong{color:#1a1a1a}
    .post-body a{color:#E76F51;text-decoration:underline}
    .post-cta{background:linear-gradient(135deg,#E76F51,#C85A3C);border-radius:16px;padding:2rem;text-align:center;margin:2.5rem 0}
    .post-cta h3{color:#fff;font-size:1.3rem;font-weight:900;margin-bottom:.5rem}
    .post-cta p{color:rgba(255,255,255,.85);margin-bottom:1.2rem;font-size:.92rem}
    .btn-post-cta{display:inline-block;background:#fff;color:#E76F51;padding:.8rem 2rem;border-radius:50px;font-weight:800;font-size:.95rem;transition:.2s}
    .btn-post-cta:hover{transform:translateY(-2px)}
    .post-disclaimer{background:#f9f9f9;border-radius:8px;padding:1rem 1.2rem;margin-top:2rem;font-size:.8rem;color:#888;line-height:1.5}
    .related-section{border-top:1px solid #f0ebe8;padding-top:2rem;margin-top:2rem}
    .related-section h3{font-size:1rem;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:1px;margin-bottom:1.5rem}
    .related-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.2rem}
    .related-card{background:#f9f6f4;border-radius:12px;padding:1.2rem}
    .related-card h3{font-size:.95rem;font-weight:700;margin:.4rem 0 .5rem;line-height:1.3}
    .related-card h3 a{color:#2D2D2D;transition:.2s}
    .related-card h3 a:hover{color:#E76F51}
    .related-card p{font-size:.82rem;color:#888}
    .post-meta{font-size:.75rem;color:#E76F51;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
    .blog-footer{background:#1a1a1a;padding:1.5rem 5%;text-align:center;color:rgba(255,255,255,.4);font-size:.82rem;margin-top:3rem}
    .blog-footer strong{color:#E76F51}
    @media(max-width:600px){.post-wrap h1{font-size:1.5rem}.related-grid{grid-template-columns:1fr}.blog-nav-links{display:none}}
  </style>
</head>
<body>
  <nav class="blog-nav">
    <div class="blog-nav-inner">
      <a href="/" class="blog-logo">Nuv<span>Lev</span></a>
      <div class="blog-nav-links">
        <a href="/blog">Blog</a>
        <a href="/#receitas">Receitas</a>
        <a href="https://pay.hotmart.com/M106116851N" class="btn-nav-cta">Assinar — R$19,90/mês</a>
      </div>
    </div>
  </nav>
  <article class="post-wrap">
    <div class="post-breadcrumb"><a href="/blog">← Blog</a> / ${post.category}</div>
    <div class="post-header-meta">
      <span class="post-cat-badge">${post.category}</span>
      <span>${post.dateFormatted}</span>
      <span>·</span>
      <span>${post.readTime}</span>
    </div>
    <h1>${post.title}</h1>
    <p class="post-lead">${post.description}</p>
    <div class="post-body">${post.content}</div>
    ${leadBox('blog-post')}
    <div class="post-cta">
      <h3>Gostou? Veja na prática no NuvLev</h3>
      <p>500+ receitas organizadas + 33 materiais bônus + planejador semanal + lista de compras automática por R$19,90/mês.</p>
      <a href="https://pay.hotmart.com/M106116851N" class="btn-post-cta">Quero Assinar Agora →</a>
    </div>
    <div class="post-disclaimer">⚕️ Este conteúdo tem caráter informativo e educacional. Não substitui orientação médica ou nutricional profissional. Consulte um nutricionista (CRN) antes de realizar mudanças na sua alimentação.</div>
    <div class="related-section">
      <h3>Leia também</h3>
      <div class="related-grid">${relatedCards}</div>
    </div>
  </article>
  <footer class="blog-footer">
    <p><strong>NuvLev</strong> · saudenaturall.online · © 2025 Todos os direitos reservados</p>
  </footer>
</body>
</html>`;
}

// Posts dinâmicos (Firestore) + estáticos do código
async function getAllPosts() {
  let dyn = [];
  try {
    const snap = await db.collection('blog_posts').get();
    dyn = snap.docs.map(d => d.data());
  } catch (e) { console.error('Erro ao ler blog_posts:', e.message); }
  const statics = BLOG_POSTS.filter(p => !dyn.find(d => d.slug === p.slug));
  return [...statics, ...dyn].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// Blog routes
app.get('/blog', async (req, res) => {
  res.send(renderBlogIndex(await getAllPosts()));
});

app.get('/blog/:slug', async (req, res) => {
  const posts = await getAllPosts();
  const post = posts.find(p => p.slug === req.params.slug);
  if (!post) return res.status(404).redirect('/blog');
  res.send(renderBlogPost(post, posts));
});

// ── Admin do blog (protegido por ADMIN_TOKEN) ───────────────────────────────
function checkAdmin(req, res) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'Não autorizado' });
    return false;
  }
  return true;
}

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/admin/blog/list', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json({ posts: await getAllPosts() });
});

app.post('/admin/blog', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const p = req.body || {};
    if (!p.slug || !p.title || !p.content)
      return res.status(400).json({ error: 'slug, title e content são obrigatórios' });
    await db.collection('blog_posts').doc(p.slug).set(p, { merge: true });
    console.log('📝 Post publicado/atualizado:', p.slug);
    res.json({ ok: true, url: '/blog/' + p.slug });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/blog/delete', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    await db.collection('blog_posts').doc((req.body || {}).slug).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── RECEITAS PÚBLICAS (SEO) + CAPTURA DE LEADS ──────────────────────────────
function normalizeRecipe(r) {
  let ings = r.ingredients || [];
  if (ings.length === 1 && ings[0].includes(';'))
    ings = ings[0].split(';').map(s => s.trim()).filter(Boolean);
  let steps = r.steps || [];
  if (steps.length === 1 && /\d\)/.test(steps[0]))
    steps = steps[0].split(/\s*\d+\)\s*/).map(s => s.trim()).filter(Boolean);
  const name = r.name.replace(/^Receita \d+ — /, '').replace(/\s*Tempo total:.*$/i, '').trim();
  return { ...r, name, ingredients: ings, steps };
}
const PUBLIC_RECIPES = require('./public-recipes.json').map(normalizeRecipe);
const LEAD_PDF = '/downloads/10-jantares-saudaveis-15-minutos.pdf';

function leadBox(origem) {
  return `
  <div style="background:linear-gradient(135deg,#fdf3ec,#fbe8dd);border:2px solid #E76F51;border-radius:18px;padding:1.8rem 1.5rem;margin:2.5rem 0;text-align:center">
    <h3 style="color:#2a2a35;font-size:1.25rem;margin-bottom:.4rem">🎁 Grátis: 10 Jantares Saudáveis de 15 Minutos</h3>
    <p style="color:#666;font-size:.92rem;margin-bottom:1rem">Deixe seu e-mail e baixe agora o PDF com 10 receitas práticas de jantar para a semana.</p>
    <form onsubmit="return nlLead(this,'${origem}')" style="display:flex;gap:.6rem;max-width:430px;margin:0 auto;flex-wrap:wrap;justify-content:center">
      <input type="email" name="email" required placeholder="Seu melhor e-mail" style="flex:1;min-width:200px;padding:.8rem 1rem;border:2px solid #e8d5c8;border-radius:50px;font-size:.95rem;font-family:inherit">
      <button type="submit" style="background:#E76F51;color:#fff;border:none;border-radius:50px;padding:.8rem 1.5rem;font-weight:800;cursor:pointer;font-size:.92rem;font-family:inherit">Quero o PDF →</button>
    </form>
    <p class="nl-lead-ok" style="display:none;margin-top:1rem;font-weight:700"><a href="${LEAD_PDF}" style="color:#1e7e46" download>✅ Pronto! Clique aqui para baixar seu PDF →</a></p>
  </div>
  <script>
  if (typeof nlLead === 'undefined') {
    async function nlLead(f, origem) {
      const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Enviando...';
      try {
        await fetch('/lead', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ email: f.email.value, origem }) });
        f.style.display = 'none';
        f.parentElement.querySelector('.nl-lead-ok').style.display = 'block';
      } catch(e) { btn.disabled = false; btn.textContent = 'Quero o PDF →'; alert('Erro de conexão, tente de novo.'); }
      return false;
    }
    window.nlLead = nlLead;
  }
  </script>`;
}

function recipeDesc(r) {
  const ing = (r.ingredients || []).length;
  return `Receita de ${r.name}: ${ing} ingredientes, passo a passo simples e benefício explicado. Veja como fazer — grátis no NuvLev.`.slice(0, 158);
}

function renderRecipeHead(title, desc, url, jsonld) {
  return `<!DOCTYPE html><html lang="pt-BR"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${desc}">
  <link rel="canonical" href="${url}">
  <meta property="og:title" content="${title}"><meta property="og:description" content="${desc}">
  <meta property="og:url" content="${url}"><meta property="og:type" content="article">
  ${jsonld ? `<script type="application/ld+json">${jsonld}</scr` + `ipt>` : ''}
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#faf7f2;color:#2D2D2D;line-height:1.65}
    .r-nav{background:#fff;padding:1rem 5%;box-shadow:0 1px 8px rgba(0,0,0,.06);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem}
    .r-logo{font-size:1.3rem;font-weight:900;color:#2a2a35;text-decoration:none}.r-logo span{color:#E76F51}
    .r-nav a{text-decoration:none}
    .r-links a{color:#555;font-size:.9rem;margin-left:1.1rem;font-weight:600}
    .r-cta-nav{background:#E76F51;color:#fff!important;padding:.5rem 1.1rem;border-radius:50px;font-weight:700}
    .wrap{max-width:760px;margin:0 auto;padding:2.5rem 1.2rem}
    h1{font-size:1.9rem;line-height:1.25;margin:.5rem 0 1rem}
    .crumb{font-size:.85rem;color:#999}.crumb a{color:#E76F51;text-decoration:none}
    .badge{display:inline-block;background:#fdeee7;color:#E76F51;font-size:.75rem;font-weight:800;padding:.3rem .9rem;border-radius:50px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.6rem}
    h2{font-size:1.25rem;color:#E76F51;margin:1.8rem 0 .8rem}
    ul,ol{margin:0 0 1rem 1.4rem}li{margin-bottom:.5rem}
    .benefit{background:#eef7f0;border-left:4px solid #27AE60;border-radius:0 12px 12px 0;padding:1rem 1.2rem;margin:1.5rem 0;font-size:.95rem}
    .cta{background:#1a1a2e;border-radius:18px;padding:2rem 1.5rem;text-align:center;margin:2.5rem 0}
    .cta h3{color:#fff;font-size:1.3rem;margin-bottom:.5rem}.cta p{color:#bbb;font-size:.92rem;margin-bottom:1.2rem}
    .cta a{display:inline-block;background:#27AE60;color:#fff;text-decoration:none;font-weight:800;padding:.9rem 2rem;border-radius:50px}
    .rel{margin-top:2.5rem}.rel h3{margin-bottom:.8rem}
    .rel a{display:block;background:#fff;border-radius:12px;padding:.9rem 1.1rem;margin-bottom:.6rem;color:#2D2D2D;text-decoration:none;font-weight:600;box-shadow:0 1px 5px rgba(0,0,0,.05)}
    .rel a:hover{color:#E76F51}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:.8rem;margin-top:1rem}
    .grid a{background:#fff;border-radius:14px;padding:1.1rem 1.2rem;color:#2D2D2D;text-decoration:none;font-weight:600;box-shadow:0 1px 5px rgba(0,0,0,.05);font-size:.95rem}
    .grid a:hover{color:#E76F51}
    .grid small{display:block;color:#999;font-weight:400;font-size:.78rem;margin-top:.2rem}
    .vol-h{font-size:1.15rem;margin:2rem 0 .3rem;color:#2a2a35}
    .foot{background:#1a1a1a;padding:1.5rem 5%;text-align:center;color:rgba(255,255,255,.45);font-size:.8rem;margin-top:3rem;line-height:1.6}
    .foot strong{color:#E76F51}
    .disc{font-size:.78rem;color:#999;margin-top:2rem;line-height:1.5}
  </style></head><body>
  <nav class="r-nav">
    <a href="/" class="r-logo">Nuv<span>Lev</span></a>
    <div class="r-links">
      <a href="/receitas">Receitas Grátis</a><a href="/blog">Blog</a>
      <a href="https://pay.hotmart.com/M106116851N" class="r-cta-nav">Assinar — R$19,90/mês</a>
    </div>
  </nav>`;
}

const RECIPE_FOOT = `<footer class="foot"><p><strong>NuvLev</strong> · saudenaturall.online · © 2025 Todos os direitos reservados</p></footer></body></html>`;

function renderRecipeIndex() {
  const base = 'https://saudenaturall.online';
  const groups = {};
  PUBLIC_RECIPES.forEach(r => { (groups[r.volLabel] = groups[r.volLabel] || []).push(r); });
  const body = Object.keys(groups).map(label => `
    <h2 class="vol-h">${groups[label][0].emoji} ${label}</h2>
    <div class="grid">${groups[label].map(r =>
      `<a href="/receitas/${r.slug}">${r.name}<small>${(r.ingredients||[]).length} ${(r.ingredients||[]).length===1?'ingrediente':'ingredientes'}</small></a>`).join('')}
    </div>`).join('');
  return renderRecipeHead(
    'Receitas Saudáveis Grátis — Café, Almoço, Jantar e Lanches | NuvLev',
    '40 receitas saudáveis grátis com passo a passo completo: café da manhã, almoço, jantar e lanches rápidos. Sem cadastro, direto do NuvLev.',
    base + '/receitas', null) + `
  <div class="wrap">
    <div class="crumb"><a href="/">Início</a> / Receitas grátis</div>
    <h1>Receitas saudáveis grátis, com passo a passo completo</h1>
    <p>Uma amostra aberta das <strong>500+ receitas</strong> da plataforma NuvLev — escolhidas entre as mais práticas, com poucos ingredientes.</p>
    ${body}
    ${leadBox('pagina-receitas')}
    <div class="cta">
      <h3>Gostou? Isso é só 6% do acervo.</h3>
      <p>500+ receitas organizadas + 33 materiais bônus + planejador semanal + lista de compras automática.</p>
      <a href="https://pay.hotmart.com/M106116851N">Assinar por R$19,90/mês →</a>
    </div>
  </div>` + RECIPE_FOOT;
}

function renderRecipePage(r) {
  const base = 'https://saudenaturall.online';
  const url = `${base}/receitas/${r.slug}`;
  const others = PUBLIC_RECIPES.filter(x => x.slug !== r.slug && x.vol === r.vol).slice(0, 3);
  const jsonld = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Recipe',
    name: r.name, author: { '@type': 'Organization', name: 'NuvLev' },
    recipeCategory: r.category || 'Saudável', recipeCuisine: 'Brasileira',
    recipeIngredient: r.ingredients,
    recipeInstructions: (r.steps || []).map(s => ({ '@type': 'HowToStep', text: s })),
    description: recipeDesc(r), url
  });
  return renderRecipeHead(`${r.name} — Receita | NuvLev`, recipeDesc(r), url, jsonld) + `
  <div class="wrap">
    <div class="crumb"><a href="/receitas">← Receitas grátis</a></div>
    <div style="margin-top:1rem"><span class="badge">${r.emoji} ${r.volLabel}</span></div>
    <h1>${r.name}</h1>
    <h2>🥘 Ingredientes</h2>
    <ul>${(r.ingredients || []).map(i => `<li>${i}</li>`).join('')}</ul>
    <h2>👨‍🍳 Modo de preparo</h2>
    <ol>${(r.steps || []).map(s => `<li>${s}</li>`).join('')}</ol>
    ${r.benefit ? `<div class="benefit"><strong>💡 Por que essa receita funciona:</strong> ${r.benefit}</div>` : ''}
    ${leadBox('receita-' + r.slug)}
    <div class="cta">
      <h3>Essa é 1 das 500+ receitas do NuvLev</h3>
      <p>Todas organizadas por refeição e objetivo, com planejador semanal e lista de compras automática.</p>
      <a href="https://pay.hotmart.com/M106116851N">Quero as 500+ receitas →</a>
    </div>
    ${others.length ? `<div class="rel"><h3>Veja também</h3>${others.map(o => `<a href="/receitas/${o.slug}">${o.emoji} ${o.name}</a>`).join('')}</div>` : ''}
    <p class="disc">⚕️ Conteúdo informativo e educacional. Não substitui orientação médica ou nutricional profissional. Consulte um nutricionista (CRN).</p>
  </div>` + RECIPE_FOOT;
}

app.get('/receitas', (req, res) => res.send(renderRecipeIndex()));
app.get('/receitas/:slug', (req, res) => {
  const r = PUBLIC_RECIPES.find(x => x.slug === req.params.slug);
  if (!r) return res.status(404).redirect('/receitas');
  res.send(renderRecipePage(r));
});

// Captura de leads
app.post('/lead', async (req, res) => {
  const email = ((req.body || {}).email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return res.status(400).json({ error: 'E-mail inválido' });
  try {
    await db.collection('leads').doc(email).set({
      email, origem: (req.body.origem || '').slice(0, 100),
      criadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.log('📧 Novo lead:', email);
  } catch (e) { console.error('Erro ao salvar lead:', e.message); }
  // Envia para a Brevo (lista Leads NuvLev → dispara a sequência de boas-vindas)
  if (process.env.BREVO_API_KEY && typeof fetch === 'function') {
    try {
      await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, listIds: [5], updateEnabled: true })
      });
      console.log('📨 Lead enviado à Brevo:', email);
    } catch (e) { console.error('Erro Brevo:', e.message); }
  }
  res.json({ ok: true, pdf: LEAD_PDF });
});

// Exportar leads (CSV) — protegido
app.get('/admin/leads', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const snap = await db.collection('leads').orderBy('criadoEm', 'desc').get();
    const rows = snap.docs.map(d => d.data());
    const csv = 'email;origem;data\n' + rows.map(r =>
      `${r.email};${r.origem || ''};${r.criadoEm && r.criadoEm.toDate ? r.criadoEm.toDate().toISOString().slice(0, 10) : ''}`).join('\n');
    res.type('text/csv').send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SEO: sitemap + robots ───────────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  const base = 'https://saudenaturall.online';
  const urls = [
    { loc: base + '/termos', priority: '0.3' }, { loc: base + '/privacidade', priority: '0.3' },
    { loc: base + '/', priority: '1.0' },
    { loc: base + '/blog', priority: '0.8' },
    { loc: base + '/receitas', priority: '0.8' },
    ...PUBLIC_RECIPES.map(r => ({ loc: `${base}/receitas/${r.slug}`, priority: '0.6' })),
    ...(await getAllPosts()).map(p => ({ loc: `${base}/blog/${p.slug}`, lastmod: p.date, priority: '0.7' }))
  ];
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => `  <url><loc>${u.loc}</loc>${u.lastmod ? '<lastmod>' + u.lastmod + '</lastmod>' : ''}<priority>${u.priority}</priority></url>`).join('\n') +
    '\n</urlset>';
  res.type('application/xml').send(xml);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\n\nSitemap: https://saudenaturall.online/sitemap.xml\n');
});

const PORT = process.env.PORT || 3000;
// ── PÁGINAS LEGAIS: /termos e /privacidade ───────────────────────────────────────
const CONTATO_EMAIL = process.env.CONTATO_EMAIL || 'contato@saudenaturall.online';
const LEGAL_ATUALIZADO = '9 de setembro de 2026';
function renderLegal(title, desc, body) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — NuvLev</title><meta name="description" content="${desc}"><link rel="canonical" href="https://saudenaturall.online${title === 'Termos de Uso' ? '/termos' : '/privacidade'}">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;color:#2D2D2D;line-height:1.7;background:#fff}
nav{border-bottom:1px solid #f0e8e4;padding:0 5%}.nav-inner{max-width:820px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:60px}
.logo{font-size:1.4rem;font-weight:900;color:#E76F51;text-decoration:none}.logo span{color:#2D2D2D}nav a.lnk{color:#6B6B6B;text-decoration:none;font-size:.9rem;margin-left:1.2rem}
main{max-width:820px;margin:0 auto;padding:3rem 5% 4rem}h1{font-size:2rem;font-weight:900;margin-bottom:.4rem}.upd{color:#888;font-size:.85rem;margin-bottom:2rem}
h2{font-size:1.2rem;font-weight:800;margin:2rem 0 .6rem;color:#C85A3C}p,li{font-size:.98rem;margin-bottom:.7rem}ul{padding-left:1.4rem}
.box{background:#FFF3EE;border-left:4px solid #E76F51;padding:1rem 1.2rem;border-radius:0 10px 10px 0;margin:1.2rem 0}
footer{background:#1a1a1a;color:rgba(255,255,255,.5);text-align:center;padding:1.5rem 5%;font-size:.85rem}footer a{color:#E76F51;text-decoration:none;margin:0 .5rem}</style></head>
<body><nav><div class="nav-inner"><a class="logo" href="/">Nuv<span>Lev</span></a><div><a class="lnk" href="/termos">Termos</a><a class="lnk" href="/privacidade">Privacidade</a><a class="lnk" href="/blog">Blog</a></div></div></nav>
<main><h1>${title}</h1><p class="upd">Última atualização: ${LEGAL_ATUALIZADO}</p>${body}</main>
<footer>© 2025 NuvLev · saudenaturall.online<br><a href="/termos">Termos de Uso</a>·<a href="/privacidade">Política de Privacidade</a>·<a href="/">Início</a></footer></body></html>`;
}

app.get('/termos', (req, res) => res.send(renderLegal('Termos de Uso', 'Termos de uso da plataforma NuvLev: assinatura, cancelamento, reembolso e uso do conteúdo.', `
<p>Estes Termos regulam o uso da plataforma <strong>NuvLev</strong>, disponibilizada em <strong>saudenaturall.online</strong> ("Plataforma"). Ao criar conta, assinar ou utilizar a Plataforma, você concorda com estes Termos.</p>
<h2>1. O que é a Plataforma</h2>
<p>A NuvLev é um serviço digital por assinatura que oferece acesso a uma biblioteca de receitas, planejador semanal de refeições, lista de compras automática, materiais em PDF e conteúdos educativos sobre alimentação.</p>
<h2>2. Cadastro e conta</h2>
<ul><li>O acesso é pessoal e intransferível. Você é responsável por manter sua senha em sigilo.</li><li>É necessário ter 18 anos ou mais, ou autorização do responsável legal.</li><li>Informações falsas no cadastro podem resultar em suspensão da conta.</li></ul>
<h2>3. Assinatura, pagamento e renovação</h2>
<ul><li>Os pagamentos são processados pela <strong>Hotmart</strong>, que emite a cobrança e a nota fiscal.</li><li>A assinatura mensal renova automaticamente a cada 30 dias; a anual, a cada 12 meses, até que seja cancelada.</li><li>Os valores vigentes são os exibidos na página de compra no momento da contratação. Alterações de preço serão comunicadas com antecedência e valem apenas para renovações futuras.</li></ul>
<h2>4. Cancelamento e reembolso</h2>
<div class="box"><p><strong>Garantia de 7 dias:</strong> nos termos do art. 49 do Código de Defesa do Consumidor, você pode solicitar o reembolso integral em até 7 dias após a compra, diretamente pela Hotmart, sem necessidade de justificativa.</p></div>
<ul><li>Você pode cancelar a renovação a qualquer momento pela sua conta Hotmart. O acesso permanece até o fim do período já pago.</li><li>Não há fidelidade nem taxa de cancelamento.</li><li>Após os 7 dias, não há reembolso proporcional de períodos já iniciados.</li></ul>
<h2>5. Propriedade intelectual</h2>
<p>Todo o conteúdo da Plataforma (receitas, textos, organização, PDFs, marca e layout) é protegido por direitos autorais. É proibido copiar, redistribuir, revender, compartilhar login ou reproduzir o conteúdo, no todo ou em parte, sem autorização expressa. O uso é exclusivamente pessoal e não comercial.</p>
<h2>6. Aviso de saúde</h2>
<div class="box"><p>O conteúdo da NuvLev tem caráter <strong>informativo e educacional</strong>. Não substitui consulta, diagnóstico ou orientação de médico ou nutricionista. Pessoas com condições de saúde, alergias, gestantes, lactantes ou em uso de medicamentos devem consultar um profissional antes de alterar a alimentação. Resultados variam de pessoa para pessoa e não são garantidos.</p></div>
<h2>7. Disponibilidade e alterações</h2>
<p>Trabalhamos para manter a Plataforma disponível 24h, mas podem ocorrer interrupções para manutenção ou por fatores externos. Podemos adicionar, alterar ou remover funcionalidades e conteúdos a qualquer momento, mantendo a essência do serviço contratado.</p>
<h2>8. Programa de afiliados</h2>
<p>A divulgação por afiliados é feita pela Hotmart e regida pelas regras daquela plataforma. Afiliados não podem fazer promessas de resultados de saúde, usar spam ou anúncios enganosos.</p>
<h2>9. Suspensão de conta</h2>
<p>Podemos suspender ou encerrar contas que violem estes Termos, especialmente em casos de compartilhamento de acesso, cópia de conteúdo ou fraude, sem direito a reembolso.</p>
<h2>10. Legislação e contato</h2>
<p>Estes Termos são regidos pelas leis da República Federativa do Brasil, em especial o Código de Defesa do Consumidor e o Marco Civil da Internet. Dúvidas: <strong>${CONTATO_EMAIL}</strong>.</p>`)));

app.get('/privacidade', (req, res) => res.send(renderLegal('Política de Privacidade', 'Como a NuvLev coleta, usa e protege seus dados pessoais, conforme a LGPD.', `
<p>Esta Política explica como a <strong>NuvLev</strong> (saudenaturall.online) trata seus dados pessoais, em conformidade com a <strong>Lei Geral de Proteção de Dados (Lei 13.709/2018 – LGPD)</strong>.</p>
<h2>1. Quais dados coletamos</h2>
<ul><li><strong>Cadastro e login:</strong> nome e e-mail.</li><li><strong>Compra:</strong> os dados de pagamento são coletados e processados exclusivamente pela Hotmart; a NuvLev recebe apenas a confirmação da transação, nome e e-mail do comprador.</li><li><strong>Captura de materiais gratuitos:</strong> e-mail informado nos formulários do site e do blog.</li><li><strong>Uso da Plataforma:</strong> receitas favoritas, planejador semanal e lista de compras, armazenados no seu próprio navegador (localStorage) e/ou na sua conta.</li><li><strong>Dados técnicos:</strong> endereço IP, tipo de navegador e registros de acesso, coletados automaticamente pelos servidores para segurança e cumprimento do Marco Civil da Internet.</li></ul>
<h2>2. Para que usamos</h2>
<ul><li>Liberar e manter seu acesso à assinatura;</li><li>Enviar o material gratuito solicitado e comunicações sobre a NuvLev (você pode se descadastrar em qualquer e-mail);</li><li>Prestar suporte;</li><li>Cumprir obrigações legais e prevenir fraudes;</li><li>Melhorar a Plataforma.</li></ul>
<h2>3. Base legal</h2>
<p>Tratamos seus dados com base na <strong>execução do contrato</strong> (assinatura), no <strong>consentimento</strong> (materiais gratuitos e comunicações), no <strong>cumprimento de obrigação legal</strong> e no <strong>legítimo interesse</strong> (segurança e melhoria do serviço).</p>
<h2>4. Com quem compartilhamos</h2>
<p>Não vendemos seus dados. Compartilhamos apenas com fornecedores necessários à operação, que seguem suas próprias políticas de privacidade:</p>
<ul><li><strong>Hotmart</strong> – processamento de pagamentos e gestão da assinatura;</li><li><strong>Google Firebase</strong> – autenticação e banco de dados;</li><li><strong>Brevo</strong> – envio de e-mails;</li><li><strong>Railway</strong> – hospedagem do site.</li></ul>
<p>Alguns desses fornecedores podem armazenar dados fora do Brasil, com garantias adequadas de proteção.</p>
<h2>5. Cookies e armazenamento local</h2>
<p>Usamos armazenamento local do navegador para manter seu login, suas preferências, favoritos e planejador. Não utilizamos cookies de publicidade de terceiros. Você pode limpar esses dados nas configurações do seu navegador.</p>
<h2>6. Por quanto tempo guardamos</h2>
<p>Mantemos seus dados enquanto sua conta estiver ativa e pelo prazo necessário ao cumprimento de obrigações legais (registros de acesso por 6 meses, conforme o Marco Civil; dados fiscais pelo prazo exigido em lei). Dados de e-mail para comunicações são mantidos até o descadastro.</p>
<h2>7. Seus direitos (LGPD)</h2>
<p>Você pode, a qualquer momento, solicitar: confirmação e acesso aos dados; correção; anonimização ou exclusão; portabilidade; informação sobre compartilhamento; e revogação do consentimento. Basta escrever para <strong>${CONTATO_EMAIL}</strong>. Responderemos em até 15 dias.</p>
<h2>8. Segurança</h2>
<p>Adotamos medidas técnicas como conexão HTTPS, autenticação com senha e controle de acesso ao conteúdo por token. Nenhum sistema é 100% seguro; em caso de incidente relevante, comunicaremos os titulares e a ANPD conforme a lei.</p>
<h2>9. Menores de idade</h2>
<p>A Plataforma não é destinada a menores de 18 anos sem autorização dos responsáveis. Se identificarmos dados de menores coletados indevidamente, faremos a exclusão.</p>
<h2>10. Alterações e contato</h2>
<p>Esta Política pode ser atualizada; a data da última revisão aparece no topo. Encarregado de dados (DPO) e dúvidas: <strong>${CONTATO_EMAIL}</strong>.</p>`)));

app.listen(PORT, () => console.log(`🚀 Servidor na porta ${PORT}`));
