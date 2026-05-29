# 数字能源竞情平台 · 部署指南

这份指南手把手教你把平台部署到 Railway，实现：
- 每天北京时间 **06:00 自动抓取**最新竞情
- 每天 **07:00 自动发送邮件**给所有订阅者
- 网页 24 小时在线，无需保持电脑开机

预计耗时 **20 分钟**。跟着每一步做即可，不需要懂代码。

---

## 准备工作：注册三个账号

提前注册好，后面会用到：

1. **GitHub** → https://github.com （存放代码）
2. **Railway** → https://railway.app （运行服务器，用 GitHub 登录即可）
3. **Resend** → https://resend.com （发邮件，用 GitHub 或邮箱注册）

Anthropic API Key 你已经有了。

---

## 第一步：把代码上传到 GitHub

### 1.1 新建仓库
1. 登录 GitHub，点右上角 **+** → **New repository**
2. Repository name 填：`energy-intel`
3. 选 **Private**（私有，competition情报建议保密）
4. 点 **Create repository**

### 1.2 上传文件
1. 在新仓库页面，点 **uploading an existing file**
2. 把我给你的**所有文件和文件夹**拖进去：
   - `server.js`
   - `package.json`
   - `railway.json`
   - `.gitignore`
   - `.env.example`
   - `public/` 文件夹（里面有 `index.html`）
3. 拖完后，页面底部点绿色 **Commit changes**

> 注意：`public` 是一个文件夹，里面的 `index.html` 要保持在文件夹内。如果拖拽时文件夹结构丢失，可以先上传 `server.js` 等根目录文件，再单独进入创建 `public` 文件夹上传 `index.html`。

---

## 第二步：在 Resend 获取邮件 API Key

1. 登录 https://resend.com
2. 左侧点 **API Keys** → **Create API Key**
3. 名字随便填，权限选 **Full access**，点创建
4. **复制**生成的 Key（格式 `re_xxxxxxxx`），先存到记事本

> 免费版可直接用 `onboarding@resend.dev` 作为发件地址，每天100封、每月3000封，完全够用。
> 如果想用自己的域名发件（更专业），可以在 Resend 的 Domains 里验证域名，这步可选。

---

## 第三步：部署到 Railway

### 3.1 创建项目
1. 登录 https://railway.app（建议用 GitHub 账号登录）
2. 点 **New Project** → **Deploy from GitHub repo**
3. 授权 Railway 访问你的 GitHub，选择 `energy-intel` 仓库
4. Railway 会自动开始部署

### 3.2 配置环境变量
1. 部署开始后，点进你的服务 → 上方点 **Variables** 标签
2. 点 **New Variable**，逐个添加以下变量：

| 变量名 | 值 |
|--------|-----|
| `ANTHROPIC_API_KEY` | 你的 sk-ant-api03-... |
| `RESEND_API_KEY` | 你的 re_... |
| `FROM_EMAIL` | `onboarding@resend.dev` |
| `ADMIN_TOKEN` | 自己设一个密码，如 `huawei2026` |
| `DATA_DIR` | `/data` |

每加一个点保存，全部加完 Railway 会自动重新部署。

### 3.3 添加持久存储（保存订阅者和数据）
1. 在项目里点 **New** → **Volume**
2. Mount path 填：`/data`
3. 关联到你的服务，保存

> 这一步保证服务器重启后订阅者列表和已抓取的数据不会丢失。

### 3.4 生成公开网址
1. 点服务 → **Settings** → 找到 **Networking** / **Public Networking**
2. 点 **Generate Domain**
3. 得到一个网址，如 `https://energy-intel-production.up.railway.app`

这就是你的平台网址，发给同事就能访问。

---

## 第四步：首次抓取（让平台有数据）

刚部署完数据是空的，需要触发第一次抓取。两种方式：

### 方式 A：用浏览器开发者工具（推荐）
1. 打开你的 Railway 网址
2. 按 F12 → Console，输入（把 `你的TOKEN` 换成你设的 ADMIN_TOKEN）：
```javascript
fetch('/api/fetch',{method:'POST',headers:{'x-admin-token':'你的TOKEN'}}).then(r=>r.json()).then(console.log)
```
3. 看到 `{ok:true}` 说明抓取已启动，等 1-2 分钟后刷新页面就有数据了

### 方式 B：等待自动抓取
什么都不做，等到第二天北京时间早上 06:00，系统会自动抓取。

---

## 第五步：测试邮件

确认抓取有数据后，测试邮件发送：
1. 先在网页「邮件订阅」页面用你自己的邮箱订阅
2. F12 → Console 输入：
```javascript
fetch('/api/send-test',{method:'POST',headers:{'x-admin-token':'你的TOKEN'}}).then(r=>r.json()).then(console.log)
```
3. 检查邮箱（含垃圾箱）是否收到日报

---

## 完成！日常运行说明

| 时间（北京） | 自动任务 |
|------|------|
| 每天 06:00 | 抓取最新竞情 |
| 每天 07:00 | 发送邮件给所有订阅者 |
| 每周日 23:00(UTC) | 深度周度抓取 |

- **添加友商**：网页左侧输入框添加，下次抓取生效
- **订阅邮件**：把网址发给同事，他们自己在网页订阅
- **查看健康状态**：访问 `你的网址/api/health`

---

## 费用说明

| 服务 | 费用 |
|------|------|
| Railway | 每月 $5 免费额度，本项目用量很小，基本免费 |
| Resend | 每月 3000 封免费 |
| Anthropic API | 按调用付费，每天抓取约 $0.1-0.3，每月约 $5-10 |

---

## 常见问题

**Q: 网页打开是空的，没数据**
A: 还没抓取。执行第四步的首次抓取。

**Q: 抓取失败**
A: 检查 Railway 的 Variables 里 `ANTHROPIC_API_KEY` 是否填对。在 Railway 服务的 **Deployments → 日志** 里能看到具体报错。

**Q: 邮件没收到**
A: 先查垃圾箱。确认 `RESEND_API_KEY` 已配置，且已经有订阅者。

**Q: 想改抓取/发邮件的时间**
A: 告诉我你想改成几点，我帮你改 server.js 里的 cron 时间。

**Q: 部署遇到任何报错**
A: 把 Railway 的部署日志截图发给我。
