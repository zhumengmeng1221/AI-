/**
 * AIHub 后端代理服务器 v2
 *
 * 核心功能：
 *   1. 工作流映射层 — 前端只传 type + 用户输入，后端自动映射 workflowId/nodeId
 *   2. 统一任务系统 — 所有工作流共用 Task 模型，统一创建/查询/列表接口
 *   3. API Key 安全 — 全部存在服务端，前端不可见
 *   4. 微信扫码登录 — OAuth2.0 网页授权
 *   5. 静态文件托管
 *
 * 启动：
 *   RUNNINGHUB_KEY=你的key node server.js
 *   或启动后通过 /admin/setkey 接口设置
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const RH_BASE = 'https://www.runninghub.cn';

// ── API Key 管理 ──
let apiKey = process.env.RUNNINGHUB_KEY || '397d32954e194d75893a011dc0dcaf36';
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

if (!apiKey) loadKeyFromFile();

function getKey() { return apiKey; }
function setKey(key) { apiKey = key.trim(); saveKeyToFile(apiKey); }

// ── 微信 OAuth 配置 ──
// 正式环境替换为真实 AppID/AppSecret，本地开发先用占位值
const WECHAT_CONFIG = {
  appId: process.env.WECHAT_APPID || 'wx_test_appid',
  appSecret: process.env.WECHAT_APPSECRET || 'wx_test_appsecret',
  // 回调地址，部署时改为实际域名
  redirectUri: process.env.WECHAT_REDIRECT_URI || 'http://localhost:8080/api/auth/wechat/callback',
  // 微信开放平台扫码登录
  authUrl: 'https://open.weixin.qq.com/connect/qrconnect',
  tokenUrl: 'https://api.weixin.qq.com/sns/oauth2/access_token',
  userinfoUrl: 'https://api.weixin.qq.com/sns/userinfo',
};

// ── 用户系统（内存存储，后续可换数据库）──
const users = new Map();       // openid -> user 对象
const sessions = new Map();    // sessionId -> { openid, createdAt }
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 天

function findOrCreateUser(openid, userInfo) {
  if (users.has(openid)) {
    // 更新昵称头像
    const user = users.get(openid);
    if (userInfo.nickname) user.nickname = userInfo.nickname;
    if (userInfo.headimgurl) user.avatar = userInfo.headimgurl;
    user.lastLoginAt = new Date().toISOString();
    return user;
  }
  const user = {
    id: crypto.randomUUID(),
    openid,
    nickname: userInfo.nickname || '微信用户',
    avatar: userInfo.headimgurl || '',
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString()
  };
  users.set(openid, user);
  return user;
}

function createSession(openid) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, { openid, createdAt: Date.now() });
  return sessionId;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function getUserFromRequest(req) {
  // 从 cookie 中取 sessionId
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/aihub_session=([^;]+)/);
  if (!match) return null;
  const session = getSession(match[1]);
  if (!session) return null;
  return users.get(session.openid) || null;
}

// 微信 API 请求封装
function wechatRequest(targetUrl) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 持久化用户数据到文件 ──
const USER_FILE = path.join(__dirname, '.aihub_users.json');
const SESSION_FILE = path.join(__dirname, '.aihub_sessions.json');

function loadUserData() {
  try {
    if (fs.existsSync(USER_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
      if (data.users) data.users.forEach(u => users.set(u.openid, u));
    }
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (data.sessions) {
        for (const [k, v] of Object.entries(data.sessions)) sessions.set(k, v);
      }
    }
  } catch (_) {}
}

function saveUserData() {
  try {
    fs.writeFileSync(USER_FILE, JSON.stringify({ users: Array.from(users.values()) }), 'utf8');
    const sessionsObj = {};
    sessions.forEach((v, k) => { sessionsObj[k] = v; });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessions: sessionsObj }), 'utf8');
  } catch (_) {}
}

// 启动时加载
loadUserData();
// 定期保存
setInterval(saveUserData, 60000);

// ── 工作流模板映射层 ──
// 前端只传 type，后端自动映射到 workflowId + nodeId
const WORKFLOW_TEMPLATES = {
  digitalHuman: {
    id: 'digitalHuman',
    name: '数字人',
    description: '真人/动漫口型同步，一键生成成片',
    category: 'video',
    cover: 'https://rh-images.xiaoyaoyou.com/system/144386_8.png',
    workflowId: '2044669894783934465',
    inputs: [
      { key: 'image', label: '人物图片', type: 'image', nodeId: '133', fieldName: 'image', required: true },
      { key: 'audio', label: '语音音频', type: 'audio', nodeId: '125', fieldName: 'audio', required: false }
    ]
  },
  digitalHumanLong: {
    id: 'digitalHumanLong',
    name: '数字人（长视频）',
    description: '7段 InfiniteTalk 串联，生成长数字人视频',
    category: 'video',
    cover: 'https://rh-images.xiaoyaoyou.com/system/144386_8.png',
    workflowId: '2047610350090063873',
    inputs: [
      { key: 'image', label: '人物图片', type: 'image', nodeId: '221', fieldName: 'image', required: true },
      { key: 'audio', label: '语音音频', type: 'audio', nodeId: '238', fieldName: 'audio', required: false }
    ]
  },
  imageGen: {
    id: 'imageGen',
    name: '文生图',
    description: '输入文字描述，AI 生成图片',
    category: 'image',
    cover: 'https://rh-images.xiaoyaoyou.com/system/144386_8.png',
    workflowId: '2047014805009080321',
    inputs: [
      { key: 'prompt', label: '图片描述', type: 'text', nodeId: '100', fieldName: 'text', required: true }
    ]
  },
  tts: {
    id: 'tts',
    name: 'TTS 文生声音',
    description: '输入文案，AI 生成语音',
    category: 'audio',
    cover: 'https://rh-images.xiaoyaoyou.com/system/144386_8.png',
    workflowId: '2046420823195525122',
    inputs: [
      { key: 'prompt', label: '朗读文案', type: 'text', nodeId: '47', fieldName: 'prompt', required: true },
      { key: 'refAudio', label: '参考音频', type: 'audio', nodeId: '46', fieldName: 'audio', required: false }
    ]
  },
  bgChange: {
    id: 'bgChange',
    name: '换背景加强版',
    description: '人物/产品换背景，直出4K高清',
    category: 'image',
    cover: './工作流/2052773619335479298/ComfyUI_00001_bgyta_1778256020.png',
    workflowId: '2052773619335479298',
    inputs: [
      { key: 'image', label: '人物/产品图片', type: 'image', nodeId: '7', fieldName: 'image', required: true },
      { key: 'text', label: '背景描述', type: 'text', nodeId: '13', fieldName: 'text', required: true }
    ]
  },
  sketchNote: {
    id: 'sketchNote',
    name: '手绘注解',
    description: '上传照片，AI 自动添加手绘风注解与可爱文字',
    category: 'image',
    cover: './工作流/2052783552210710530/c85d76452a14fbad99e19ce572099028.webp',
    workflowId: '2052767492019367937',
    inputs: [
      { key: 'text', label: '注解文字', type: 'text', nodeId: '1', fieldName: 'text', required: true },
      { key: 'image', label: '原始图片', type: 'image', nodeId: '4', fieldName: 'image', required: true }
    ]
  },
  storyboard: {
    id: 'storyboard',
    name: '影视分镜',
    description: '一键生成专业电影级分镜脚本与关键帧',
    category: 'video',
    cover: './工作流/2052770584093835266/05dc77698eea55a9c5f032d9258c677d.webp',
    workflowId: '2052770584093835266',
    inputs: [
      { key: 'image', label: '参考图片', type: 'image', nodeId: '442', fieldName: 'image', required: true },
      { key: 'theme', label: '故事主题', type: 'text', nodeId: '401', fieldName: 'text', required: true },
      { key: 'scene', label: '场景描述', type: 'text', nodeId: '412', fieldName: 'text', required: true },
      { key: 'duration', label: '时长(秒)', type: 'text', nodeId: '413', fieldName: 'text', required: true, default: '15' }
    ]
  },
  outfitPos: {
    id: 'outfitPos',
    name: '穿搭大师POS',
    description: '上传人物和姿势图片，AI 生成穿搭效果',
    category: 'image',
    cover: 'https://rh-images.xiaoyaoyou.com/c2d9dec685f25fab12df85d62cfcdc31/output/ComfyUI_00001_obkeh_1776322552.png?imageMogr2/format/webp/rquality/60/ignore-error/1/minisize/1',
    workflowId: '2047703658967601153',
    inputs: [
      { key: 'personImage', label: '人物图片', type: 'image', nodeId: '1158', fieldName: 'image1_2', required: true },
      { key: 'poseImage', label: '姿势参考图', type: 'image', nodeId: '1158', fieldName: 'image_1', required: true },
      { key: 'prompt', label: '穿搭描述', type: 'text', nodeId: '1158', fieldName: 'prompt_3', required: true }
    ]
  },
  productBgConsistent: {
    id: 'productBgConsistent',
    name: '电商产品一致性换背景',
    description: '产品图+背景图，AI生成完美融合的产品场景图',
    category: 'image',
    cover: './工作流/2053846026372558850/02a0913a35ae5bbd6bbacaa44ffa450d.webp',
    workflowId: '2053846026372558850',
    inputs: [
      { key: 'productImage', label: '产品图片', type: 'image', nodeId: '211', fieldName: 'image', required: true },
      { key: 'bgImage', label: '背景参考图', type: 'image', nodeId: '212', fieldName: 'image', required: true },
      { key: 'bgPrompt', label: '背景描述', type: 'text', nodeId: '209', fieldName: 'prompt', required: false }
    ]
  },
  ecommerceRetouch: {
    id: 'ecommerceRetouch',
    name: '电商万能精修',
    description: '上传任意图片，AI自动去除水印瑕疵、精修输出高清大图',
    category: 'image',
    cover: './工作流/2053847288795148290/7b2c0ac2b20a988cb15f6c3a3e14af71.webp',
    workflowId: '2053847288795148290',
    inputs: [
      { key: 'image', label: '待精修图片', type: 'image', nodeId: '2', fieldName: 'image', required: true },
      { key: 'retouchPrompt', label: '精修要求', type: 'text', nodeId: '60', fieldName: 'text', required: false, default: '精修，去除图片中的水印和瑕疵。' }
    ]
  },
  fashionModelVideo: {
    id: 'fashionModelVideo',
    name: '电商服装模特视频',
    description: '上传服装图片，AI生成模特展示旋转视频',
    category: 'video',
    cover: './工作流/2053847864337543169/1edd5bc46dee3b13e0828b425f151536.webp',
    workflowId: '2053847864337543169',
    inputs: [
      { key: 'image', label: '服装图片', type: 'image', nodeId: '150', fieldName: 'image', required: true },
      { key: 'prompt', label: '动作描述', type: 'text', nodeId: '76', fieldName: 'text', required: false, default: '人物旋转360度，然后向前走动' }
    ]
  }
};

// ── 统一任务系统 ──
// 内存存储，重启丢失（后续可换 SQLite/Redis）
const tasks = new Map();

function createTask(type, params) {
  const id = crypto.randomUUID();
  const task = {
    id,
    type,
    status: 'pending',    // pending → running → success / failed
    progress: 0,
    result: null,         // 成功时的输出 URL
    error: null,          // 失败时的错误信息
    params,               // 用户的输入参数
    rhTaskId: null,       // RunningHub 返回的任务 ID
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  tasks.set(id, task);
  return task;
}

function updateTask(id, updates) {
  const task = tasks.get(id);
  if (!task) return null;
  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  return task;
}

function getTask(id) {
  return tasks.get(id) || null;
}

function listTasks(type, limit = 50, offset = 0) {
  let list = Array.from(tasks.values());
  if (type) list = list.filter(t => t.type === type);
  // 按创建时间倒序
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return list.slice(offset, offset + limit);
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

  // 解码中文路径
  try { pathname = decodeURIComponent(pathname); } catch (_) {}

  const filePath = path.join(__dirname, pathname);
  const ext = path.extname(filePath).toLowerCase();

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

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid multipart request' }));
      return;
    }

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

// ── 发送 JSON 响应 ──
function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ── 提交工作流到 RunningHub 并启动轮询 ──
async function submitWorkflow(task, template, nodeInfoList) {
  const key = getKey();
  if (!key) {
    updateTask(task.id, { status: 'failed', error: 'API Key 未设置' });
    return;
  }

  updateTask(task.id, { status: 'running', progress: 0 });

  try {
    // 调用 V1 create 接口
    const createBody = { apiKey: key, workflowId: template.workflowId, nodeInfoList };
    const result = await rhRequest('/task/openapi/create', 'POST', createBody);

    if (!result || result.code !== 0) {
      updateTask(task.id, { status: 'failed', error: result?.msg || '创建任务失败', progress: 0 });
      return;
    }

    const rhTaskId = result.data?.taskId || result.data;
    updateTask(task.id, { rhTaskId, progress: 5 });

    // 开始轮询
    pollTaskStatus(task.id, rhTaskId);

  } catch (err) {
    updateTask(task.id, { status: 'failed', error: err.message, progress: 0 });
  }
}

// ── 轮询 RunningHub 任务状态 ──
function pollTaskStatus(taskId, rhTaskId) {
  const key = getKey();
  let attempts = 0;
  const maxAttempts = 720; // 最多轮询 720 次（约 1 小时，每 5 秒一次）

  const timer = setInterval(async () => {
    attempts++;
    const task = getTask(taskId);
    if (!task || task.status !== 'running' || attempts > maxAttempts) {
      if (attempts > maxAttempts && task && task.status === 'running') {
        updateTask(taskId, { status: 'failed', error: '任务超时' });
      }
      clearInterval(timer);
      return;
    }

    try {
      const result = await rhRequest('/task/openapi/outputs', 'POST', {
        apiKey: key,
        taskId: rhTaskId
      });

      if (!result) return;

      if (result.code === 0 && result.data) {
        const outputs = result.data;
        // 有输出结果
        if (Array.isArray(outputs) && outputs.length > 0) {
          const outputUrls = outputs.map(o => o.url || o).filter(Boolean);
          if (outputUrls.length > 0) {
            updateTask(taskId, { status: 'success', progress: 100, result: outputUrls });
            clearInterval(timer);
            return;
          }
        }
        // data 可能是单个对象
        if (outputs.url) {
          updateTask(taskId, { status: 'success', progress: 100, result: [outputs.url] });
          clearInterval(timer);
          return;
        }
      }

      // 更新进度（RunningHub 不返回精确进度，模拟递增）
      const progress = Math.min(5 + attempts * 0.5, 95);
      updateTask(taskId, { progress: Math.round(progress) });

    } catch (err) {
      console.error(`轮询任务 ${taskId} 失败:`, err.message);
    }
  }, 5000);
}

// ── 封装 RunningHub HTTP 请求 ──
function rhRequest(targetPath, method, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.runninghub.cn',
      port: 443,
      path: targetPath,
      method: method,
      headers: {
        'Authorization': `Bearer ${getKey()}`,
        'Content-Type': 'application/json',
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(null); }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── 管理接口 ──
function handleAdmin(req, res, pathname) {
  if (pathname === '/admin/status' && req.method === 'GET') {
    jsonResponse(res, 200, {
      keySet: !!getKey(),
      keyPrefix: getKey() ? getKey().substring(0, 6) + '...' : '',
      templates: Object.keys(WORKFLOW_TEMPLATES).length,
      tasks: tasks.size
    });
    return;
  }

  if (pathname === '/admin/setkey' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.key) throw new Error('缺少 key 字段');
        setKey(data.key);
        jsonResponse(res, 200, { ok: true, message: 'Key 已保存' });
      } catch (err) {
        jsonResponse(res, 400, { error: err.message });
      }
    });
    return;
  }

  jsonResponse(res, 404, { error: 'Unknown admin endpoint' });
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

  // ── 微信登录 API ──

  // GET /api/auth/wechat/url — 获取微信扫码登录链接
  if (pathname === '/api/auth/wechat/url' && req.method === 'GET') {
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = encodeURIComponent(WECHAT_CONFIG.redirectUri);
    const authUrl = `${WECHAT_CONFIG.authUrl}?appid=${WECHAT_CONFIG.appId}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`;
    jsonResponse(res, 200, { url: authUrl, state });
    return;
  }

  // GET /api/auth/wechat/callback — 微信回调
  if (pathname === '/api/auth/wechat/callback' && req.method === 'GET') {
    const query = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const code = query.get('code');
    const state = query.get('state');

    if (!code) {
      jsonResponse(res, 400, { error: '缺少 code 参数' });
      return;
    }

    try {
      // 用 code 换 access_token
      const tokenUrl = `${WECHAT_CONFIG.tokenUrl}?appid=${WECHAT_CONFIG.appId}&secret=${WECHAT_CONFIG.appSecret}&code=${code}&grant_type=authorization_code`;
      const tokenData = await wechatRequest(tokenUrl);

      if (!tokenData || tokenData.errcode) {
        // 微信接口失败时，本地开发模式使用模拟用户
        if (WECHAT_CONFIG.appId.startsWith('wx_test')) {
          const mockOpenid = 'mock_' + crypto.randomBytes(8).toString('hex');
          const user = findOrCreateUser(mockOpenid, { nickname: '测试用户', headimgurl: '' });
          const sessionId = createSession(mockOpenid);
          saveUserData();
          // 设置 cookie 并重定向到首页
          res.writeHead(302, {
            'Set-Cookie': `aihub_session=${sessionId}; Path=/; Max-Age=${SESSION_TTL / 1000}; HttpOnly`,
            'Location': '/'
          });
          res.end();
          return;
        }
        jsonResponse(res, 400, { error: '微信授权失败', detail: tokenData });
        return;
      }

      const { openid, access_token } = tokenData;

      // 获取用户信息
      let userInfo = {};
      if (access_token && openid) {
        try {
          const infoUrl = `${WECHAT_CONFIG.userinfoUrl}?access_token=${access_token}&openid=${openid}`;
          userInfo = await wechatRequest(infoUrl) || {};
        } catch (_) {}
      }

      const user = findOrCreateUser(openid, userInfo);
      const sessionId = createSession(openid);
      saveUserData();

      // 设置 cookie 并重定向到首页
      res.writeHead(302, {
        'Set-Cookie': `aihub_session=${sessionId}; Path=/; Max-Age=${SESSION_TTL / 1000}; HttpOnly`,
        'Location': '/'
      });
      res.end();

    } catch (err) {
      jsonResponse(res, 500, { error: '登录失败: ' + err.message });
    }
    return;
  }

  // POST /api/auth/dev-login — 本地开发模式快速登录（不走微信）
  if (pathname === '/api/auth/dev-login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const nickname = body.nickname || '开发测试用户';
    const mockOpenid = 'dev_' + crypto.randomBytes(8).toString('hex');
    const user = findOrCreateUser(mockOpenid, { nickname, headimgurl: '' });
    const sessionId = createSession(mockOpenid);
    saveUserData();

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `aihub_session=${sessionId}; Path=/; Max-Age=${SESSION_TTL / 1000}; HttpOnly`
    });
    res.end(JSON.stringify({ ok: true, user: { id: user.id, nickname: user.nickname, avatar: user.avatar } }));
    return;
  }

  // GET /api/auth/me — 获取当前登录用户
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const user = getUserFromRequest(req);
    if (!user) {
      jsonResponse(res, 200, { loggedIn: false });
      return;
    }
    jsonResponse(res, 200, { loggedIn: true, user: { id: user.id, nickname: user.nickname, avatar: user.avatar, openid: user.openid } });
    return;
  }

  // POST /api/auth/logout — 退出登录
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const cookies = req.headers.cookie || '';
    const match = cookies.match(/aihub_session=([^;]+)/);
    if (match) sessions.delete(match[1]);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'aihub_session=; Path=/; Max-Age=0; HttpOnly'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/auth/profile — 更新用户资料
  if (pathname === '/api/auth/profile' && req.method === 'POST') {
    const user = getUserFromRequest(req);
    if (!user) { jsonResponse(res, 401, { error: '未登录' }); return; }
    const body = await readJsonBody(req);
    if (body.nickname) user.nickname = body.nickname;
    if (body.avatar) user.avatar = body.avatar;
    saveUserData();
    jsonResponse(res, 200, { ok: true, user: { id: user.id, nickname: user.nickname, avatar: user.avatar } });
    return;
  }

  // ── 工作流模板 API ──

  // GET /api/templates — 获取所有工作流模板（不暴露 nodeId/workflowId）
  if (pathname === '/api/templates' && req.method === 'GET') {
    const templates = Object.values(WORKFLOW_TEMPLATES).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      cover: t.cover,
      inputs: t.inputs.map(i => ({
        key: i.key,
        label: i.label,
        type: i.type,
        required: i.required,
        default: i.default || undefined
      }))
    }));
    jsonResponse(res, 200, { templates });
    return;
  }

  // GET /api/templates/:id — 获取单个模板
  const templateMatch = pathname.match(/^\/api\/templates\/([a-zA-Z]+)$/);
  if (templateMatch && req.method === 'GET') {
    const template = WORKFLOW_TEMPLATES[templateMatch[1]];
    if (!template) {
      jsonResponse(res, 404, { error: '模板不存在' });
      return;
    }
    const safeTemplate = {
      id: template.id,
      name: template.name,
      description: template.description,
      category: template.category,
      cover: template.cover,
      inputs: template.inputs.map(i => ({
        key: i.key,
        label: i.label,
        type: i.type,
        required: i.required,
        default: i.default || undefined
      }))
    };
    jsonResponse(res, 200, safeTemplate);
    return;
  }

  // ── 统一任务 API ──

  // POST /api/task/create — 创建任务（前端只传 type + 用户输入）
  if (pathname === '/api/task/create' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { type, params } = body;

    if (!type || !WORKFLOW_TEMPLATES[type]) {
      jsonResponse(res, 400, { error: '无效的工作流类型', availableTypes: Object.keys(WORKFLOW_TEMPLATES) });
      return;
    }

    const template = WORKFLOW_TEMPLATES[type];

    // 验证必填参数
    for (const input of template.inputs) {
      if (input.required && !params[input.key]) {
        jsonResponse(res, 400, { error: `缺少必填参数: ${input.label} (${input.key})` });
        return;
      }
    }

    // 映射用户输入到 RunningHub nodeInfoList
    const nodeInfoList = template.inputs
      .filter(input => params[input.key])
      .map(input => ({
        nodeId: input.nodeId,
        fieldName: input.fieldName,
        fieldValue: String(params[input.key])
      }));

    // 创建任务
    const task = createTask(type, params);

    // 异步提交工作流
    submitWorkflow(task, template, nodeInfoList);

    jsonResponse(res, 200, {
      taskId: task.id,
      type: task.type,
      status: task.status,
      createdAt: task.createdAt
    });
    return;
  }

  // GET /api/task/:id — 查询任务状态
  const taskMatch = pathname.match(/^\/api\/task\/([0-9a-f-]{36})$/);
  if (taskMatch && req.method === 'GET') {
    const task = getTask(taskMatch[1]);
    if (!task) {
      jsonResponse(res, 404, { error: '任务不存在' });
      return;
    }
    jsonResponse(res, 200, {
      id: task.id,
      type: task.type,
      status: task.status,
      progress: task.progress,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    });
    return;
  }

  // GET /api/tasks — 任务列表
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const query = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const type = query.get('type') || undefined;
    const limit = parseInt(query.get('limit') || '50', 10);
    const offset = parseInt(query.get('offset') || '0', 10);
    const list = listTasks(type, limit, offset);
    jsonResponse(res, 200, {
      total: list.length,
      tasks: list.map(t => ({
        id: t.id,
        type: t.type,
        status: t.status,
        progress: t.progress,
        result: t.result,
        error: t.error,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      }))
    });
    return;
  }

  // ── 文件上传（仍保留直通代理，前端需要先上传拿到 fileUrl 再创建任务）──
  if (pathname === '/api/upload' && req.method === 'POST') {
    proxyUpload(req, res);
    return;
  }

  // ── 兼容旧接口（V1 直通代理）──
  if (pathname === '/api/create' && req.method === 'POST') {
    const body = await readJsonBody(req);
    body.apiKey = getKey();
    proxyToRH('/task/openapi/create', 'POST', body, res);
    return;
  }

  if (pathname === '/api/outputs' && req.method === 'POST') {
    const body = await readJsonBody(req);
    body.apiKey = getKey();
    proxyToRH('/task/openapi/outputs', 'POST', body, res);
    return;
  }

  // V2 直通代理
  if (pathname.startsWith('/api/v2/run/workflow/') && req.method === 'POST') {
    const workflowId = pathname.replace('/api/v2/run/workflow/', '');
    const body = await readJsonBody(req);
    proxyToRH(`/openapi/v2/run/workflow/${workflowId}`, 'POST', body, res);
    return;
  }

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
  │  AIHub 代理服务器 v2 已启动           │
  │  地址: http://localhost:${PORT}         │
  │  Key 状态: ${getKey() ? '✅ 已配置' : '❌ 未配置'}  │
  │  工作流模板: ${Object.keys(WORKFLOW_TEMPLATES).length} 个               │
  │  微信登录: ${WECHAT_CONFIG.appId.startsWith('wx_test') ? '🔧 测试模式' : '✅ 已配置'}              │
  │                                      │
  │  统一 API:                            │
  │  GET  /api/templates   获取模板列表   │
  │  POST /api/task/create 创建任务       │
  │  GET  /api/task/:id    查询任务状态   │
  │  GET  /api/tasks       任务列表       │
  │  POST /api/upload      上传文件       │
  │                                      │
  │  登录 API:                            │
  │  GET  /api/auth/wechat/url  扫码链接  │
  │  GET  /api/auth/callback    微信回调  │
  │  POST /api/auth/dev-login   开发登录  │
  │  GET  /api/auth/me          当前用户  │
  │  POST /api/auth/logout      退出登录  │
  └──────────────────────────────────────┘
  `);
});
