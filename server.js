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
const nodemailer = require('nodemailer');

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

// ── 微信小程序配置（扫码登录主力方案）──
const WXA_CONFIG = {
  appId: process.env.WXA_APPID || 'wx9bc36dfa64eb2b8d',
  appSecret: process.env.WXA_APPSECRET || '',
  apiUrl: 'https://api.weixin.qq.com',
};

// ── 邮件 SMTP 配置 ──
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || 'smtp.qq.com',
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true,
  user: process.env.SMTP_USER || '',       // QQ邮箱地址
  pass: process.env.SMTP_PASS || '',       // QQ邮箱授权码
  fromName: process.env.SMTP_FROM || 'AIHub',
};

// 创建邮件传输器
let mailTransporter = null;
function getMailer() {
  if (mailTransporter) return mailTransporter;
  if (!SMTP_CONFIG.user || !SMTP_CONFIG.pass) return null;
  mailTransporter = nodemailer.createTransport({
    host: SMTP_CONFIG.host,
    port: SMTP_CONFIG.port,
    secure: SMTP_CONFIG.secure,
    auth: { user: SMTP_CONFIG.user, pass: SMTP_CONFIG.pass },
  });
  return mailTransporter;
}

// ── 验证码系统 ──
const verifyCodes = new Map(); // email -> { code, expiresAt, attempts }
const CODE_TTL = 5 * 60 * 1000;       // 验证码5分钟有效
const CODE_COOLDOWN = 60 * 1000;       // 60秒内不能重复发送
const CODE_MAX_ATTEMPTS = 5;           // 最多验证5次

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6位数字
}

// 清理过期验证码
function cleanupVerifyCodes() {
  const now = Date.now();
  for (const [email, item] of verifyCodes) {
    if (now > item.expiresAt) verifyCodes.delete(email);
  }
}
setInterval(cleanupVerifyCodes, 10 * 60 * 1000);

// 发送验证码邮件
async function sendVerifyEmail(toEmail, code) {
  const mailer = getMailer();
  if (!mailer) throw new Error('邮件服务未配置');

  const html = `
    <div style="max-width:480px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f8fafc;border-radius:16px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#07c160,#06ae56);padding:32px 24px;text-align:center;">
        <h1 style="margin:0;color:#fff;font-size:24px;">AIHub</h1>
        <p style="margin:8px 0 0;color:rgba(255,255,255,.85);font-size:14px;">邮箱验证码</p>
      </div>
      <div style="padding:32px 24px;text-align:center;">
        <p style="margin:0 0 8px;font-size:15px;color:#334155;">你正在注册 AIHub 账号，验证码为：</p>
        <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#07c160;margin:16px 0;">${code}</div>
        <p style="margin:0;font-size:13px;color:#94a3b8;">验证码 5 分钟内有效，请勿泄露给他人</p>
      </div>
      <div style="padding:16px 24px;background:#f1f5f9;font-size:12px;color:#94a3b8;text-align:center;">
        如非本人操作，请忽略此邮件
      </div>
    </div>`;

  await mailer.sendMail({
    from: `"${SMTP_CONFIG.fromName}" <${SMTP_CONFIG.user}>`,
    to: toEmail,
    subject: '【AIHub】邮箱验证码',
    html,
  });
}

// 小程序 access_token 缓存
let wxaAccessToken = null;
let wxaTokenExpires = 0;

async function getWxaAccessToken() {
  if (wxaAccessToken && Date.now() < wxaTokenExpires) return wxaAccessToken;
  if (!WXA_CONFIG.appSecret) return null;
  const url = `${WXA_CONFIG.apiUrl}/cgi-bin/token?grant_type=client_credential&appid=${WXA_CONFIG.appId}&secret=${WXA_CONFIG.appSecret}`;
  const data = await wechatRequest(url);
  if (!data || !data.access_token) {
    console.error('获取小程序 access_token 失败:', data);
    return null;
  }
  wxaAccessToken = data.access_token;
  wxaTokenExpires = Date.now() + (data.expires_in - 300) * 1000; // 提前5分钟过期
  console.log('小程序 access_token 已更新，有效期:', data.expires_in, '秒');
  return wxaAccessToken;
}

// 生成小程序码（用于扫码登录）
async function generateWxaQrCode(scene) {
  const token = await getWxaAccessToken();
  if (!token) return null;
  const url = `${WXA_CONFIG.apiUrl}/wxa/getwxacodeunlimit?access_token=${token}`;
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify({
      scene,
      page: 'pages/index/index',
      width: 280,
      auto_color: false,
      line_color: { r: 7, g: 193, b: 96 }, // 微信绿
    });
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        // 如果返回的是 JSON（错误），content-type 是 application/json
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try {
            const errData = JSON.parse(buffer.toString());
            console.error('生成小程序码失败:', errData);
            resolve(null);
          } catch (_) { resolve(null); }
        } else {
          resolve(buffer); // 返回图片 buffer
        }
      });
    });
    req.on('error', (e) => { console.error('生成小程序码请求失败:', e); resolve(null); });
    req.write(postData);
    req.end();
  });
}

// 用小程序 code 换取 openid 和 session_key
async function jsCode2Session(code) {
  const url = `${WXA_CONFIG.apiUrl}/sns/jscode2session?appid=${WXA_CONFIG.appId}&secret=${WXA_CONFIG.appSecret}&js_code=${code}&grant_type=authorization_code`;
  return wechatRequest(url);
}

// ── 用户系统（内存存储，后续可换数据库）──
const users = new Map();       // openid -> user 对象
const emailIndex = new Map();  // email -> openid（邮箱快速查找）
const sessions = new Map();    // sessionId -> { openid, createdAt }
const pendingLogins = new Map(); // state -> { status, sessionId?, createdAt }
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 天
const PENDING_LOGIN_TTL = 5 * 60 * 1000; // 5 分钟

// 密码加密配置
const PW_SALT_LEN = 16;
const PW_KEY_LEN = 64;

// 密码加密
function hashPassword(password) {
  const salt = crypto.randomBytes(PW_SALT_LEN).toString('hex');
  const key = crypto.scryptSync(password, salt, PW_KEY_LEN).toString('hex');
  return `${salt}:${key}`;
}

// 密码验证
function verifyPassword(password, stored) {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, PW_KEY_LEN).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(key));
}

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

// 清理过期 pendingLogins 和 sessions
function cleanupExpired() {
  const now = Date.now();
  for (const [key, val] of pendingLogins) {
    if (now - val.createdAt > PENDING_LOGIN_TTL) pendingLogins.delete(key);
  }
  for (const [key, val] of sessions) {
    if (now - val.createdAt > SESSION_TTL) sessions.delete(key);
  }
}
setInterval(cleanupExpired, 10 * 60 * 1000); // 每 10 分钟清理一次

// 生成 Cookie 字符串
function sessionCookie(sessionId, maxAge) {
  const isProduction = WECHAT_CONFIG.appId && !WECHAT_CONFIG.appId.startsWith('wx_test');
  const parts = [
    `aihub_session=${sessionId}`,
    `Path=/`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
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
      if (data.users) data.users.forEach(u => {
        users.set(u.openid, u);
        // 重建邮箱索引
        if (u.email) emailIndex.set(u.email.toLowerCase(), u.openid);
      });
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
  },
  emoji3d: {
    id: 'emoji3d',
    name: '9宫格3D软萌Q版表情包',
    description: '上传人物图片，AI生成9宫格3D萌系Q版表情贴纸',
    category: 'image',
    cover: './工作流/2055119814208827394/9宫格3D软萌Q版表情包_主图.jpg',
    workflowId: '2055119814208827394',
    inputs: [
      { key: 'image', label: '人物参考图', type: 'image', nodeId: '2', fieldName: 'image', required: true },
      { key: 'prompt', label: '表情描述', type: 'text', nodeId: '9', fieldName: 'text', required: true, default: '一套可爱的 3D 萌系卡通贴纸，包含同一个角色，多种情绪和姿势' }
    ]
  },
  retouchPro: {
    id: 'retouchPro',
    name: '极致写实精修',
    description: '输入详细描述，AI生成极致写实级精修大图',
    category: 'image',
    cover: './工作流/2055127486521987073/Z-Image+EngineerV4提示词优化+fdpo光影优化+Kook极致写实+Seedvr放大_主图.jpg',
    workflowId: '2055127486521987073',
    inputs: [
      { key: 'prompt', label: '详细描述', type: 'text', nodeId: '29', fieldName: 'text', required: true },
      { key: 'stylePrompt', label: '风格词', type: 'text', nodeId: '30', fieldName: 'text', required: false, default: 'movie clip' }
    ]
  },
  consistencyLighting: {
    id: 'consistencyLighting',
    name: '自动溶图打光一致性',
    description: '上传人物图片，AI自动溶图打光，保持角色一致性',
    category: 'image',
    cover: './工作流/2055185911817752578/F.2klein9b自动溶图打光一致性_主图.jpg',
    workflowId: '2055185911817752578',
    inputs: [
      { key: 'image', label: '人物图片', type: 'image', nodeId: '76', fieldName: 'image', required: true }
    ]
  },
  fashionModelPhoto: {
    id: 'fashionModelPhoto',
    name: '服装模特生图',
    description: '输入描述，AI生成服装模特展示图',
    category: 'image',
    cover: './工作流/2055187733060046849/Zimage-turbo保暖内衣_主图.jpg',
    workflowId: '2055187733060046849',
    inputs: [
      { key: 'prompt', label: '模特描述', type: 'text', nodeId: '27', fieldName: 'string', required: true, default: '一位年轻优雅的女性模特，身着高弹力修身保暖内衣套装' }
    ]
  },
  faceSwap: {
    id: 'faceSwap',
    name: 'AI换脸',
    description: '上传源脸和目标人物，AI精准换脸融合',
    category: 'image',
    cover: './工作流/2056552526455070721/ab38d61a-d615-45c9-aa42-9931d3ee93ef.png',
    workflowId: '2056552526455070721',
    inputs: [
      { key: 'sourceFaceImage', label: '源脸图片', type: 'image', nodeId: '85', fieldName: 'image', required: true },
      { key: 'targetImage', label: '目标人物图', type: 'image', nodeId: '86', fieldName: 'image', required: true },
      { key: 'prompt', label: '换脸提示', type: 'text', nodeId: '26', fieldName: 'text', required: false, default: 'Switch the right side of your face to the left' }
    ]
  },
  styleTransferFace: {
    id: 'styleTransferFace',
    name: '风格迁移换装换脸',
    description: '上传人像和风格参考，AI一键换装换脸人像摄影',
    category: 'image',
    cover: './工作流/2056553281291374594/768a8b141b183df6fe07db0f65dc5f09.jpg',
    workflowId: '2056553281291374594',
    inputs: [
      { key: 'styleImage', label: '风格参考图', type: 'image', nodeId: '18', fieldName: 'image', required: true },
      { key: 'personImage', label: '人像原图', type: 'image', nodeId: '19', fieldName: 'image', required: true },
      { key: 'refFaceImage', label: '参考人脸图', type: 'image', nodeId: '534', fieldName: 'image', required: false }
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
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(200, headers);
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
    const createBody = { apiKey: key, workflowId: template.workflowId, nodeInfoList };
    const result = await rhRequest('/task/openapi/create', 'POST', createBody);

    if (!result || result.code !== 0) {
      updateTask(task.id, { status: 'failed', error: result?.msg || '创建任务失败', progress: 0 });
      return;
    }

    const rhTaskId = result.data?.taskId || result.data;
    updateTask(task.id, { rhTaskId, progress: 5, error: null });

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
        // 递归提取所有 URL（兼容各种返回格式）
        const urls = [];
        (function walk(x) {
          if (!x) return;
          if (typeof x === 'string' && /^https?:\/\//i.test(x)) { urls.push(x); return; }
          if (Array.isArray(x)) x.forEach(walk);
          else if (typeof x === 'object') Object.values(x).forEach(walk);
        })(result.data);

        if (urls.length > 0) {
          updateTask(taskId, { status: 'success', progress: 100, result: urls });
          clearInterval(timer);
          return;
        }
      }

      // 任务失败（code 805 是真正的失败）
      if (result.code === 805) {
        updateTask(taskId, { status: 'failed', error: result.msg || '任务执行失败', progress: 0 });
        clearInterval(timer);
        return;
      }

      // code 804 (APIKEY_TASK_IS_RUNNING) 表示任务还在跑，继续轮询
      // code 0 但 data 为空也表示还在跑

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
    const key = getKey();
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

  // ── 小程序码扫码登录 API（主力方案）──

  // GET /api/auth/wxa/qrcode — 生成小程序码图片
  if (pathname === '/api/auth/wxa/qrcode' && req.method === 'GET') {
    const state = crypto.randomBytes(16).toString('hex');
    // 记录 pending 状态
    pendingLogins.set(state, { status: 'pending', createdAt: Date.now() });

    if (!WXA_CONFIG.appSecret) {
      // 没有 AppSecret 时返回模拟二维码（开发模式）
      jsonResponse(res, 200, { state, mode: 'dev', message: '未配置 WXA_APPSECRET，使用开发模式' });
      return;
    }

    const imgBuffer = await generateWxaQrCode(state);
    if (!imgBuffer) {
      jsonResponse(res, 500, { error: '生成小程序码失败' });
      return;
    }
    // 返回图片 + state
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'X-Login-State': state,
      'Cache-Control': 'no-cache',
    });
    res.end(imgBuffer);
    return;
  }

  // POST /api/auth/wxa/login — 小程序上报登录结果
  if (pathname === '/api/auth/wxa/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { code, state } = body;

    if (!code || !state) {
      jsonResponse(res, 400, { error: '缺少 code 或 state' });
      return;
    }

    // 检查 state 是否有效
    if (!pendingLogins.has(state)) {
      jsonResponse(res, 400, { error: '登录已过期，请重新扫码' });
      return;
    }

    try {
      // 用 code 换 openid
      const sessionData = await jsCode2Session(code);
      if (!sessionData || sessionData.errcode) {
        jsonResponse(res, 400, { error: '微信授权失败', detail: sessionData });
        return;
      }

      const { openid, unionid } = sessionData;
      const userId = unionid || openid;

      // 创建/查找用户
      const user = findOrCreateUser(userId, { nickname: '微信用户', headimgurl: '' });
      const sessionId = createSession(userId);
      saveUserData();

      // 更新 pendingLogin 为 confirmed
      pendingLogins.set(state, {
        status: 'confirmed',
        sessionId,
        openid: userId,
        createdAt: pendingLogins.get(state).createdAt,
      });

      jsonResponse(res, 200, { ok: true, nickname: user.nickname });
    } catch (err) {
      jsonResponse(res, 500, { error: '登录失败: ' + err.message });
    }
    return;
  }

  // GET /api/auth/wxa/check — 前端轮询小程序扫码结果（复用 wechat/check 逻辑）
  if (pathname === '/api/auth/wxa/check' && req.method === 'GET') {
    const query = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const state = query.get('state');
    if (!state || !pendingLogins.has(state)) {
      jsonResponse(res, 200, { status: 'expired' });
      return;
    }
    const pending = pendingLogins.get(state);
    if (pending.status === 'confirmed' && pending.sessionId) {
      const user = users.get(pending.openid);
      pendingLogins.delete(state);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionCookie(pending.sessionId, SESSION_TTL / 1000),
      });
      res.end(JSON.stringify({
        status: 'confirmed',
        user: user ? { id: user.id, nickname: user.nickname, avatar: user.avatar, email: user.email || '' } : null,
      }));
      return;
    }
    jsonResponse(res, 200, { status: pending.status });
    return;
  }

  // ── 微信登录 API（旧方案保留）──

  // GET /api/auth/wechat/url — 获取微信扫码登录参数（供 WxLogin SDK 使用）
  if (pathname === '/api/auth/wechat/url' && req.method === 'GET') {
    const state = crypto.randomBytes(16).toString('hex');
    // 记录 pending 状态
    pendingLogins.set(state, { status: 'pending', createdAt: Date.now() });
    jsonResponse(res, 200, {
      appId: WECHAT_CONFIG.appId,
      redirectUri: WECHAT_CONFIG.redirectUri,
      state,
      scope: 'snsapi_login',
    });
    return;
  }

  // GET /api/auth/wechat/check — 前端轮询扫码结果
  if (pathname === '/api/auth/wechat/check' && req.method === 'GET') {
    const query = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const state = query.get('state');
    if (!state || !pendingLogins.has(state)) {
      jsonResponse(res, 200, { status: 'expired' });
      return;
    }
    const pending = pendingLogins.get(state);
    if (pending.status === 'confirmed' && pending.sessionId) {
      // 登录成功，返回 session cookie
      const user = users.get(pending.openid);
      pendingLogins.delete(state);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionCookie(pending.sessionId, SESSION_TTL / 1000),
      });
      res.end(JSON.stringify({
        status: 'confirmed',
        user: user ? { id: user.id, nickname: user.nickname, avatar: user.avatar } : null,
      }));
      return;
    }
    jsonResponse(res, 200, { status: pending.status });
    return;
  }

  // GET /api/auth/wechat/callback — 微信回调
  if (pathname === '/api/auth/wechat/callback' && req.method === 'GET') {
    const query = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const code = query.get('code');
    const state = query.get('state');

    if (!code) {
      // 渲染错误页面
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><script>
        alert('授权失败：缺少 code'); window.close();
      </script></body></html>`);
      return;
    }

    try {
      let openid, userInfo = {};

      // 用 code 换 access_token
      const tokenUrl = `${WECHAT_CONFIG.tokenUrl}?appid=${WECHAT_CONFIG.appId}&secret=${WECHAT_CONFIG.appSecret}&code=${code}&grant_type=authorization_code`;
      const tokenData = await wechatRequest(tokenUrl);

      if (!tokenData || tokenData.errcode) {
        // 微信接口失败时，本地开发模式使用模拟用户
        if (WECHAT_CONFIG.appId.startsWith('wx_test')) {
          openid = 'mock_' + crypto.randomBytes(8).toString('hex');
          userInfo = { nickname: '测试用户', headimgurl: '' };
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html><body><script>
            alert('微信授权失败'); window.close();
          </script></body></html>`);
          return;
        }
      } else {
        openid = tokenData.openid;
        // 获取用户信息
        if (tokenData.access_token && openid) {
          try {
            const infoUrl = `${WECHAT_CONFIG.userinfoUrl}?access_token=${tokenData.access_token}&openid=${openid}`;
            userInfo = await wechatRequest(infoUrl) || {};
          } catch (_) {}
        }
      }

      const user = findOrCreateUser(openid, userInfo);
      const sessionId = createSession(openid);
      saveUserData();

      // 更新 pendingLogin 状态
      if (state && pendingLogins.has(state)) {
        pendingLogins.set(state, {
          status: 'confirmed',
          sessionId,
          openid,
          createdAt: pendingLogins.get(state).createdAt,
        });
      }

      // 渲染成功页面，通过 postMessage 通知父窗口
      const callbackOrigin = new URL(WECHAT_CONFIG.redirectUri).origin;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>登录成功</title>
<style>
  body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5}
  .card{text-align:center;padding:40px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1)}
  .icon{font-size:48px;margin-bottom:16px}
  h2{color:#333;margin:0 0 8px}
  p{color:#666;margin:0}
</style></head><body>
<div class="card">
  <div class="icon">&#9989;</div>
  <h2>登录成功</h2>
  <p>欢迎回来，${user.nickname}！</p>
  <p style="margin-top:12px;font-size:13px;color:#999">可关闭此窗口</p>
</div>
<script>
  // 通知父窗口登录成功
  if (window.opener) {
    window.opener.postMessage({ type:'wechat_login_success', state:'${state || ''}' }, '${callbackOrigin}');
  }
  // 3秒后自动关闭
  setTimeout(function(){ window.close(); }, 3000);
</script>
</body></html>`);

    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><script>
        alert('登录失败: ${err.message.replace(/'/g, "\\'")}'); window.close();
      </script></body></html>`);
    }
    return;
  }

  // ── 邮箱注册/登录 API ──

  // POST /api/auth/email/send-code — 发送验证码
  if (pathname === '/api/auth/email/send-code' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { email } = body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      jsonResponse(res, 400, { error: '邮箱格式不正确' });
      return;
    }

    const emailLower = email.toLowerCase();

    // 检查冷却时间
    const existing = verifyCodes.get(emailLower);
    if (existing && Date.now() < existing.expiresAt - CODE_TTL + CODE_COOLDOWN) {
      const waitSec = Math.ceil((existing.expiresAt - CODE_TTL + CODE_COOLDOWN - Date.now()) / 1000);
      jsonResponse(res, 429, { error: `请${waitSec}秒后再试` });
      return;
    }

    // 检查邮件服务
    if (!getMailer()) {
      // 无SMTP配置时，开发模式直接返回验证码
      const code = generateCode();
      verifyCodes.set(emailLower, { code, expiresAt: Date.now() + CODE_TTL, attempts: 0 });
      console.log(`[DEV] 邮箱验证码: ${emailLower} -> ${code}`);
      jsonResponse(res, 200, { ok: true, devCode: code, message: '开发模式：验证码已打印到控制台' });
      return;
    }

    // 生产模式发送邮件
    const code = generateCode();
    try {
      await sendVerifyEmail(emailLower, code);
      verifyCodes.set(emailLower, { code, expiresAt: Date.now() + CODE_TTL, attempts: 0 });
      jsonResponse(res, 200, { ok: true, message: '验证码已发送' });
    } catch (err) {
      console.error('发送验证码邮件失败:', err.message);
      jsonResponse(res, 500, { error: '发送失败，请稍后重试' });
    }
    return;
  }

  // POST /api/auth/email/register — 邮箱注册（需验证码）
  if (pathname === '/api/auth/email/register' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { email, password, nickname, code } = body;

    if (!email || !password) {
      jsonResponse(res, 400, { error: '邮箱和密码不能为空' });
      return;
    }
    if (!code) {
      jsonResponse(res, 400, { error: '请输入验证码' });
      return;
    }
    // 邮箱格式校验
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      jsonResponse(res, 400, { error: '邮箱格式不正确' });
      return;
    }
    // 密码长度校验
    if (password.length < 6) {
      jsonResponse(res, 400, { error: '密码至少6位' });
      return;
    }

    const emailLower = email.toLowerCase();

    // 校验验证码
    const stored = verifyCodes.get(emailLower);
    if (!stored) {
      jsonResponse(res, 400, { error: '请先获取验证码' });
      return;
    }
    if (Date.now() > stored.expiresAt) {
      verifyCodes.delete(emailLower);
      jsonResponse(res, 400, { error: '验证码已过期，请重新获取' });
      return;
    }
    if (stored.attempts >= CODE_MAX_ATTEMPTS) {
      verifyCodes.delete(emailLower);
      jsonResponse(res, 400, { error: '验证码错误次数过多，请重新获取' });
      return;
    }
    if (stored.code !== code) {
      stored.attempts++;
      jsonResponse(res, 400, { error: `验证码错误，还剩${CODE_MAX_ATTEMPTS - stored.attempts}次机会` });
      return;
    }
    // 验证码正确，清除
    verifyCodes.delete(emailLower);

    // 检查邮箱是否已注册
    if (emailIndex.has(emailLower)) {
      jsonResponse(res, 409, { error: '该邮箱已注册，请直接登录' });
      return;
    }

    // 创建用户
    const openid = 'email_' + crypto.randomBytes(12).toString('hex');
    const user = findOrCreateUser(openid, {
      nickname: nickname || email.split('@')[0],
      headimgurl: '',
    });
    user.email = emailLower;
    user.passwordHash = hashPassword(password);
    emailIndex.set(emailLower, openid);
    saveUserData();

    const sessionId = createSession(openid);
    saveUserData();

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie(sessionId, SESSION_TTL / 1000),
    });
    res.end(JSON.stringify({
      ok: true,
      user: { id: user.id, nickname: user.nickname, avatar: user.avatar, email: user.email },
    }));
    return;
  }

  // POST /api/auth/email/login — 邮箱登录
  if (pathname === '/api/auth/email/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { email, password } = body;

    if (!email || !password) {
      jsonResponse(res, 400, { error: '邮箱和密码不能为空' });
      return;
    }

    const emailLower = email.toLowerCase();
    const openid = emailIndex.get(emailLower);
    if (!openid || !users.has(openid)) {
      jsonResponse(res, 401, { error: '邮箱未注册' });
      return;
    }

    const user = users.get(openid);
    if (!user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      jsonResponse(res, 401, { error: '密码错误' });
      return;
    }

    user.lastLoginAt = new Date().toISOString();
    const sessionId = createSession(openid);
    saveUserData();

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie(sessionId, SESSION_TTL / 1000),
    });
    res.end(JSON.stringify({
      ok: true,
      user: { id: user.id, nickname: user.nickname, avatar: user.avatar, email: user.email },
    }));
    return;
  }

  // POST /api/auth/dev-login — 本地开发模式快速登录（不走微信）
  if (pathname === '/api/auth/dev-login' && req.method === 'POST') {
    // 生产环境禁用开发模式登录
    if (!WECHAT_CONFIG.appId.startsWith('wx_test')) {
      jsonResponse(res, 403, { error: '生产环境不允许开发模式登录' });
      return;
    }
    const body = await readJsonBody(req);
    const nickname = body.nickname || '开发测试用户';
    const mockOpenid = 'dev_' + crypto.randomBytes(8).toString('hex');
    const user = findOrCreateUser(mockOpenid, { nickname, headimgurl: '' });
    const sessionId = createSession(mockOpenid);
    saveUserData();

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie(sessionId, SESSION_TTL / 1000),
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
    jsonResponse(res, 200, { loggedIn: true, user: { id: user.id, nickname: user.nickname, avatar: user.avatar, openid: user.openid, email: user.email || '' } });
    return;
  }

  // POST /api/auth/logout — 退出登录
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const cookies = req.headers.cookie || '';
    const match = cookies.match(/aihub_session=([^;]+)/);
    if (match) sessions.delete(match[1]);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie('', 0),
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
    if (body.email) user.email = body.email;
    saveUserData();
    jsonResponse(res, 200, { ok: true, user: { id: user.id, nickname: user.nickname, avatar: user.avatar, email: user.email || '' } });
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

  // ── 文件下载代理（解决跨域下载问题）──
  if (pathname === '/api/download' && req.method === 'GET') {
    const query = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const fileUrl = query.get('url');
    if (!fileUrl || !/^https?:\/\//i.test(fileUrl)) {
      jsonResponse(res, 400, { error: '缺少 url 参数' });
      return;
    }

    const parsedUrl = new URL(fileUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    protocol.get(fileUrl, { headers: { 'User-Agent': 'AIHub/1.0' } }, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        // 跟随重定向
        res.writeHead(302, { 'Location': `/api/download?url=${encodeURIComponent(proxyRes.headers.location)}` });
        res.end();
        return;
      }

      const contentType = proxyRes.headers['content-type'] || 'application/octet-stream';
      // 从 URL 提取文件名
      const urlPath = parsedUrl.pathname || '';
      const fileName = urlPath.split('/').pop() || 'download';
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Access-Control-Allow-Origin': '*',
      });
      proxyRes.pipe(res);
    }).on('error', (err) => {
      jsonResponse(res, 502, { error: '下载失败: ' + err.message });
    });
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
  │  微信登录: ${WXA_CONFIG.appSecret ? '✅ 小程序码模式' : '🔧 测试模式'}              │
  │                                      │
  │  统一 API:                            │
  │  GET  /api/templates   获取模板列表   │
  │  POST /api/task/create 创建任务       │
  │  GET  /api/task/:id    查询任务状态   │
  │  GET  /api/tasks       任务列表       │
  │  POST /api/upload      上传文件       │
  │                                      │
  │  登录 API:                            │
  │  GET  /api/auth/wxa/qrcode   小程序码  │
  │  POST /api/auth/wxa/login    小程序回调│
  │  GET  /api/auth/wxa/check    轮询状态  │
  │  GET  /api/auth/wechat/url   SDK参数  │
  │  GET  /api/auth/wechat/check 轮询状态 │
  │  GET  /api/auth/wechat/callback 回调  │
  │  POST /api/auth/email/register 邮箱注册│
  │  POST /api/auth/email/login    邮箱登录│
  │  POST /api/auth/email/send-code 发送验证│
  │  POST /api/auth/dev-login    开发登录  │
  │  GET  /api/auth/me           当前用户  │
  │  POST /api/auth/logout       退出登录  │
  └──────────────────────────────────────┘
  `);
});
