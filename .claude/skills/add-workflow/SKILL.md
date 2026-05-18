---
name: add-workflow
description: "从工作流文件夹一键接入新工作流到 AIHub 平台。Use when 用户给了一个工作流文件夹（或 workflowId），要求接入/添加/上线新工作流，或说'帮我接入这个工作流'、'新增一个工作流'。"
allowed_tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# 接入新工作流 Skill

从用户提供的文件夹（或 workflowId）一键完成：解析 JSON → 提取输入节点 → 配置 server.js → 更新 index.html 卡片。

## 触发条件

用户给出以下任一形式：
- 一个 `工作流/` 下的文件夹路径
- 一个 RunningHub workflowId
- 一个 `_workflow_api.json` 文件
- 说"帮我接入/添加/上线一个新工作流"

## 完整流程（5 步）

### Step 1: 读取文件夹，提取关键信息

从 `工作流/{workflowId}/` 目录中找到：

1. **`*_workflow_api.json`** — ComfyUI 工作流定义，必须解析
2. **`*_主图.jpg`** — 卡片封面图，路径格式为 `./工作流/{workflowId}/{主图文件名}`

文件夹命名规则：`工作流/{workflowId}/`
文件命名规则：`{中文名}_workflow_api.json` 和 `{中文名}_主图.jpg`

### Step 2: 解析 JSON，提取用户输入节点

遍历 JSON 中所有节点，找出需要用户输入的节点类型：

| class_type | 需要的输入 | fieldName | type |
|------------|-----------|-----------|------|
| `LoadImage` | `image` | `"image"` | `"image"` |
| `JjkText` / `String Literal` / `CR Prompt List` 中的 text | `text` | `"text"` | `"text"` |
| `LoadAudio` / 类似音频加载 | `audio` | `"audio"` | `"audio"` |
| 任何节点的 `string` / `prompt` 字段且有默认文本 | 该字段名 | 看具体字段 | `"text"` |

**关键规则：**
- `LoadImage` 类型的节点：用户需要上传图片，`fieldName` 固定为 `"image"`
- 文本类型节点：用户输入文字，需要看节点中是否有默认值（`default` 字段）
- `SaveImage` 节点：忽略，这是输出
- `KSampler` / `VAEDecode` / `LoraLoader` 等内部节点：忽略，不需要用户输入
- 节点 ID 是 JSON 中的 key（如 `"2"`, `"9"`, `"27"`）

**如何判断某个节点是否需要用户输入：**
- 如果节点的某个输入字段值是**字符串字面量**（不是 `[nodeId, index]` 格式的引用），且该字段是 `image`/`text`/`prompt`/`string`/`audio` 类型 → 需要用户输入
- 如果字段值是 `[nodeId, index]` 数组格式 → 这是其他节点的输出引用，不需要用户输入

**从 JSON 提取 inputs 的示例：**

```json
// 节点 "2": LoadImage → 用户需要上传图片
"2": {
  "inputs": { "image": "b8bb06a4bae0c69156ee9a0264fbdaa1bc2b1b2020ba5178ecb55ae2af732135.png" },
  "class_type": "LoadImage"
}
// → { key: "image", label: "人物参考图", type: "image", nodeId: "2", fieldName: "image", required: true }

// 节点 "9": JjkText → 用户需要输入文字
"9": {
  "inputs": { "text": "一套可爱的 3D 萌系卡通贴纸..." },
  "class_type": "JjkText"
}
// → { key: "prompt", label: "表情描述", type: "text", nodeId: "9", fieldName: "text", required: true, default: "一套可爱的 3D 萌系卡通贴纸..." }

// 节点 "27": String Literal → 用户需要输入文字
"27": {
  "inputs": { "string": "一位年轻优雅的白人女性模特..." },
  "class_type": "String Literal"
}
// → { key: "prompt", label: "模特描述", type: "text", nodeId: "27", fieldName: "string", required: true, default: "一位年轻优雅的白人女性模特..." }
```

### Step 3: 生成模板配置，写入 server.js

在 `server.js` 的 `WORKFLOW_TEMPLATES` 对象中新增一条，格式：

```javascript
camelCaseId: {
  id: 'camelCaseId',           // 驼峰式英文 ID
  name: '中文工作流名称',       // 从 JSON 文件名提取
  description: '简短中文描述',  // 一句话说明功能
  category: 'image',           // image / video / audio
  cover: './工作流/{workflowId}/{主图文件名}',
  workflowId: '{workflowId}',   // 文件夹名就是 workflowId
  inputs: [
    // 从 Step 2 提取的输入配置
    { key: 'image', label: '人物图片', type: 'image', nodeId: '2', fieldName: 'image', required: true },
    { key: 'prompt', label: '描述文字', type: 'text', nodeId: '9', fieldName: 'text', required: true, default: '默认文本' }
  ]
}
```

**id 命名规则：** 从中文文件名翻译成驼峰英文，如 `9宫格3D软萌Q版表情包` → `emoji3d`

**inputs 的 key 命名规则：**
- 图片上传统一用描述性 key：`productImage`, `bgImage`, `personImage` 等
- 文本输入统一用描述性 key：`prompt`, `bgPrompt`, `retouchPrompt` 等
- 同一个工作流有多个同类输入时，加前缀区分

### Step 4: 更新 index.html 卡片

在 `index.html` 中需要更新 **3 个位置**（首页快捷入口、AI 应用推荐、工作流页面），每个位置加一个卡片：

**卡片 HTML 模板：**
```html
<article class="mini-card clickable" @click="openXxx()">
  <div><h4>中文工作流名称</h4><p>简短描述</p></div>
  <div class="thumb"><img src="./工作流/{workflowId}/{主图文件名}" /></div>
</article>
```

同时在 `methods` 中新增跳转方法：
```javascript
openXxx() { window.location.href = './workflow.html?type=camelCaseId'; },
```

在 `openWorkflow` 的 `pageMap` 中新增映射：
```javascript
camelCaseId: './workflow.html?type=camelCaseId',
```

在 `allWorkflows` 数组中新增条目：
```javascript
{ key: 'camelCaseId', name: '中文名', desc: '描述', cover: './工作流/{workflowId}/{主图文件名}' }
```

在 `hotApps` 数组中新增条目（可选，看是否适合热门）。

在 `templateName` 映射中新增：
```javascript
camelCaseId: '中文名'
```

### Step 5: 验证

1. 确认 `server.js` 语法正确：`node -c server.js`
2. 确认主图文件存在：`ls 工作流/{workflowId}/*主图*`
3. 重启服务器测试

## Gotchas

- **fieldName 不要写错**：`LoadImage` 的 fieldName 固定是 `"image"`（不是 `"images"`），`JjkText` 的是 `"text"`，`String Literal` 的是 `"string"`。必须看 JSON 中 `inputs` 的实际 key 名。
- **nodeId 是字符串**：JSON 的 key 是字符串如 `"2"`, `"211"`，但 `nodeInfoList` 中传给 RunningHub 的 `nodeId` 也是字符串，不要转成数字。
- **inputs 中只放用户需要填的**：`KSampler`、`VAEDecode`、`LoraLoader`、`SaveImage` 等内部节点不要放进 inputs，这些参数由 RunningHub 自动处理。
- **默认值从 JSON 提取**：如果 JSON 中文本节点有默认文本，一定要放到 `default` 字段，这样用户打开表单时不会是空的。
- **cover 路径用相对路径**：`./工作流/{workflowId}/{主图文件名}`，不要用绝对路径。
- **804 不是错误**：轮询 RunningHub outputs 时 `code:804 (APIKEY_TASK_IS_RUNNING)` 表示任务运行中，继续轮询。只有 `code:805` 才是真失败。见 [[runninghub-api-codes]]。
