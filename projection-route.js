// projection-route.js (ESM) —— GET /api/projection
// 用法(server.js 用 import):
//     import attachProjection from './projection-route.js';
//     attachProjection(app);
// 默认读取项目根目录的 projection.json(由 gen_projection.py 生成)。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default function attachProjection(app, opts = {}) {
  const FILE = opts.file || path.join(__dirname, 'projection.json');
  app.get('/api/projection', (req, res) => {
    fs.readFile(FILE, 'utf8', (err, data) => {
      if (err) return res.status(500).json({ error: 'projection.json 未找到,请先运行 gen_projection.py' });
      res.set('Cache-Control', 'no-store');          // 改了 json 立即生效
      res.type('application/json').send(data);
    });
  });
}
