// projection-route.js —— GET /api/projection
// 用法(在 Express 主文件,创建 app 之后):
//     require('./projection-route')(app);
// 默认读取同目录下的 projection.json(由 gen_projection.py 生成)。
const fs   = require('fs');
const path = require('path');

module.exports = function (app, opts = {}) {
  const FILE = opts.file || path.join(__dirname, 'projection.json');
  app.get('/api/projection', (req, res) => {
    fs.readFile(FILE, 'utf8', (err, data) => {
      if (err) return res.status(500).json({ error: 'projection.json 未找到,请先运行 gen_projection.py' });
      res.set('Cache-Control', 'no-store');          // 改了 json 立即生效
      res.type('application/json').send(data);
    });
  });
};
