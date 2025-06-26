import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 兼容 ES6 模块下的 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const maxBodySize = "30mb"; // 统一请求体大小限制（30MB）
const uploadDir = path.join(__dirname, "uploads");

// 确保上传目录存在
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// CORS 头部配置
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization",
  "Access-Control-Max-Age": "86400",
};

// 配置 multer 处理文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB 文件大小限制
});

// 全局中间件（按执行顺序排列）
app.use((req, res, next) => {
  res.set(corsHeaders);
  if (req.method === "OPTIONS") {
    return res.status(204).end(); // 处理预检请求
  }
  console.log("Request Method:", req.method);
  console.log("Request Path:", req.path);
  console.log("Content-Type:", req.headers["content-type"]);
  next();
});

// 先配置 body-parser（处理非文件上传的请求体）
app.use(bodyParser.json({ limit: maxBodySize })); // JSON 解析限制
app.use(bodyParser.urlencoded({ limit: maxBodySize, extended: true })); // URL 编码解析限制

// 静态资源服务，提供图片 URL 访问
app.use("/uploads", express.static(uploadDir));

// 全局错误处理中间件（增强错误类型判断）
app.use((err, req, res, next) => {
  // 处理 body-parser 的请求体过大错误（413）
  if (err instanceof bodyParser.HttpError && err.status === 413) {
    return res.status(413).json({ 
      error: "请求体过大，请确保文本/JSON数据不超过30MB。" 
    });
  }
  // 处理 multer 的文件过大错误（413）
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ 
      error: "文件大小超出限制，最大支持30MB。" 
    });
  }
  // 处理其他错误
  console.error("服务器错误:", err);
  res.status(500).json({ error: "服务器内部错误" });
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>COZE2OPENAI</title>
      </head>
      <body>
        <h1>Coze2OpenAI</h1>
        <p>支持文本和图片的AI服务</p>
      </body>
    </html>
  `);
});

app.post(
  "/v1/chat/completions",
  // 路由中间件：先判断是否为文件上传请求
  (req, res, next) => {
    if (req.headers["content-type"]?.includes("multipart/form-data")) {
      // 调用 multer 处理文件上传
      upload.single("image")(req, res, (err) => {
        if (err) {
          console.error("文件上传解析错误:", err);
          return res.status(400).json({ error: "图片解析失败，请检查文件格式。" });
        }
        next();
      });
    } else {
      next(); // 非文件请求直接通过
    }
  },
  async (req, res) => {
    // Bearer Token 检查
    const authHeader = req.headers["authorization"] || req.headers["Authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        code: 401,
        errmsg: "无效的认证格式，应为 'Bearer <token>'。",
      });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({
        code: 401,
        errmsg: "缺少认证令牌。",
      });
    }

    try {
      let data = req.body;
      let imageFile = req.file;

      // 处理 multipart/form-data 中的图片（生成 URL）
      if (imageFile) {
        const imageUrl = `${req.protocol}://${req.get("host")}/uploads/${path.basename(imageFile.path)}`;
        if (!data.messages) data.messages = [];
        data.messages.push({
          role: "user",
          content_type: "image",
          image_url: imageUrl,
          image_type: imageFile.mimetype,
        });
        // 删除临时文件
        fs.unlink(imageFile.path, (err) => {
          if (err) console.error("清理临时文件失败:", err);
        });
      }

      const messages = data.messages;
      const model = data.model;
      const user = data.user !== undefined ? data.user : "apiuser";
      const stream = data.stream !== undefined ? data.stream : false;

      // 解析消息历史
      const chatHistory = [];
      let hasImage = false;

      if (Array.isArray(messages) && messages.length > 0) {
        for (let i = 0; i < messages.length - 1; i++) {
          const message = messages[i];
          const role = message.role;

          if (!message.content_type || message.content_type === "text") {
            chatHistory.push({
              role: role,
              content: message.content,
              content_type: "text",
            });
          } else if (message.content_type === "image" && message.image_url) {
            chatHistory.push({
              role: role,
              content_type: "image",
              image: {
                url: message.image_url,
                type: message.image_type || "image/jpeg",
              },
            });
            hasImage = true;
          }
        }
      }

      // 处理当前查询消息
      const lastMessage = messages && messages.length > 0 ? messages[messages.length - 1] : {};
      let queryString = "";
      let queryObj = { content_type: "text", content: "" };

      if (lastMessage.content_type === "image" && lastMessage.image_url) {
        queryObj = {
          content_type: "image",
          image: {
            url: lastMessage.image_url,
            type: lastMessage.image_type || "image/jpeg",
          },
        };
        hasImage = true;
      } else {
        queryString = lastMessage.content;
        queryObj = {
          content_type: "text",
          content: queryString,
        };
      }

      // 构建 Coze API 请求体
      const bot_id = model && botConfig[model] ? botConfig[model] : default_bot_id;
      const requestBody = {
        user: user,
        bot_id: bot_id,
        chat_history: chatHistory,
        stream: stream,
      };

      if (hasImage) {
        requestBody.image = queryObj.image;
      } else {
        requestBody.query = queryString;
      }

      // 根据是否包含图片选择 API 端点
      let coze_api_url = `https://${coze_api_base}/v3/chat?`;
      if (hasImage) {
        coze_api_url = `https://${coze_api_base}/v3/vision/chat?`;
      }

      // 调用 Coze API
      const resp = await fetch(coze_api_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error("Coze API 错误:", resp.status, errorText);
        return res.status(500).json({ error: "Coze API 请求失败" });
      }

      // 处理流式响应
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Connection", "keep-alive");
        const reader = resp.body.getReader();
        let decoder = new TextDecoder();
        let buffer = "";

        async function readStream() {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
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
                  console.error("解析响应块失败:", error);
                  continue;
                }

                if (chunkObj.event === "message") {
                  if (
                    chunkObj.message.role === "assistant" &&
                    (chunkObj.message.type === "answer" || chunkObj.message.content_type === "image")
                  ) {
                    let chunkContent = chunkObj.message.content;
                    let chunkType = chunkObj.message.content_type || "text";

                    // 处理图片响应
                    if (chunkType === "image" && chunkObj.message.image) {
                      chunkContent = chunkObj.message.image.url;
                    }

                    if (chunkContent !== "") {
                      const chunkId = `chatcmpl-${Date.now()}`;
                      const chunkCreated = Math.floor(Date.now() / 1000);

                      let delta = { content: chunkContent };
                      if (chunkType === "image") {
                        delta = {
                          content: "[图片]",
                          image: {
                            url: chunkContent,
                            type: chunkObj.message.image.type || "image/jpeg",
                          },
                        };
                      }

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
                                delta: delta,
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
                } else if (chunkObj.event === "error") {
                  let errorMsg = chunkObj.code + " " + chunkObj.message;

                  if (chunkObj.error_information) {
                    errorMsg = chunkObj.error_information.err_msg;
                  }

                  console.error("Coze 响应错误:", errorMsg);

                  res.write(
                    `data: ${JSON.stringify({
                      error: {
                        message: errorMsg,
                        type: "server_error",
                      },
                    })}\n\n`
                  );
                  res.write("data: [DONE]\n\n");
                  res.end();
                }
              }
              buffer = lines[lines.length - 1];
            }
          } catch (err) {
            console.error("流式响应处理异常:", err);
            res.end();
          }
        }
        await readStream();
      }
      // 处理非流式响应
      else {
        resp
          .json()
          .then((cozeData) => {
            if (cozeData.code === 0 && cozeData.msg === "success") {
              const messages = cozeData.messages;
              const answerMessage = messages.find(
                (message) =>
                  message.role === "assistant" &&
                  (message.type === "answer" || message.content_type === "image")
              );

              if (answerMessage) {
                let result = answerMessage.content;
                let contentType = answerMessage.content_type || "text";

                if (contentType === "image" && answerMessage.image) {
                  result = {
                    content: "[图片]",
                    image: {
                      url: answerMessage.image.url,
                      type: answerMessage.image.type || "image/jpeg",
                    },
                  };
                }

                const usageData = {
                  prompt_tokens: 100,
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
                        content: contentType === "text" ? result : JSON.stringify(result),
                      },
                      logprobs: null,
                      finish_reason: "stop",
                    },
                  ],
                  usage: usageData,
                  system_fingerprint: "fp_2f57f81c11",
                };

                const jsonResponse = JSON.stringify(formattedResponse, null, 2);
                res.set("Content-Type", "application/json");
                res.send(jsonResponse);
              } else {
                res.status(500).json({ error: "未找到有效回答消息。" });
              }
            } else {
              console.error("Coze 响应错误:", cozeData.msg);
              res.status(500).json({
                error: {
                  message: cozeData.msg || "Coze API 响应异常",
                  type: "server_error",
                },
              });
            }
          })
          .catch((error) => {
            console.error("解析 JSON 响应失败:", error);
            res.status(500).json({ 
              error: "解析响应数据失败，请检查 Coze API 响应格式。" 
            });
          });
      }
    } catch (error) {
      console.error("处理请求时发生异常:", error);
      res.status(500).json({ error: "服务器内部处理错误" });
    }
  }
);

const coze_api_base = process.env.COZE_API_BASE || "api.coze.cn";
const default_bot_id = process.env.BOT_ID || "";
const botConfig = process.env.BOT_CONFIG ? JSON.parse(process.env.BOT_CONFIG) : {};

const port = parseInt(process.env.PORT, 10) || 3000;
const server = app.listen(port, function () {
  console.log(
    "服务已启动！监听端口: %s。示例访问地址: http://localhost:%s",
    port,
    port
  );
});

// 优雅关闭服务器
process.on("SIGINT", () => {
  console.log("收到关闭信号，正在优雅关闭服务器...");
  server.close(() => {
    console.log("服务器已安全关闭");
    process.exit(0);
  });
});
