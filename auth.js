// auth.js —— 数字能源竞情平台 · 简单密码门
// 共享密码 · 服务端校验 · HMAC 签名 Cookie(看源码无法绕过) · 无第三方依赖
//
// 用法:在 Express 主文件创建 app 之后、static 与业务路由之前加一行:
//     const app = express();
//     require('./auth')(app);        // ←← 就这一行
//     // ...(你原有的 express.static / 路由)
//
// 密码与密钥建议用 Railway 环境变量配置(见文件底部说明)。

const express = require('express');
const crypto  = require('crypto');

const PASSWORD = process.env.SITE_PASSWORD || 'caiguiup';                       // 访问密码
const SECRET   = process.env.AUTH_SECRET   || 'de-platform-please-change-3f9a'; // Cookie 签名密钥
const COOKIE   = 'de_auth';
const MAX_AGE  = 7 * 24 * 60 * 60 * 1000;   // 登录有效期:7 天

const sign  = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const issue = () => { const exp = Date.now() + MAX_AGE; return exp + '.' + sign(String(exp)); };
const check = (t) => {
  if (!t) return false;
  const i = t.lastIndexOf('.'); if (i < 0) return false;
  const v = t.slice(0, i), sig = t.slice(i + 1);
  try { if (sign(v) !== sig) return false; } catch (e) { return false; }
  return Date.now() < Number(v);
};
function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return decodeURIComponent(part.slice(eq + 1));
  }
  return '';
}

const page = (msg) => `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 数字能源竞情平台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
background:#0E1116;background:linear-gradient(155deg,#15181F 0%,#0E1116 60%,#1A0608 100%)}
.card{width:340px;background:#fff;border-radius:16px;padding:38px 32px 30px;text-align:center;
box-shadow:0 24px 60px rgba(0,0,0,.45)}
.logo{width:54px;height:54px;border-radius:13px;background:#C7000B;color:#fff;font-weight:800;font-size:28px;
display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
h1{font-size:18px;font-weight:800;color:#16191D;letter-spacing:-.2px}
.sub{font-size:12px;color:#8A9099;margin-top:5px;margin-bottom:22px}
input{width:100%;height:46px;border:1.5px solid #E2E5E9;border-radius:10px;padding:0 14px;font-size:15px;
outline:none;transition:.15s;font-family:inherit}
input:focus{border-color:#C7000B;box-shadow:0 0 0 3px rgba(199,0,11,.12)}
button{width:100%;height:46px;margin-top:14px;border:0;border-radius:10px;background:#C7000B;color:#fff;
font-size:15px;font-weight:700;cursor:pointer;transition:.15s;font-family:inherit}
button:hover{background:#A80009}
.err{background:#FCEAEA;border:1px solid #F3CFCF;color:#9B1B1B;font-size:12.5px;
padding:9px;border-radius:8px;margin-bottom:14px}
.tip{font-size:11px;color:#A8AEB6;margin-top:18px}
</style></head><body>
<form class="card" method="POST" action="/login">
  <div class="logo">华</div>
  <h1>数字能源竞情平台</h1>
  <div class="sub">财经管理部 · 内部访问</div>
  ${msg ? `<div class="err">${msg}</div>` : ''}
  <input type="password" name="password" placeholder="请输入访问密码" autofocus required autocomplete="current-password">
  <button type="submit">进入平台</button>
  <div class="tip">仅限授权人员 · 登录状态保持 7 天</div>
</form></body></html>`;

module.exports = function attachAuth(app) {
  // 仅为登录表单解析 body(不影响你现有的 body 解析)
  app.use('/login', express.urlencoded({ extended: false }));

  // 提交密码
  app.post('/login', (req, res) => {
    const ok = (req.body && req.body.password) === PASSWORD;
    if (!ok) return res.status(401).send(page('密码不正确,请重试'));
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? ' Secure;' : '';
    res.setHeader('Set-Cookie',
      `${COOKIE}=${encodeURIComponent(issue())}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${MAX_AGE / 1000}`);
    res.redirect('/');
  });

  // 退出
  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.redirect('/login');
  });

  // 全站门禁:已登录放行,否则一律显示登录页
  app.use((req, res, next) => {
    if (check(readCookie(req))) return next();
    res.status(req.path === '/login' ? 200 : 401).send(page(''));
  });
};

// ─────────────────────────────────────────────────────────────
// Railway 环境变量(推荐,避免把密码写进代码仓库):
//   SITE_PASSWORD = caiguiup            访问密码(不设则用默认 caiguiup)
//   AUTH_SECRET   = <一串随机字符>       Cookie 签名密钥(设了重启/重部署也不掉登录)
// 退出登录:访问  /logout
// ─────────────────────────────────────────────────────────────
