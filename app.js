import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
// 新增依赖：用于处理 multipart/form-data 文件上传
import FormData from 'form-data';
import { Buffer } from 'buffer';

dotenv.config();

const app = express();
// 【重要】增加请求体大小限制，以支持 base64 编码的图片上传
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

const coze_api_base = process.env.COZE_API_BASE || "api.coze.cn";
const default_bot_id = process.env.BOT_ID || "";
const botConfig = process.env.BOT_CONFIG ? JSON.parse(process.env.BOT_CONFIG) : {};

// CORS 跨域配置
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization",
  "Access-Control-Max-Age": "86400",
};

app.use((req, res, next) => {
  res.set(corsHeaders);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  console.log('Request Method:', req.method);
  console.log('Request Path:', req.path);
  next();
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>COZE2OPENAI</title>
      </head>
      <body>
        <h1>Coze2OpenAI</h1>
        <p>Congratulations! Your project has been successfully deployed and now supports vision capabilities.</p>
      </body>
    </html>
  `);
});

/**
 * 【新增】上传图片到 Coze 并返回 file_id 的辅助函数
 * @param {string} imageUrl - base64 格式的图片数据 URL (e.g., "data:image/jpeg;base64,...")
 * @param {string} token - Coze API 的 Bearer Token
 * @param {string} cozeApiBase - Coze API 的基础 URL
 * @returns {Promise<string>} - 返回上传成功后的 file_id
 */
async function uploadImageToCoze(imageUrl, token, cozeApiBase) {
  // 1. 从 data URL 中解析出 MIME 类型和 base64 数据
  const match = imageUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!match) {
    throw new Error('无效的 image_url 格式。需要一个 data URL。');
  }
  const mimeType = match[1];
  const base64Data = match[2];

  // 2. 将 base64 字符串转换为 Buffer
  const imageBuffer = Buffer.from(base64Data, 'base64');

  // 3. 创建 FormData 对象并添加文件
  const form = new FormData();
  form.append('file', imageBuffer, {
    filename: `upload.${mimeType.split('/')[1]}`, // 提供一个文件名，例如 'upload.jpeg'
    contentType: mimeType,
  });

  // 4. 发起文件上传请求
  const uploadUrl = `https://${cozeApiBase}/v1/files/upload`;
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${token}`,
    },
    body: form,
  });

  const result = await response.json();

  // 5. 检查响应并返回 file_id
  if (response.ok && result.code === 0 && result.data && result.data.id) {
    console.log(`File uploaded successfully. File ID: ${result.data.id}`);
    return result.data.id;
  } else {
    console.error('Coze 文件上传失败:', result);
    throw new Error(result.msg || '上传文件到 Coze 失败。');
  }
}


app.post("/v1/chat/completions", async (req, res) => {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      code: 401,
      errmsg: "无效的认证格式，请使用 'Bearer <token>'.",
    });
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({
      code: 401,
      errmsg: "缺少 token.",
    });
  }

  try {
    const data = req.body;
    const messages = data.messages;
    const model = data.model;
    const user = data.user !== undefined ? data.user : "apiuser";
    const stream = data.stream !== undefined ? data.stream : false;

    // 1. 处理聊天历史记录 (除最后一条消息外)
    const chatHistory = [];
    // 注意：为简化起见，此处假设历史记录中不包含图片。
    // 如果需要支持历史记录中的图片，需要进行更复杂的处理。
    for (let i = 0; i < messages.length - 1; i++) {
        const message = messages[i];
        if (typeof message.content === 'string') {
            chatHistory.push({
                role: message.role,
                content: message.content,
                content_type: "text"
            });
        }
    }

    // 2. 【核心改造】处理最后一条消息，可能包含文本和图片
    let queryString = "";
    let file_ids = [];
    const lastMessage = messages[messages.length - 1];

    if (typeof lastMessage.content === 'string') {
      // 传统的纯文本消息
      queryString = lastMessage.content;
    } else if (Array.isArray(lastMessage.content)) {
      // OpenAI Vision 格式的多部分消息
      for (const part of lastMessage.content) {
        if (part.type === 'text') {
          queryString = part.text;
        } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
          try {
            // 上传图片并收集 file_id
            const fileId = await uploadImageToCoze(part.image_url.url, token, coze_api_base);
            file_ids.push(fileId);
          } catch (uploadError) {
            console.error("图片上传失败:", uploadError);
            return res.status(500).json({
              code: 500,
              errmsg: "上传图片到 Coze 失败: " + uploadError.message,
            });
          }
        }
      }
    }

    // 3. 构造 Coze API 请求体
    const bot_id = model && botConfig[model] ? botConfig[model] : default_bot_id;
    let requestBody = {
      query: queryString,
      stream: stream,
      conversation_id: "", // 可根据需要管理会话 ID
      user: user,
      bot_id: bot_id,
      chat_history: chatHistory
    };
    
    // 如果有上传的图片，则添加 attachments 字段
    if (file_ids.length > 0) {
      requestBody.attachments = file_ids.map(id => ({ type: 'image', file_id: id }));
    }

    // Coze API URL
    const coze_api_url = `https://${coze_api_base}/v3/chat`;
    const resp = await fetch(coze_api_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    });

    // 4. 处理 Coze API 的响应 (流式或非流式)，这部分逻辑保持不变
    if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        const responseStream = resp.body;
        let buffer = "";

        responseStream.on("data", (chunk) => {
            buffer += chunk.toString();
            let lines = buffer.split("\n");

            for (let i = 0; i < lines.length - 1; i++) {
                let line = lines[i].trim();

                if (!line.startsWith("data:")) continue;
                line = line.slice(5).trim();
                let chunkObj;
                try {
                    if (line.startsWith("{")) {
                        chunkObj = JSON.parse(line);
                    } else {
                        continue;
                    }
                } catch (error) {
                    console.error("解析数据块时出错:", error);
                    continue;
                }
                if (chunkObj.event === "message") {
                    if (
                        chunkObj.message.role === "assistant" &&
                        chunkObj.message.type === "answer"
                    ) {
                        let chunkContent = chunkObj.message.content;

                        if (chunkContent !== "") {
                            const chunkId = `chatcmpl-${Date.now()}`;
                            const chunkCreated = Math.floor(Date.now() / 1000);
                            res.write(
                                "data: " +
                                JSON.stringify({
                                    id: chunkId,
                                    object: "chat.completion.chunk",
                                    created: chunkCreated,
                                    model: data.model,
                                    choices: [
                                        {
                                            index: 0,
                                            delta: {
                                                content: chunkContent,
                                            },
                                            finish_reason: null,
                                        },
                                    ],
                                }) +
                                "\n\n"
                            );
                        }
                    }
                } else if (chunkObj.event === "done") {
                    const chunkId = `chatcmpl-${Date.now()}`;
                    const chunkCreated = Math.floor(Date.now() / 1000);
                    res.write(
                        "data: " +
                        JSON.stringify({
                            id: chunkId,
                            object: "chat.completion.chunk",
                            created: chunkCreated,
                            model: data.model,
                            choices: [
                                {
                                    index: 0,
                                    delta: {},
                                    finish_reason: "stop",
                                },
                            ],
                        }) +
                        "\n\n"
                    );
                    res.write("data: [DONE]\n\n");
                    res.end();
                } else if (chunkObj.event === "ping") {
                    // Ping event, do nothing
                } else if (chunkObj.event === "error") {
                    let errorMsg = chunkObj.code + " " + chunkObj.message;

                    if (chunkObj.error_information) {
                        errorMsg = chunkObj.error_information.err_msg;
                    }
                    console.error('Coze 流式 API 错误: ', errorMsg);
                    res.write(
                        `data: ${JSON.stringify({
                            error: {
                                error: "来自 Coze API 的意外响应。",
                                message: errorMsg
                            }
                        })}\n\n`
                    );
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
            }
            buffer = lines[lines.length - 1];
        });
        responseStream.on('end', () => {
            res.end();
        });
        responseStream.on('error', (err) => {
            console.error('响应流错误:', err);
            res.status(500).end();
        });
    } else {
      resp
        .json()
        .then((cozeData) => {
          if (cozeData.code === 0 && cozeData.msg === "success") {
            const messages = cozeData.messages;
            const answerMessage = messages.find(
              (message) =>
                message.role === "assistant" && message.type === "answer"
            );

            if (answerMessage) {
              const result = answerMessage.content.trim();
              const usageData = {
                prompt_tokens: 100, // 伪造的 token 计数
                completion_tokens: 10,
                total_tokens: 110,
              };
              const chunkId = `chatcmpl-${Date.now()}`;
              const chunkCreated = Math.floor(Date.now() / 1000);

              const formattedResponse = {
                id: chunkId,
                object: "chat.completion",
                created: chunkCreated,
                model: req.body.model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: result,
                    },
                    logprobs: null,
                    finish_reason: "stop",
                  },
                ],
                usage: usageData,
                system_fingerprint: "fp_2f57f81c11",
              };
              res.set("Content-Type", "application/json");
              res.send(JSON.stringify(formattedResponse, null, 2));
            } else {
              res.status(500).json({ error: "未找到 answer 类型的消息。" });
            }
          } else {
            console.error("Coze API 错误:", cozeData.msg);
            res
              .status(500)
              .json({ error: {
                error: "来自 Coze API 的意外响应。",
                message: cozeData.msg
              }});
          }
        })
        .catch((error) => {
          console.error("解析 JSON 时出错:", error);
          res.status(500).json({ error: "解析 JSON 响应时出错。" });
        });
    }
  } catch (error) {
    console.error("服务器内部错误:", error);
    res.status(500).json({
        code: 500,
        errmsg: "服务器内部错误: " + error.message,
    });
  }
});

const server = app.listen(process.env.PORT || 3000, function () {
  let port = server.address().port
  console.log('服务已启动! 正在监听所有 IP, 端口: %s. 示例: http://localhost:%s', port, port)
});
