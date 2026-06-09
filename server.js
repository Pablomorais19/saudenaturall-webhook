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
      <p>O <a href="https://saudenaturall.online" style="color:#E76F51">NuvLev</a> tem um planejador semanal integrado onde você monta toda a semana em minutos e gera a lista de compras com um clique — automticamente, já organizada por ingredientes. São 614 receitas com filtros por refeição, objetivo e tempo de preparo para você nunca ficar sem ideia.</p>

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
    <p>614 receitas + planejador semanal + lista de compras automática por R$19,90/mês.</p>
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
    <div class="post-cta">
      <h3>Gostou? Veja na prática no NuvLev</h3>
      <p>614 receitas organizadas + planejador semanal + lista de compras automática por R$19,90/mês.</p>
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

// Blog routes
app.get('/blog', (req, res) => {
  res.send(renderBlogIndex(BLOG_POSTS));
});

app.get('/blog/:slug', (req, res) => {
  const post = BLOG_POSTS.find(p => p.slug === req.params.slug);
  if (!post) return res.status(404).redirect('/blog');
  res.send(renderBlogPost(post, BLOG_POSTS));
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor na porta ${PORT}`));
