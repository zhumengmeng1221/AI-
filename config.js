/**
 * AIHub 统一配置文件
 * 所有 RunningHub API 相关的 workflowId / nodeId / fieldName 集中管理
 * 
 * 使用方式：
 *   在 HTML 中 <script src="./config.js"></script>
 *   然后通过 window.AIHubConfig 访问
 */

window.AIHubConfig = {
  // ── RunningHub 基础配置 ──
  runninghub: {
    baseUrl: 'https://www.runninghub.cn',
    // V1 接口
    uploadPath: '/task/openapi/upload',
    createPath: '/task/openapi/create',
    outputsPath: '/task/openapi/outputs',
    // V2 接口
    v2RunPath: '/openapi/v2/run/workflow/',
    v2QueryPath: '/openapi/v2/query',

    // ── 工作流：文生图 ──
    imageGen: {
      workflowId: '2047014805009080321',
      nodes: {
        prompt: { nodeId: '100', fieldName: 'text' }
      }
    },

    // ── 工作流：TTS 文生声音 ──
    tts: {
      workflowId: '2046420823195525122',
      nodes: {
        prompt:    { nodeId: '47', fieldName: 'prompt' },
        refAudio:  { nodeId: '46', fieldName: 'audio' }
      }
    },

    // ── 工作流：图片+声音→数字人视频 ──
    digitalHuman: {
      workflowId: '2044669894783934465',
      nodes: {
        image: { nodeId: '133', fieldName: 'image' },
        audio: { nodeId: '125', fieldName: 'audio' }
      }
    }
  },

  // ── 后端代理（API Key 安全改造后启用）──
  proxy: {
    enabled: false,
    baseUrl: '/api',  // 后端代理地址前缀
    endpoints: {
      upload:  '/upload',
      create:  '/create',
      outputs: '/outputs',
      v2Run:   '/v2/run/workflow/',
      v2Query: '/v2/query'
    }
  },

  // ── 应用列表数据（首页引用）──
  // 详见 index.html 内联数据，后续可迁移至此
};
