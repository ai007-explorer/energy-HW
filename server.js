// ═══════════════════════════════════════════════════════
// 华为数字能源竞争情报平台 · 后端服务器
// 功能：定时抓取(每周一) + 每日邮件(7am北京时间) + API + 存储
// ═══════════════════════════════════════════════════════
import express from 'express';
import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 环境变量 ───
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN || 'change-me';

const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;
const resend    = RESEND_KEY ? new Resend(RESEND_KEY) : null;

// ─── 数据持久化（Railway 有持久卷，用文件存储）───
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('load store error', e); }
  return {
    competitors: [
      '华为数字能源','阳光电源','德业股份','锦浪科技','汇川技术','科华数据',
      '科士达','盛弘股份','优优绿能','思格新能源','宁德时代','特斯拉',
      '维谛技术','伊顿','特锐德'
    ],
    subscribers: [],
    ceo: [], financial: [], analyst: [], news: [], moat: [],
    lastFetch: null
  };
}
function saveStore(s) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2)); }
  catch (e) { console.error('save store error', e); }
}
let store = loadStore();

// ═══════════════════════════════════════════════════════
// 7天过滤工具
// ═══════════════════════════════════════════════════════
function within7Days(dateStr) {
  const d = new Date(dateStr), now = new Date();
  const diff = now - d;
  return diff <= 7 * 24 * 3600 * 1000 && diff >= -24 * 3600 * 1000;
}
function prune() {
  // 高管发言、热点新闻只保留7天内
  store.ceo  = store.ceo.filter(x => within7Days(x.date));
  store.news = store.news.filter(x => within7Days(x.date));
  // 财报、分析师观点保留30天（更新频率低）
  store.financial = store.financial.filter(x => {
    const diff = new Date() - new Date(x.date);
    return diff <= 30 * 24 * 3600 * 1000;
  });
  store.analyst = store.analyst.filter(x => {
    const diff = new Date() - new Date(x.date);
    return diff <= 30 * 24 * 3600 * 1000;
  });
}

// ═══════════════════════════════════════════════════════
// Claude 调用封装（带 web_search）
// ═══════════════════════════════════════════════════════
async function askClaude(systemPrompt, userPrompt, useSearch = true) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY 未配置');
  const params = {
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };
  if (useSearch) {
    params.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];
  }
  const resp = await anthropic.messages.create(params);
  return resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function parseJSON(text) {
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = Math.min(
    clean.indexOf('{') >= 0 ? clean.indexOf('{') : Infinity,
    clean.indexOf('[') >= 0 ? clean.indexOf('[') : Infinity
  );
  if (start === Infinity) throw new Error('no JSON');
  // find matching end
  const sub = clean.slice(start);
  return JSON.parse(sub);
}

// ═══════════════════════════════════════════════════════
// 抓取任务：四个模块
// ═══════════════════════════════════════════════════════
async function fetchCEO() {
  const comps = store.competitors.join('、');
  const sys = `你是数字能源行业的竞争情报分析师。只收集这些公司的董事长/CEO/创始人本人在过去7天的公开发言。只要本人直接说的话，不要二手转述或他人评论。所有信息必须附准确来源链接，优先官方来源。仅回复JSON数组。`;
  const prompt = `搜索以下数字能源公司的最高领导人（董事长/CEO/创始人）在过去7天内的公开发言：${comps}

返回JSON数组，每条：
{"id":"唯一id","comp":"公司名","person":"姓名 职位","date":"YYYY-MM-DD","title":"标题","summary":"发言总结(中文100字)","quote":"核心观点原文","sources":[{"label":"来源名","url":"链接","official":true或false}]}

只返回过去7天内的真实发言，找不到就返回[]。务必附真实来源链接。`;
  const raw = await askClaude(sys, prompt, true);
  try {
    let items = parseJSON(raw);
    if (!Array.isArray(items)) items = items.results || items.data || [];
    return items.filter(x => x && x.title);
  } catch (e) { console.error('fetchCEO parse', e); return []; }
}

async function fetchFinancial() {
  const comps = store.competitors.join('、');
  const sys = `你是财务分析师。收集这些公司过去30天内新披露的财报或业绩公告。所有数据必须附官方来源（公司IR页面、交易所公告）。仅回复JSON数组。`;
  const prompt = `搜索以下公司过去30天内新披露的财报/业绩快报：${comps}

返回JSON数组，每条：
{"id":"唯一id","comp":"公司名","period":"报告期如2026 Q1","rev":"营收","yoy":"同比","profit":"净利润","date":"披露日期YYYY-MM-DD","summary":"财报要点(中文80字)","source":"官方来源链接","official":true}

只返回真实披露的财报，找不到返回[]。`;
  const raw = await askClaude(sys, prompt, true);
  try {
    let items = parseJSON(raw);
    if (!Array.isArray(items)) items = items.results || items.data || [];
    return items.filter(x => x && x.comp);
  } catch (e) { console.error('fetchFin parse', e); return []; }
}

async function fetchAnalyst() {
  const comps = store.competitors.filter(c => c !== '华为数字能源').join('、');
  const sys = `你是研究主管。收集国际投行和券商对这些公司过去30天的最新评级和观点，特别关注高盛、摩根士丹利、摩根大通、瑞银等国际投行。仅回复JSON数组。`;
  const prompt = `搜索国际投行/券商对以下公司过去30天的最新研报观点：${comps}

返回JSON数组，每条：
{"id":"唯一id","comp":"公司名","firm":"机构名","rating":"buy或hold或sell","target":"目标价","date":"YYYY-MM-DD","note":"观点提炼(中文100字)","source":"来源链接"}

优先国际投行，只返回真实研报，找不到返回[]。`;
  const raw = await askClaude(sys, prompt, true);
  try {
    let items = parseJSON(raw);
    if (!Array.isArray(items)) items = items.results || items.data || [];
    return items.filter(x => x && x.comp);
  } catch (e) { console.error('fetchAna parse', e); return []; }
}

async function fetchNews() {
  const comps = store.competitors.filter(c => c !== '华为数字能源').join('、');
  const sys = `你是华为数字能源的竞争情报分析师。收集友商过去7天的重大热点新闻，并分析每条对华为数字能源经营的启示。仅回复JSON数组。`;
  const prompt = `搜索以下数字能源友商过去7天的重大热点新闻：${comps}

返回JSON数组，每条：
{"id":"唯一id","comp":"公司名","date":"YYYY-MM-DD","title":"新闻标题","summary":"新闻摘要(中文100字)","impact":"对华为数字能源的启示和应对建议(中文120字)","sources":[{"label":"来源名","url":"链接","official":true或false}]}

只返回过去7天内的真实新闻，找不到返回[]。务必附真实来源。`;
  const raw = await askClaude(sys, prompt, true);
  try {
    let items = parseJSON(raw);
    if (!Array.isArray(items)) items = items.results || items.data || [];
    return items.filter(x => x && x.title);
  } catch (e) { console.error('fetchNews parse', e); return []; }
}

async function generateMoat() {
  // 基于已抓取的讲话/财报/新闻，提炼长期竞争优势
  const ctx = {
    ceo: store.ceo.slice(0, 10).map(c => `${c.comp}-${c.person}: ${c.summary}`),
    fin: store.financial.slice(0, 8).map(f => `${f.comp} ${f.period}: ${f.summary}`),
    news: store.news.slice(0, 8).map(n => `${n.comp}: ${n.title}`)
  };
  const sys = `你是战略分析师。基于领导人讲话、财报数据、热点新闻，提炼每家公司的长期竞争优势及维持策略。仅回复JSON数组。`;
  const prompt = `基于以下信息，为每家数字能源公司提炼长期竞争优势：

领导人讲话：${JSON.stringify(ctx.ceo)}
财报信息：${JSON.stringify(ctx.fin)}
热点新闻：${JSON.stringify(ctx.news)}

公司列表：${store.competitors.join('、')}

返回JSON数组，每条：
{"comp":"公司名","hw":如果是华为数字能源则true否则false,"advantages":["优势1","优势2","优势3","优势4"],"strategy":"如何维持长期优势的策略(中文120字)","sources":[{"label":"来源","url":"链接","official":true}]}

为每家公司提炼。`;
  const raw = await askClaude(sys, prompt, false);
  try {
    let items = parseJSON(raw);
    if (!Array.isArray(items)) items = items.results || items.data || [];
    return items.filter(x => x && x.comp);
  } catch (e) { console.error('genMoat parse', e); return []; }
}

// ─── 合并去重 ───
function mergeItems(existing, fresh) {
  const ids = new Set(existing.map(x => x.id));
  const newOnes = fresh.filter(x => !ids.has(x.id));
  return [...newOnes, ...existing];
}

// ─── 完整抓取流程 ───
async function runFullFetch() {
  console.log('[FETCH] 开始抓取', new Date().toISOString());
  try {
    const [ceo, fin, ana, news] = await Promise.all([
      fetchCEO(), fetchFinancial(), fetchAnalyst(), fetchNews()
    ]);
    store.ceo       = mergeItems(store.ceo, ceo);
    store.financial = mergeItems(store.financial, fin);
    store.analyst   = mergeItems(store.analyst, ana);
    store.news      = mergeItems(store.news, news);
    // moat 基于以上结果生成
    store.moat = await generateMoat();
    prune();
    store.lastFetch = new Date().toISOString();
    saveStore(store);
    console.log(`[FETCH] 完成: CEO ${ceo.length}, 财报 ${fin.length}, 分析师 ${ana.length}, 新闻 ${news.length}`);
    return true;
  } catch (e) {
    console.error('[FETCH] 失败', e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════
// 每日邮件简报
// ═══════════════════════════════════════════════════════
function buildDigestHTML() {
  prune();
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const ceo  = store.ceo.slice(0, 5);
  const news = store.news.slice(0, 5);
  const fin  = store.financial.slice(0, 3);

  const block = (items, render) => items.length ? items.map(render).join('') : '<p style="color:#888;font-size:13px;">暂无新动态</p>';

  return `
  <div style="font-family:-apple-system,Arial,sans-serif;max-width:640px;margin:0 auto;background:#0F1722;color:#E6EDF5;padding:0;">
    <div style="background:#E8453C;padding:20px 28px;">
      <div style="font-size:18px;font-weight:700;color:#fff;">📊 数字能源竞情日报</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.85);margin-top:4px;">北京时间 ${today} 07:00 · 华为财经管理部</div>
    </div>
    <div style="padding:24px 28px;">
      <div style="font-size:14px;font-weight:700;color:#3B9EFF;margin-bottom:10px;border-bottom:1px solid #233;padding-bottom:6px;">🎤 高管发言</div>
      ${block(ceo, c => `
        <div style="margin-bottom:14px;">
          <div style="font-size:14px;font-weight:600;color:#E6EDF5;">${c.comp} · ${c.person||''}</div>
          <div style="font-size:13px;color:#aab;margin:4px 0;">${c.title}</div>
          <div style="font-size:12px;color:#889;line-height:1.6;">${c.summary||''}</div>
          ${(c.sources||[]).map(s=>`<a href="${s.url}" style="font-size:11px;color:#3B9EFF;text-decoration:none;margin-right:10px;">↗ ${s.label}</a>`).join('')}
        </div>`)}

      <div style="font-size:14px;font-weight:700;color:#2ECC71;margin:20px 0 10px;border-bottom:1px solid #233;padding-bottom:6px;">🔥 热点解读</div>
      ${block(news, n => `
        <div style="margin-bottom:14px;">
          <div style="font-size:14px;font-weight:600;color:#E6EDF5;">${n.comp}</div>
          <div style="font-size:13px;color:#aab;margin:4px 0;">${n.title}</div>
          <div style="background:rgba(232,69,60,0.12);border-left:3px solid #E8453C;padding:8px 12px;border-radius:0 4px 4px 0;font-size:12px;color:#E6EDF5;line-height:1.6;margin-top:6px;">
            <strong style="color:#FF6B5E;">💡 对华为启示：</strong>${n.impact||''}
          </div>
          ${(n.sources||[]).map(s=>`<a href="${s.url}" style="font-size:11px;color:#3B9EFF;text-decoration:none;margin-right:10px;">↗ ${s.label}</a>`).join('')}
        </div>`)}

      ${fin.length ? `
      <div style="font-size:14px;font-weight:700;color:#E0A82E;margin:20px 0 10px;border-bottom:1px solid #233;padding-bottom:6px;">💰 财报披露</div>
      ${fin.map(f=>`<div style="margin-bottom:10px;font-size:13px;"><strong style="color:#E6EDF5;">${f.comp}</strong> <span style="color:#888;">${f.period}</span>：营收 ${f.rev} (${f.yoy})｜${f.summary||''}</div>`).join('')}
      ` : ''}
    </div>
    <div style="padding:16px 28px;border-top:1px solid #233;font-size:11px;color:#556;">
      仅含 7 天内最新信息 · 来源可审计 · 华为财经管理部竞情平台<br>
      如需退订，请回复本邮件。
    </div>
  </div>`;
}

async function sendDailyDigest() {
  if (!resend) { console.log('[EMAIL] Resend 未配置，跳过'); return; }
  if (store.subscribers.length === 0) { console.log('[EMAIL] 无订阅者'); return; }
  const html = buildDigestHTML();
  const subject = `数字能源竞情日报 · ${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  let sent = 0;
  for (const to of store.subscribers) {
    try {
      await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
      sent++;
    } catch (e) { console.error('[EMAIL] 发送失败', to, e.message); }
  }
  console.log(`[EMAIL] 已发送 ${sent}/${store.subscribers.length}`);
}

// ═══════════════════════════════════════════════════════
// 定时任务（Railway 时区为 UTC，北京时间 = UTC+8）
// 北京时间 07:00 = UTC 23:00（前一天）
// 北京时间周一 07:00 抓取 = UTC 周日 23:00
// ═══════════════════════════════════════════════════════
// 每天 UTC 23:00（北京时间次日07:00）发送邮件
cron.schedule('0 23 * * *', async () => {
  console.log('[CRON] 每日邮件触发');
  await sendDailyDigest();
});

// 每周一北京时间07:00抓取 = UTC 周日23:00
cron.schedule('0 23 * * 0', async () => {
  console.log('[CRON] 每周抓取触发');
  await runFullFetch();
});

// 额外：每天北京时间06:00（UTC22:00）做一次增量抓取，保证日报有新内容
cron.schedule('0 22 * * *', async () => {
  console.log('[CRON] 每日增量抓取');
  await runFullFetch();
});

// ═══════════════════════════════════════════════════════
// API 路由
// ═══════════════════════════════════════════════════════
app.get('/api/data', (req, res) => {
  prune();
  res.json({
    competitors: store.competitors,
    ceo: store.ceo,
    financial: store.financial,
    analyst: store.analyst,
    news: store.news,
    moat: store.moat,
    subscriberCount: store.subscribers.length,
    lastFetch: store.lastFetch
  });
});

app.post('/api/subscribe', (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ ok: false, msg: '邮箱无效' });
  if (!store.subscribers.includes(email)) {
    store.subscribers.push(email);
    saveStore(store);
  }
  res.json({ ok: true, count: store.subscribers.length });
});

app.post('/api/unsubscribe', (req, res) => {
  const { email } = req.body;
  store.subscribers = store.subscribers.filter(e => e !== email);
  saveStore(store);
  res.json({ ok: true, count: store.subscribers.length });
});

app.post('/api/competitors/add', (req, res) => {
  const { name } = req.body;
  if (name && !store.competitors.includes(name)) {
    store.competitors.push(name);
    saveStore(store);
  }
  res.json({ ok: true, competitors: store.competitors });
});

app.post('/api/competitors/remove', (req, res) => {
  const { name } = req.body;
  if (name !== '华为数字能源') {
    store.competitors = store.competitors.filter(c => c !== name);
    saveStore(store);
  }
  res.json({ ok: true, competitors: store.competitors });
});

// 手动触发抓取（需要 token）
app.post('/api/fetch', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(403).json({ ok: false, msg: '无权限' });
  res.json({ ok: true, msg: '抓取已启动，约1-2分钟后完成' });
  runFullFetch(); // 异步执行
});

// 手动触发邮件（测试用）
app.post('/api/send-test', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(403).json({ ok: false, msg: '无权限' });
  await sendDailyDigest();
  res.json({ ok: true, msg: '邮件已发送' });
});

app.get('/api/health', (req, res) => res.json({
  ok: true,
  hasAnthropic: !!anthropic,
  hasResend: !!resend,
  subscribers: store.subscribers.length,
  lastFetch: store.lastFetch
}));

app.listen(PORT, () => {
  console.log(`\n🚀 数字能源竞情平台运行中 :${PORT}`);
  console.log(`   Anthropic: ${anthropic ? '✓' : '✗ 未配置'}`);
  console.log(`   Resend: ${resend ? '✓' : '✗ 未配置'}`);
  console.log(`   定时: 每日北京06:00抓取 / 07:00邮件\n`);
});
