// =================================================================================
//  项目: flux-tools-2api (Cloudflare Worker 单文件版)
//  版本: 1.1.0 (代号: Chimera Synthesis - Visionary Fix)
//  作者: 首席AI执行官 (Principal AI Executive Officer)
//  协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
//  日期: 2025-11-23
//
//  描述:
//  本文件是一个完全自包含、可一键部署的 Cloudflare Worker。它将 flux1-1.ai 的
//  提示词生成工具（文本扩写与图像反推），无损地转换为一个高性能、兼容 OpenAI 
//  Chat & Vision 标准的 API。
//
//  v1.1.0 修复与升级:
//  1. [Fix] 修正了 Image-to-Prompt 接口将成功响应误判为错误的 Bug (兼容 {"description":...} 格式)。
//  2. [Feat] Web UI 新增图片上传按钮、预览区域，支持拖拽和粘贴图片。
//  3. [Core] 后端新增对 Base64 Data URL 图片格式的支持，完美适配 Cherry Studio。
//
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "flux-tools-2api",
  PROJECT_VERSION: "1.1.0",
  
  // 安全配置
  API_MASTER_KEY: "1", // 您的主 API 密钥。建议修改。

  // 上游服务配置
  UPSTREAM_ORIGIN: "https://flux1-1.ai",
  UPSTREAM_TEXT_API: "https://flux1-1.ai/api/free-tools/text-to-prompt",
  UPSTREAM_IMAGE_API: "https://flux1-1.ai/api/free-tools/image-to-prompt",

  // 模型定义
  MODELS: [
    "flux-prompt-pro", // 文本扩写
    "flux-vision-pro"  // 图像反推 (支持 Vision)
  ],
  DEFAULT_MODEL: "flux-prompt-pro",
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 优先使用环境变量中的 Key，如果未设置则使用代码中的默认值
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;

    if (url.pathname === '/') {
      return handleUI(request, apiKey);
    } else if (url.pathname.startsWith('/v1/')) {
      return handleApi(request, apiKey);
    } else {
      return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
    }
  }
};

// --- [第三部分: API 代理逻辑] ---

/**
 * 处理所有 /v1/ 路径下的 API 请求
 */
async function handleApi(request, apiKey) {
  if (request.method === 'OPTIONS') {
    return handleCorsPreflight();
  }

  const authHeader = request.headers.get('Authorization');
  if (apiKey && apiKey !== "1") {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return createErrorResponse('需要 Bearer Token 认证。', 401, 'unauthorized');
    }
    const token = authHeader.substring(7);
    if (token !== apiKey) {
      return createErrorResponse('无效的 API Key。', 403, 'invalid_api_key');
    }
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`API 路径不支持: ${url.pathname}`, 404, 'not_found');
  }
}

/**
 * 处理 /v1/models 请求
 */
async function handleModelsRequest() {
    const modelsData = {
        object: 'list',
        data: CONFIG.MODELS.map(modelId => ({
            id: modelId,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'flux-tools',
        })),
    };
    return new Response(JSON.stringify(modelsData), {
        headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
    });
}

/**
 * 处理 /v1/chat/completions 请求 (核心逻辑)
 */
async function handleChatCompletions(request, requestId) {
  try {
    const requestData = await request.json();
    const model = requestData.model || CONFIG.DEFAULT_MODEL;
    const messages = requestData.messages || [];
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage) {
        return createErrorResponse("消息列表为空", 400, "invalid_request");
    }

    let resultText = "";

    // 路由策略：根据模型选择不同的处理逻辑
    if (model === "flux-vision-pro") {
        // --- 图像反推模式 ---
        resultText = await handleImageToPrompt(lastMessage);
    } else {
        // --- 文本扩写模式 (默认) ---
        const userPrompt = extractTextContent(lastMessage.content);
        resultText = await handleTextToPrompt(userPrompt);
    }

    // 构造流式响应
    if (requestData.stream) {
        return createPseudoStreamResponse(resultText, model, requestId);
    } else {
        return createNonStreamResponse(resultText, model, requestId);
    }

  } catch (e) {
    console.error('处理请求时发生异常:', e);
    // 返回更详细的错误信息以便调试
    return createErrorResponse(`处理请求时发生内部错误: ${e.message}`, 500, 'internal_server_error');
  }
}

/**
 * 逻辑 A: 文本扩写 (Text-to-Prompt)
 */
async function handleTextToPrompt(prompt) {
    const payload = {
        prompt: prompt,
        language: "zh" // 默认中文，也可根据 prompt 检测
    };

    const response = await fetch(CONFIG.UPSTREAM_TEXT_API, {
        method: 'POST',
        headers: getCommonHeaders(),
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`上游文本接口错误: ${response.status}`);
    }

    const data = await response.json();
    // 上游返回格式: { status: 0, message: "ok", data: "..." }
    if (data.status !== 0 || !data.data) {
        throw new Error(`上游返回业务错误: ${JSON.stringify(data)}`);
    }

    return data.data;
}

/**
 * 逻辑 B: 图像反推 (Image-to-Prompt)
 * [v1.1.0 修复] 增加了对 Data URL 的支持，并修正了响应解析逻辑
 */
async function handleImageToPrompt(message) {
    // 1. 提取图片 URL
    let imageUrl = null;
    if (Array.isArray(message.content)) {
        const imgPart = message.content.find(p => p.type === 'image_url');
        if (imgPart) imageUrl = imgPart.image_url.url;
    }
    
    if (!imageUrl) {
        throw new Error("未在消息中找到图片 URL。请使用兼容 GPT-4-Vision 的格式发送图片。");
    }

    // 2. 获取图片 Blob (支持 http链接 和 data:base64)
    const imageBlob = await fetchImageBlob(imageUrl);

    // 3. 构造 Multipart 表单
    const formData = new FormData();
    formData.append('image', imageBlob, 'image.jpg');
    formData.append('language', 'zh');

    // 4. 发送请求
    const response = await fetch(CONFIG.UPSTREAM_IMAGE_API, {
        method: 'POST',
        headers: {
            'Origin': CONFIG.UPSTREAM_ORIGIN,
            'Referer': `${CONFIG.UPSTREAM_ORIGIN}/zh/image-to-prompt`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
        },
        body: formData
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`上游图像接口错误 (${response.status}): ${errText}`);
    }

    const data = await response.json();
    
    // [v1.1.0 关键修复] 兼容两种返回格式
    // 格式 1: { status: 0, data: "..." }
    // 格式 2: { description: "..." } (Cherry Studio 遇到的情况)
    
    if (data.description) {
        return data.description;
    }
    
    if (data.status === 0 && data.data) {
        return data.data;
    }

    throw new Error(`上游返回了无法识别的响应格式: ${JSON.stringify(data)}`);
}

// --- 辅助函数 ---

/**
 * 获取图片 Blob，支持 HTTP URL 和 Data URL
 */
async function fetchImageBlob(url) {
    if (url.startsWith('data:')) {
        // 处理 Base64 Data URL
        const arr = url.split(',');
        const mime = arr[0].match(/:(.*?);/)[1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
        }
        return new Blob([u8arr], { type: mime });
    } else {
        // 处理普通 HTTP URL
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`无法下载图片: ${url}`);
        return await resp.blob();
    }
}

function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(p => p.text || '').join('');
    }
    return "";
}

function getCommonHeaders() {
    return {
        'Content-Type': 'application/json',
        'Origin': CONFIG.UPSTREAM_ORIGIN,
        'Referer': `${CONFIG.UPSTREAM_ORIGIN}/zh/text-to-prompt`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
}

function createPseudoStreamResponse(fullText, model, requestId) {
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // 模拟打字机效果
    (async () => {
        const chunkSize = 5; // 每次发送的字符数
        for (let i = 0; i < fullText.length; i += chunkSize) {
            const chunkContent = fullText.slice(i, i + chunkSize);
            const chunk = {
                id: requestId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{ index: 0, delta: { content: chunkContent }, finish_reason: null }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            await new Promise(r => setTimeout(r, 20)); // 20ms 延迟
        }
        
        const finalChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
    })();

    return new Response(readable, {
        headers: corsHeaders({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        })
    });
}

function createNonStreamResponse(text, model, requestId) {
    const response = {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop"
        }],
        usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length }
    };
    return new Response(JSON.stringify(response), {
        headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
    });
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({ error: { message, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --text-sec: #888; --primary: #FFBF00; --accent: #007AFF; --err: #CF6679; --ok: #66BB6A; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; overflow: hidden; }
      .header { border-bottom: 1px solid var(--border); padding-bottom: 15px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; }
      h1 { margin: 0; font-size: 18px; } .ver { font-size: 12px; color: var(--text-sec); margin-left: 5px; }
      .box { background: #252525; padding: 12px; border-radius: 6px; margin-bottom: 15px; border: 1px solid var(--border); }
      .label { font-size: 12px; color: var(--text-sec); margin-bottom: 5px; display: block; }
      .val { font-family: monospace; color: var(--primary); word-break: break-all; cursor: pointer; }
      details { margin-top: 10px; } summary { cursor: pointer; font-weight: bold; margin-bottom: 5px; }
      .term { flex: 1; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; }
      .out { flex: 1; padding: 15px; overflow-y: auto; font-family: monospace; white-space: pre-wrap; line-height: 1.5; }
      .in-area { border-top: 1px solid var(--border); padding: 15px; display: flex; gap: 10px; flex-direction: column; }
      .controls { display: flex; gap: 10px; align-items: center; }
      textarea { flex: 1; background: #111; border: 1px solid var(--border); color: #fff; padding: 10px; border-radius: 4px; resize: none; min-height: 60px; }
      select { background: #333; color: #fff; border: 1px solid var(--border); padding: 8px; border-radius: 4px; flex: 1; }
      button { background: var(--primary); color: #000; border: none; padding: 0 20px; border-radius: 4px; font-weight: bold; cursor: pointer; height: 36px; }
      button:disabled { background: #555; cursor: not-allowed; }
      .icon-btn { background: #333; color: #fff; width: 36px; height: 36px; padding: 0; display: flex; align-items: center; justify-content: center; font-size: 18px; }
      .icon-btn:hover { background: #444; }
      .msg { margin-bottom: 10px; padding: 8px; border-radius: 4px; }
      .msg.user { background: #333; color: #fff; align-self: flex-end; }
      .msg.ai { background: #111; color: var(--text); border: 1px solid #333; }
      .msg.err { color: var(--err); }
      .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 5px; }
      .dot.ok { background: var(--ok); } .dot.chk { background: var(--primary); } .dot.err { background: var(--err); }
      
      /* 图片预览区 */
      .img-preview { display: flex; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
      .img-thumb { width: 60px; height: 60px; object-fit: cover; border-radius: 4px; border: 1px solid var(--primary); position: relative; }
      .img-thumb:hover { opacity: 0.8; }
      .hidden { display: none; }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="header">
            <h1>${CONFIG.PROJECT_NAME}<span class="ver">v${CONFIG.PROJECT_VERSION}</span></h1>
            <div id="status"><span class="dot chk"></span>检查中...</div>
        </div>
        
        <div class="box">
            <span class="label">API Endpoint</span>
            <div class="val" onclick="copy(this)">${origin}/v1/chat/completions</div>
        </div>
        <div class="box">
            <span class="label">API Key</span>
            <div class="val" onclick="copy(this)">${apiKey}</div>
        </div>

        <details open>
            <summary>🛠️ 功能说明</summary>
            <div style="font-size:13px; color:#ccc; line-height:1.6;">
                <p><strong>1. 文本扩写 (flux-prompt-pro)</strong><br>输入简单描述，生成 Flux 专用提示词。</p>
                <p><strong>2. 图像反推 (flux-vision-pro)</strong><br>上传图片，反推生成该图的提示词。</p>
            </div>
        </details>

        <details>
            <summary>💻 cURL 示例</summary>
            <div class="box" style="font-size:11px; overflow-x:auto;">
<pre style="margin:0">curl ${origin}/v1/chat/completions \
-H "Authorization: Bearer ${apiKey}" \
-H "Content-Type: application/json" \
-d '{
  "model": "flux-prompt-pro",
  "messages": [{"role":"user","content":"一只猫"}],
  "stream": true
}'</pre>
            </div>
        </details>
    </div>

    <div class="main">
        <div class="term">
            <div class="out" id="output">
                <div style="color:#666">终端就绪。请选择模式并输入内容...<br>提示：支持粘贴图片或点击回形针上传。</div>
            </div>
            <div class="in-area">
                <div class="img-preview" id="imgPreview"></div>
                <div class="controls">
                    <select id="model">
                        <option value="flux-prompt-pro">文本扩写 (Text-to-Prompt)</option>
                        <option value="flux-vision-pro">图像反推 (Image-to-Prompt)</option>
                    </select>
                    <input type="file" id="fileInput" accept="image/*" style="display:none">
                    <button class="icon-btn" id="uploadBtn" title="上传图片">📎</button>
                    <button id="sendBtn">发送指令</button>
                </div>
                <textarea id="input" placeholder="输入文本描述..."></textarea>
            </div>
        </div>
    </div>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        const output = document.getElementById('output');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('sendBtn');
        const uploadBtn = document.getElementById('uploadBtn');
        const fileInput = document.getElementById('fileInput');
        const imgPreview = document.getElementById('imgPreview');
        const modelSel = document.getElementById('model');
        const statusEl = document.getElementById('status');

        let currentImage = null; // Base64 string

        function copy(el) { navigator.clipboard.writeText(el.innerText); alert('已复制'); }
        function log(html, type='ai') {
            const d = document.createElement('div');
            d.className = 'msg ' + type;
            d.innerHTML = html;
            output.appendChild(d);
            output.scrollTop = output.scrollHeight;
            return d;
        }

        // 健康检查
        fetch('${origin}/v1/models', {headers:{'Authorization': 'Bearer '+API_KEY}})
            .then(r => r.ok ? statusEl.innerHTML='<span class="dot ok"></span>服务正常' : Promise.reject())
            .catch(() => statusEl.innerHTML='<span class="dot err"></span>服务异常');

        // 图片处理
        uploadBtn.onclick = () => fileInput.click();
        fileInput.onchange = (e) => handleFile(e.target.files[0]);
        
        // 粘贴图片支持
        document.onpaste = (e) => {
            const items = e.clipboardData.items;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf("image") !== -1) {
                    handleFile(items[i].getAsFile());
                }
            }
        };

        function handleFile(file) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                currentImage = e.target.result;
                imgPreview.innerHTML = \`<img src="\${currentImage}" class="img-thumb" onclick="this.remove(); currentImage=null;">\`;
                // 自动切换到 Vision 模型
                modelSel.value = "flux-vision-pro";
            };
            reader.readAsDataURL(file);
        }

        sendBtn.onclick = async () => {
            const text = input.value.trim();
            const model = modelSel.value;
            
            if (!text && !currentImage) return;
            
            input.value = '';
            sendBtn.disabled = true;
            
            // 显示用户消息
            let userHtml = text;
            if (currentImage) {
                userHtml += \`<br><img src="\${currentImage}" style="max-width:200px;border-radius:4px;margin-top:5px">\`;
            }
            log(userHtml, 'user');
            
            const aiMsg = log('Thinking...', 'ai');
            
            try {
                // 构造消息 Payload
                let content;
                if (currentImage) {
                    content = [
                        { type: "text", text: text || "Describe this image." },
                        { type: "image_url", image_url: { url: currentImage } }
                    ];
                    // 清除预览
                    imgPreview.innerHTML = '';
                    currentImage = null;
                } else {
                    content = text;
                }

                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + API_KEY
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [{role: 'user', content: content}],
                        stream: true
                    })
                });

                if (!res.ok) throw new Error((await res.json()).error?.message || 'Request failed');

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                aiMsg.innerText = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);
                            if (data === '[DONE]') break;
                            try {
                                const json = JSON.parse(data);
                                const delta = json.choices[0].delta.content;
                                if (delta) aiMsg.innerText += delta;
                            } catch (e) {}
                        }
                    }
                }
            } catch (e) {
                aiMsg.className += ' err';
                aiMsg.innerText = 'Error: ' + e.message;
            } finally {
                sendBtn.disabled = false;
            }
        };
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Encoding': 'br'
    },
  });
}
