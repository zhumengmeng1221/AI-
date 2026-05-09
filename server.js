/**
 * AIHub 后端代理服务器
 * 
 * 功能：
 *   1. 代理所有 RunningHub API 请求，API Key 存在服务端环境变量
 *   2. 静态文件托管（HTML/JS/CSS）
 *   3. Key 可通过管理接口设置，无需重启
 * 
 * 启动：
 *   RUNNINGHUB_KEY=你的key node server.js
 *   或启动后通过 /admin/setkey 接口设置
 * 
 * 端口：默认 8080
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;
const RH_BASE = 'https://www.runninghub.cn';

// ── API Key 管理 ──
// 优先级：环境变量 > keyfile
let apiKey = process.env.RUNNINGHUB_KEY || '';
const KEY_FILE = path.join(__dirname, '.runninghub_key');

function loadKeyFromFile() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
    }
  } catch (_) {}
}

function saveKeyToFile(key) {
  fs.writeFileSync(KEY_FILE, key, 'utf8');
}

// 启动时尝试从文件加载
if (!apiKey) loadKeyFromFile();

function getKey() {
  return apiKey;
}

function setKey(key) {
  apiKey = key.trim();
  saveKeyToFile(apiKey);
}

// ── MIME 类型 ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
};

// ── 静态文件服务 ──
function serveStatic(req, res) {
  let pathname = url.parse(req.url).pathname;
  if (pathname === '/') pathname = '/index.html';
  
  const filePath = path.join(__dirname, pathname);
  const ext = path.extname(filePath).toLowerCase();
  
  // 安全检查：防止路径穿越
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── 代理请求到 RunningHub ──
function proxyToRH(targetPath, method, body, res) {
  const key = getKey();
  if (!key) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'API Key 未设置，请通过 /admin/setkey 配置' }));
    return;
  }

  const options = {
    hostname: 'www.runninghub.cn',
    port: 443,
    path: targetPath,
    method: method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => res.end(data));
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: '代理请求失败: ' + err.message }));
  });

  if (body) proxyReq.write(JSON.stringify(body));
  proxyReq.end();
}

// ── 文件上传代理 ──
function proxyUpload(req, res) {
  const key = getKey();
  if (!key) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'API Key 未设置' }));
    return;
  }

  // 收集请求体（multipart）
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    
    // 提取 boundary
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid multipart request' }));
      return;
    }

    // 注入 apiKey 到 multipart body
    // RunningHub V1 upload 需要 apiKey 字段
    const boundary = boundaryMatch[1];
    const keyPart = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="apiKey"\r\n\r\n${key}\r\n`
    );
    const newBody = Buffer.concat([keyPart, rawBody]);

    const options = {
      hostname: 'www.runninghub.cn',
      port: 443,
      path: '/task/openapi/upload',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': contentType,
        'Content-Length': newBody.length,
      }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => res.end(data));
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502);
      res.end(JSON.stringify({ error: '上传代理失败: ' + err.message }));
    });

    proxyReq.write(newBody);
    proxyReq.end();
  });
}

// ── 管理接口 ──
function handleAdmin(req, res, pathname) {
  // GET /admin/status - 查看状态
  if (pathname === '/admin/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      keySet: !!getKey(),
      keyPrefix: getKey() ? getKey().substring(0, 6) + '...' : '',
      proxy: 'running'
    }));
    return;
  }

  // POST /admin/setkey - 设置 Key
  if (pathname === '/admin/setkey' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.key) throw new Error('缺少 key 字段');
        setKey(data.key);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Key 已保存' }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Unknown admin endpoint' }));
}

// ── 读取 JSON body ──
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (_) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── 路由 ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── API 代理路由 ──

  // V1: 创建任务
  if (pathname === '/api/create' && req.method === 'POST') {
    const body = await readJsonBody(req);
    body.apiKey = getKey();  // 注入服务端 Key
    proxyToRH('/task/openapi/create', 'POST', body, res);
    return;
  }

  // V1: 查询输出
  if (pathname === '/api/outputs' && req.method === 'POST') {
    const body = await readJsonBody(req);
    body.apiKey = getKey();
    proxyToRH('/task/openapi/outputs', 'POST', body, res);
    return;
  }

  // V1: 文件上传
  if (pathname === '/api/upload' && req.method === 'POST') {
    proxyUpload(req, res);
    return;
  }

  // V2: 运行工作流
  if (pathname.startsWith('/api/v2/run/workflow/') && req.method === 'POST') {
    const workflowId = pathname.replace('/api/v2/run/workflow/', '');
    const body = await readJsonBody(req);
    proxyToRH(`/openapi/v2/run/workflow/${workflowId}`, 'POST', body, res);
    return;
  }

  // V2: 查询任务
  if (pathname === '/api/v2/query' && req.method === 'POST') {
    const body = await readJsonBody(req);
    proxyToRH('/openapi/v2/query', 'POST', body, res);
    return;
  }

  // ── 管理接口 ──
  if (pathname.startsWith('/admin/')) {
    handleAdmin(req, res, pathname);
    return;
  }

  // ── 静态文件 ──
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`
  ┌──────────────────────────────────────┐
  │  AIHub 代理服务器已启动               │
  │  地址: http://localhost:${PORT}         │
  │  Key 状态: ${getKey() ? '✅ 已配置' : '❌ 未配置 (访问 /admin/setkey 设置)'}  │
  └──────────────────────────────────────┘
  `);
});
