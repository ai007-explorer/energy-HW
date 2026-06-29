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
    finData: [],
    inferences: [],     // 推演历史记录
    pendingSignals: [], // 待确认的高影响信号
    lastFetch: null,
    lastFinFetch: null
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
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };
  if (useSearch) {
    params.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }
  const resp = await anthropic.messages.create(params);
  return resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function parseJSON(text) {
  // strip markdown fences
  let clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  // find first [ or {
  const arrIdx = clean.indexOf('[');
  const objIdx = clean.indexOf('{');
  let start = Infinity;
  if (arrIdx >= 0) start = Math.min(start, arrIdx);
  if (objIdx >= 0) start = Math.min(start, objIdx);
  if (start === Infinity) throw new Error('no JSON found');
  clean = clean.slice(start);
  // Try parsing; if it fails due to truncation, try to recover array
  try {
    return JSON.parse(clean);
  } catch (e) {
    // Try to recover a partial array by finding complete objects
    if (clean.startsWith('[')) {
      const items = [];
      let depth = 0, inStr = false, escape = false, objStart = -1;
      for (let i = 0; i < clean.length; i++) {
        const c = clean[i];
        if (escape) { escape = false; continue; }
        if (c === '\\' && inStr) { escape = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') { if (depth === 1) objStart = i; depth++; }
        else if (c === '}') {
          depth--;
          if (depth === 1 && objStart >= 0) {
            try { items.push(JSON.parse(clean.slice(objStart, i + 1))); } catch {}
            objStart = -1;
          }
        } else if (c === '[') depth++;
        else if (c === ']') depth--;
      }
      if (items.length > 0) { console.log(`[parseJSON] 恢复了 ${items.length} 条`); return items; }
    }
    throw e;
  }
}

// ═══════════════════════════════════════════════════════
// 抓取任务：四个模块
// ═══════════════════════════════════════════════════════

// 内置 CEO/高管名单（精准搜索用）
const CEO_MAP = {
  '宁德时代':   [{ name:'曾毓群', title:'董事长', en:'Zeng Yuqun', ticker:'300750' }],
  '阳光电源':   [{ name:'曹仁贤', title:'董事长', en:'Cao Renxian', ticker:'300274' }],
  '德业股份':   [{ name:'张和君', title:'董事长', en:'Zhang Hejun', ticker:'605117' }],
  '锦浪科技':   [{ name:'王一鸣', title:'创始人/总经理', en:'Wang Yiming', ticker:'300763' }],
  '汇川技术':   [{ name:'朱兴明', title:'董事长', en:'Zhu Xingming', ticker:'300124' }],
  '科华数据':   [{ name:'陈成辉', title:'董事长', en:'Chen Chenghui', ticker:'002335' }],
  '科士达':     [{ name:'廖创鑫', title:'董事长', en:'Liao Chuangxin', ticker:'002518' }],
  '盛弘股份':   [{ name:'肖胜文', title:'董事长', en:'Xiao Shengwen', ticker:'300693' }],
  '特斯拉':     [{ name:'Elon Musk', title:'CEO', en:'Elon Musk', ticker:'TSLA' }],
  '特锐德':     [{ name:'于德翔', title:'董事长', en:'Yu Dexiang', ticker:'300001' }],
  '思格新能源': [{ name:'张明', title:'CEO', en:'Zhang Ming SIGENERGY', ticker:'' }],
  '华为数字能源':[{ name:'侯金龙', title:'总裁', en:'Hou Jinlong Huawei Digital Power', ticker:'' }],
  '维谛技术':   [{ name:'Franz Wunschek', title:'CEO Vertiv', en:'Giordano Albertazzi Vertiv CEO', ticker:'VRT' }],
  '伊顿':       [{ name:'Craig Arnold', title:'CEO Eaton', en:'Craig Arnold Eaton CEO', ticker:'ETN' }],
};

async function fetchCEO() {
  const allItems = [];
  // 按人名逐一精准搜索，每批3人，避免混淆
  const entries = Object.entries(CEO_MAP).filter(([comp]) => store.competitors.includes(comp));
  const batchSize = 3;

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const searchTargets = batch.map(([comp, persons]) =>
      persons.map(p => `【${comp}】${p.name}（${p.en}）`).join('、')
    ).join('；');

    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7*864e5).toISOString().slice(0, 10);

    const sys = `你是数字能源行业竞争情报分析师。精准搜索指定人物的公开发言，只收录本人亲口说的话。排除二手报道、分析师解读、他人对其评论。仅回复JSON数组。`;
    const prompt = `精准搜索以下人物在 ${weekAgo} 至 ${today} 期间的公开发言：
${searchTargets}

搜索范围：
- 微博、微信公众号、抖音等社交媒体（本人官方账号）
- 公司官网新闻、投资者关系页面
- 财经媒体采访（第一财经、财新、36氪、彭博、路透）
- 证券交易所业绩说明会记录
- 行业会议、论坛演讲（SNEC、CIBF、ESIE等）
- Twitter/X（英文高管）

每个人物单独搜索，搜索格式："[人名] 发言 OR 采访 OR 演讲 site:weibo.com OR site:36kr.com" 等。

返回JSON数组，每条：
{
  "id": "comp_personname_YYYYMMDD",
  "comp": "公司名",
  "person": "姓名 · 职位",
  "date": "YYYY-MM-DD",
  "title": "发言标题或场合(30字内)",
  "summary": "发言核心内容总结(80字，中文)",
  "quote": "最重要的一句原话（尽量保留原文）",
  "key_topics": ["话题1","话题2"],
  "sources": [{"label":"来源名称","url":"真实链接","official":true或false}]
}

注意：
1. 每条必须有真实来源链接
2. quote 字段必须是本人原话，不能是记者转述
3. 找不到真实发言就返回[]，不要编造`;

    const raw = await askClaude(sys, prompt, true);
    try {
      let items = parseJSON(raw);
      if (!Array.isArray(items)) items = items.results || items.data || [];
      const valid = items.filter(x => x && x.title && x.comp && x.quote);
      allItems.push(...valid);
      console.log(`[CEO] 批次${Math.floor(i/batchSize)+1}: 找到 ${valid.length} 条发言`);
    } catch(e) {
      console.error(`[CEO] 批次${Math.floor(i/batchSize)+1} 解析失败:`, e.message);
    }
  }
  return allItems;
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
  const comps = store.competitors.filter(c => c !== '华为数字能源');
  // 分批处理，每批5家，避免JSON过长被截断
  const batchSize = 5;
  let allItems = [];
  for (let i = 0; i < comps.length; i += batchSize) {
    const batch = comps.slice(i, i + batchSize).join('、');
    const sys = `你是华为数字能源的竞争情报分析师。收集友商过去7天的重大热点新闻，分析每条对华为数字能源经营的启示。仅回复JSON数组，严格控制每条字数。`;
    const prompt = `搜索以下数字能源友商过去7天的重大热点新闻（每家最多2条）：${batch}

返回JSON数组，每条字段严格简短：
{"id":"uid","comp":"公司名","date":"YYYY-MM-DD","title":"标题(30字内)","summary":"摘要(60字内)","impact":"对华为启示(60字内)","sources":[{"label":"来源","url":"链接","official":false}]}

只返回过去7天真实新闻，找不到返回[]。`;
    const raw = await askClaude(sys, prompt, true);
    try {
      let items = parseJSON(raw);
      if (!Array.isArray(items)) items = items.results || items.data || [];
      allItems = allItems.concat(items.filter(x => x && x.title));
    } catch (e) { console.error('fetchNews batch parse', e.message); }
  }
  return allItems;
}

async function generateMoat() {
  const batchSize = 4;
  let allItems = [];
  for (let i = 0; i < store.competitors.length; i += batchSize) {
    const batch = store.competitors.slice(i, i + batchSize);
    const ctx = {
      ceo: store.ceo.filter(c => batch.includes(c.comp)).map(c => `${c.comp}: ${c.summary||c.title}`).slice(0,6),
      fin: store.financial.filter(f => batch.includes(f.comp)).map(f => `${f.comp}: ${f.summary}`).slice(0,4),
      news: store.news.filter(n => batch.includes(n.comp)).map(n => `${n.comp}: ${n.title}`).slice(0,6)
    };
    const sys = `你是战略分析师。基于提供的信息提炼每家公司长期竞争优势，字数严格简短。仅回复JSON数组。`;
    const prompt = `为以下公司提炼长期竞争优势：${batch.join('、')}

参考信息：${JSON.stringify(ctx)}

返回JSON数组，每条（字数严格限制）：
{"comp":"公司名","hw":是否华为数字能源,"advantages":["优势1(20字内)","优势2(20字内)","优势3(20字内)"],"strategy":"维持优势策略(60字内)","sources":[{"label":"来源","url":"https://example.com","official":true}]}`;
    const raw = await askClaude(sys, prompt, false);
    try {
      let items = parseJSON(raw);
      if (!Array.isArray(items)) items = items.results || items.data || [];
      allItems = allItems.concat(items.filter(x => x && x.comp));
    } catch (e) { console.error('genMoat batch parse', e.message); }
  }
  return allItems;
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
    // 扫描高影响信号
    const allNew = [...ceo, ...news];
    if (allNew.length > 0) await scanForSignals(allNew);
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

// ═══════════════════════════════════════════════════════
// 财务数据抓取
// ═══════════════════════════════════════════════════════
async function fetchFinancialData() {
  // 上市公司分批抓取，每批4家
  const listed = ['阳光电源','德业股份','锦浪科技','汇川技术','科华数据','科士达','盛弘股份','宁德时代','特斯拉','特锐德'];
  const batchSize = 4;
  let allData = [];

  for (let i = 0; i < listed.length; i += batchSize) {
    const batch = listed.slice(i, i + batchSize);
    const sys = `你是专业财务分析师。从东方财富、同花顺、巨潮资讯、Yahoo Finance、SEC等公开来源搜索这些公司最新年报财务数据。仅回复JSON数组，字段严格按要求，数值用数字不用字符串。`;
    const prompt = `搜索以下公司最新年度财务数据（优先2025年年报，若未发布则用2024年）：${batch.join('、')}

数据来源优先：东方财富(eastmoney.com)、同花顺(10jqka.com)、巨潮资讯(cninfo.com.cn)、Yahoo Finance、SEC EDGAR

返回JSON数组，每条：
{
  "comp": "公司名",
  "ticker": "股票代码如300274.SZ或TSLA",
  "year": "2025或2024",
  "currency": "CNY或USD",
  "revenue": 营收数值(亿元或亿美元,数字),
  "revenue_yoy": 同比增速如0.18代表18%,
  "gross_profit": 毛利润(亿),
  "gross_margin": 毛利率如0.32代表32%,
  "op_profit": 营业利润(亿),
  "op_margin": 营业利润率,
  "net_profit": 净利润(亿),
  "net_margin": 净利率,
  "revenue_yoy_prev": 上年同比增速(用于对比),
  "segments": [{"name":"业务线名称","revenue":收入,"pct":占比如0.35}],
  "regions": [{"name":"区域","revenue":收入,"pct":占比}],
  "source_url": "数据来源链接",
  "source_name": "来源名称"
}

若某字段无法获取填null。只返回能找到真实数据的公司。`;

    const raw = await askClaude(sys, prompt, true);
    try {
      let items = parseJSON(raw);
      if (!Array.isArray(items)) items = items.data || items.results || [];
      allData = allData.concat(items.filter(x => x && x.comp && x.revenue));
    } catch(e) { console.error('fetchFin batch parse', e.message); }
  }

  // 华为数字能源单独处理（非上市，数据有限）
  try {
    const hwRaw = await askClaude(
      '你是专业财务分析师。搜索华为数字能源的公开财务披露信息。仅回复JSON。',
      `搜索华为数字能源（Huawei Digital Power）最新年度营收和业务数据。
来源：华为年报(huawei.com/annual-report)、新闻披露、分析师报告。
返回单个JSON对象，字段同上，能找到什么填什么，找不到填null。`, true);
    const hw = parseJSON(hwRaw);
    if (hw && (hw.comp || hw.revenue)) {
      if (!hw.comp) hw.comp = '华为数字能源';
      allData.unshift(hw);
    }
  } catch(e) { console.error('fetchFin HW parse', e.message); }

  return allData;
}

// 每周日北京时间06:00更新财务数据（UTC周六22:00）
cron.schedule('0 22 * * 6', async () => {
  console.log('[CRON] 财务数据更新触发');
  try {
    const data = await fetchFinancialData();
    if (data.length > 0) {
      store.finData = data;
      store.lastFinFetch = new Date().toISOString();
      saveStore(store);
      console.log(`[FIN] 更新完成: ${data.length} 家公司`);
    }
  } catch(e) { console.error('[FIN] 更新失败', e); }
});

// ─── 财务数据 API ───
app.get('/api/financial-data', (req, res) => {
  res.json({
    data: store.finData || [],
    lastFetch: store.lastFinFetch
  });
});

app.post('/api/fetch-financial', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(403).json({ ok: false, msg: '无权限' });
  res.json({ ok: true, msg: '财务数据抓取已启动，约3-5分钟后完成' });
  fetchFinancialData().then(data => {
    if (data.length > 0) {
      store.finData = data;
      store.lastFinFetch = new Date().toISOString();
      saveStore(store);
      console.log(`[FIN] 手动更新完成: ${data.length} 家`);
    }
  }).catch(e => console.error('[FIN] 手动更新失败', e));
});

// ═══════════════════════════════════════════════════════
// 推演引擎
// ═══════════════════════════════════════════════════════

// 华为数字能源基准财务假设（内部规划参考值，可调整）
const HW_BASE = {
  revenue: { solar: 450, storage: 380, datacenter: 270, total: 1100 }, // 亿元
  margin:  { solar: 0.32, storage: 0.28, datacenter: 0.35 },
  netMargin: 0.18
};

// 每次完整抓取后，自动扫描高影响信号
async function scanForSignals(newItems) {
  if (!newItems || newItems.length === 0) return;
  const sys = `你是华为数字能源的战略分析师。判断每条竞情信息是否会对华为数字能源的光伏、储能、数据中心能源三条业务线产生重大影响。仅回复JSON数组。`;
  const prompt = `分析以下竞情信息，识别对华为数字能源有重大财务影响的事件（影响评分>=7分才标记）：

${newItems.map(i=>`- [${i.comp||''}] ${i.title||i.summary||''}`).join('\n')}

返回JSON数组，只包含高影响事件：
[{
  "source_title": "原始信息标题",
  "source_comp": "来源公司",
  "impact_score": 1-10分,
  "affected_segments": ["solar"|"storage"|"datacenter"],
  "impact_direction": "positive"|"negative"|"mixed",
  "impact_summary": "一句话说明影响路径(40字内)",
  "trigger_inference": true
}]

若无高影响事件返回[]。`;

  try {
    const raw = await askClaude(sys, prompt, false);
    const signals = parseJSON(raw);
    if (Array.isArray(signals) && signals.length > 0) {
      store.pendingSignals = [
        ...signals.map(s => ({ ...s, id: Date.now() + Math.random(), createdAt: new Date().toISOString(), status: 'pending' })),
        ...(store.pendingSignals || [])
      ].slice(0, 20);
      saveStore(store);
      console.log(`[SIGNAL] 识别到 ${signals.length} 个高影响信号`);
    }
  } catch(e) { console.error('[SIGNAL] 扫描失败', e.message); }
}

// 执行推演：生成三种情景
async function runInference(signal, triggeredBy = 'manual') {
  const sys = `你是华为数字能源的首席财务规划分析师，擅长情景推演和财务建模。基于竞争情报事件，推演对华为数字能源三条业务线的财务影响。严格按JSON格式回复，数值要有财务逻辑支撑。`;

  const baseInfo = `华为数字能源基准假设（内部规划参考）：
- 光伏业务（solar）：营收 ${HW_BASE.revenue.solar}亿，毛利率 ${(HW_BASE.margin.solar*100).toFixed(0)}%
- 储能业务（storage）：营收 ${HW_BASE.revenue.storage}亿，毛利率 ${(HW_BASE.margin.storage*100).toFixed(0)}%
- 数据中心能源（datacenter）：营收 ${HW_BASE.revenue.datacenter}亿，毛利率 ${(HW_BASE.margin.datacenter*100).toFixed(0)}%
- 整体净利率：${(HW_BASE.netMargin*100).toFixed(0)}%`;

  const prompt = `触发事件：【${signal.source_comp}】${signal.source_title}
影响方向：${signal.impact_direction}，主要影响业务线：${(signal.affected_segments||[]).join('、')}
影响路径：${signal.impact_summary}

${baseInfo}

历史推演参考：${store.inferences.slice(0,3).map(i=>`${i.event_title}→${i.scenarios?.base?.revenue_delta_pct}%营收影响`).join('; ')||'暂无'}

请生成三种情景的财务推演，返回JSON：
{
  "event_title": "事件标题(20字内)",
  "event_summary": "事件背景和影响路径分析(100字)",
  "causal_chain": ["因果链第1步","第2步","第3步","第4步"],
  "scenarios": {
    "optimistic": {
      "label": "乐观",
      "assumption": "关键假设(30字)",
      "probability": 0.25,
      "segments": {
        "solar":       {"revenue_delta": 数值亿元正负, "revenue_delta_pct": 百分比如0.05, "margin_delta": 毛利率变化如-0.01},
        "storage":     {"revenue_delta": 数值, "revenue_delta_pct": 百分比, "margin_delta": 变化},
        "datacenter":  {"revenue_delta": 数值, "revenue_delta_pct": 百分比, "margin_delta": 变化}
      },
      "total_revenue_delta": 总营收变化亿元,
      "total_revenue_delta_pct": 总营收变化百分比,
      "net_profit_delta": 净利润变化亿元,
      "key_risk": "主要风险(20字)",
      "strategic_response": "华为应对策略(40字)"
    },
    "base": { /* 同上结构，基准情景概率0.5 */ },
    "pessimistic": { /* 同上结构，悲观情景概率0.25 */ }
  },
  "weighted_revenue_impact": 加权平均营收影响亿元,
  "weighted_profit_impact": 加权平均净利润影响亿元,
  "time_horizon": "影响时间窗口如'6-12个月'",
  "confidence": "high|medium|low",
  "recommendation": "给CFO的一句话建议(50字内)"
}`;

  const raw = await askClaude(sys, prompt, false);
  const result = parseJSON(raw);
  result.id = Date.now().toString();
  result.triggered_by = triggeredBy;
  result.signal_id = signal.id;
  result.createdAt = new Date().toISOString();
  result.source_comp = signal.source_comp;
  return result;
}

// ─── 推演 API 路由 ───

// 获取待确认信号列表
app.get('/api/signals', (req, res) => {
  res.json({ signals: store.pendingSignals || [] });
});

// 手动添加自定义信号
app.post('/api/signals/add', async (req, res) => {
  const { title, comp, segments, direction, summary } = req.body;
  if (!title) return res.status(400).json({ ok: false, msg: '缺少标题' });
  const signal = {
    id: Date.now().toString(),
    source_title: title,
    source_comp: comp || '自定义',
    affected_segments: segments || ['solar','storage','datacenter'],
    impact_direction: direction || 'mixed',
    impact_summary: summary || title,
    impact_score: 8,
    trigger_inference: true,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  store.pendingSignals = [signal, ...(store.pendingSignals||[])].slice(0, 20);
  saveStore(store);
  res.json({ ok: true, signal });
});

// 确认信号并执行推演
app.post('/api/inference/run', async (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(403).json({ ok: false, msg: '无权限' });
  const { signal_id, custom_signal } = req.body;

  let signal = custom_signal;
  if (!signal && signal_id) {
    signal = (store.pendingSignals || []).find(s => s.id == signal_id);
  }
  if (!signal) return res.status(404).json({ ok: false, msg: '信号不存在' });

  res.json({ ok: true, msg: '推演已启动，约1-2分钟后完成' });

  try {
    const result = await runInference(signal, 'manual');
    store.inferences = [result, ...(store.inferences||[])].slice(0, 50);
    // 标记信号已处理
    store.pendingSignals = (store.pendingSignals||[]).map(s =>
      s.id == signal_id ? { ...s, status: 'processed', inference_id: result.id } : s
    );
    saveStore(store);
    console.log(`[INFERENCE] 推演完成: ${result.event_title}`);
  } catch(e) {
    console.error('[INFERENCE] 推演失败', e.message);
  }
});

// 获取推演历史
app.get('/api/inferences', (req, res) => {
  res.json({ inferences: store.inferences || [], total: (store.inferences||[]).length });
});

// 获取单条推演详情
app.get('/api/inferences/:id', (req, res) => {
  const item = (store.inferences||[]).find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, msg: '不存在' });
  res.json(item);
});

// 删除推演记录
app.delete('/api/inferences/:id', (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(403).json({ ok: false, msg: '无权限' });
  store.inferences = (store.inferences||[]).filter(i => i.id !== req.params.id);
  saveStore(store);
  res.json({ ok: true });
});

// 获取基准假设（可调整）
app.get('/api/base-assumption', (req, res) => {
  res.json(store.baseAssumption || HW_BASE);
});

app.post('/api/base-assumption', (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(403).json({ ok: false, msg: '无权限' });
  store.baseAssumption = { ...HW_BASE, ...req.body };
  saveStore(store);
  res.json({ ok: true, data: store.baseAssumption });
});

// 同步全量数据接口（含信号和推演）
const origDataHandler = app._router.stack.find(r => r.route?.path === '/api/data');
app.get('/api/data-full', (req, res) => {
  res.json({
    competitors: store.competitors,
    ceo: store.ceo,
    financial: store.financial,
    analyst: store.analyst,
    news: store.news,
    moat: store.moat,
    finData: store.finData || [],
    pendingSignals: (store.pendingSignals||[]).filter(s=>s.status==='pending'),
    inferences: (store.inferences||[]).slice(0,10),
    subscriberCount: store.subscribers.length,
    lastFetch: store.lastFetch
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 数字能源竞情平台运行中 :${PORT}`);
  console.log(`   Anthropic: ${anthropic ? '✓' : '✗ 未配置'}`);
  console.log(`   Resend: ${resend ? '✓' : '✗ 未配置'}`);
  console.log(`   定时: 每日北京06:00抓取 / 07:00邮件\n`);
});
