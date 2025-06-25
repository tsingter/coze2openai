import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import multer from "multer";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(bodyParser.json());
const coze_api_base = process.env.COZE_API_BASE || "api.coze.cn";
const default_bot_id = process.env.BOT_ID || "";
const botConfig = process.env.BOT_CONFIG ? JSON.parse(process.env.BOT_CONFIG) : {};
const uploadDir = path.join(__dirname, "uploads");

// 确保上传目录存在
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB 限制
});

var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization",
  "Access-Control-Max-Age": "86400",
};

app.use((req, res, next) => {
  res.set(corsHeaders);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  console.log("Request Method:", req.method);
  console.log("Request Path:", req.path);
  
  // 处理 multipart/form-data 请求
  if (req.path === "/v1/chat/completions" && 
      req.headers["content-type"]?.includes("multipart/form-data")) {
    upload.single("image")(req, res, function(err) {
      if (err) {
        console.error("文件上传错误:", err);
        return res.status(400).json({ error: "图片解析失败" });
      }
      next();
    });
  } else {
    next();
  }
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

app.post("/v1/chat/completions", async (req, res) => {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      code: 401,
      errmsg: "Invalid authorization format. Expected 'Bearer <token>'.",
    });
  }
  
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({
      code: 401,
      errmsg: "Missing token.",
    });
  }
  
  try {
    let data = req.body;
    let imageFile = req.file;
    
    // 处理 multipart/form-data 中的图片 (直接获取base64数据，不再进行编码)
    if (imageFile) {
      // 直接从文件读取base64数据（假设已预先处理）
      const base64Data = fs.readFileSync(imageFile.path, "base64");
      fs.unlinkSync(imageFile.path); // 清理临时文件
      
      if (!data.messages) data.messages = [];
      data.messages.push({
        role: "user",
        content_type: "image",
        image_data: base64Data,
        image_type: imageFile.mimetype
      });
    }
    
    const messages = data.messages;
    const model = data.model;
    const user = data.user !== undefined ? data.user : "apiuser";
    const stream = data.stream !== undefined ? data.stream : false;
    
    // 解析消息历史，支持文本和图片
    const chatHistory = [];
    let hasImage = false;
    
    for (let i = 0; i < messages.length - 1; i++) {
      const message = messages[i];
      const role = message.role;
      
      // 处理文本消息
      if (!message.content_type || message.content_type === "text") {
        chatHistory.push({
          role: role,
          content: message.content,
          content_type: "text"
        });
      } 
      // 处理图片消息（直接使用已有的image_data）
      else if (message.content_type === "image" && message.image_data) {
        chatHistory.push({
          role: role,
          content_type: "image",
          image: {
            data: message.image_data,
            type: message.image_type || "image/jpeg"
          }
        });
        hasImage = true;
      }
    }
    
    // 处理当前查询消息
    const lastMessage = messages[messages.length - 1];
    let queryString = "";
    let queryObj = { content_type: "text", content: "" };
    
    if (lastMessage.content_type === "image" && lastMessage.image_data) {
      queryObj = {
        content_type: "image",
        image: {
          data: lastMessage.image_data,
          type: lastMessage.image_type || "image/jpeg"
        }
      };
      hasImage = true;
    } else {
      queryString = lastMessage.content;
      queryObj = {
        content_type: "text",
        content: queryString
      };
    }
    
    // 构建 Coze API 请求体
    const bot_id = model && botConfig[model] ? botConfig[model] : default_bot_id;
    const requestBody = {
      user: user,
      bot_id: bot_id,
      chat_history: chatHistory,
      stream: stream
    };
    
    // 根据消息类型添加查询内容
    if (hasImage) {
      // 直接传递image对象，包含已处理的base64数据
      requestBody.image = queryObj.image;
    } else {
      requestBody.query = queryString;
    }
    
    // 根据是否包含图片选择不同的 API 端点
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
      const streamData = resp.body;
      let buffer = "";

      streamData.on("data", (chunk) => {
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
            console.error("Error parsing chunk:", error);
            continue;
          }
          
          if (chunkObj.event === "message") {
            if (
              chunkObj.message.role === "assistant" &&
              (chunkObj.message.type === "answer" || chunkObj.message.content_type === "image")
            ) {
              let chunkContent = chunkObj.message.content;
              let chunkType = chunkObj.message.content_type || "text";
              
              // 处理图片响应（直接使用返回的image数据）
              if (chunkType === "image" && chunkObj.message.image) {
                chunkContent = chunkObj.message.image.data;
              }
              
              if (chunkContent !== "") {
                const chunkId = `chatcmpl-${Date.now()}`;
                const chunkCreated = Math.floor(Date.now() / 1000);
                
                // 根据内容类型返回不同格式
                let delta = { content: chunkContent };
                if (chunkType === "image") {
                  delta = {
                    content: "[图片]",
                    image: {
                      data: chunkContent,
                      type: chunkObj.message.image.type || "image/jpeg"
                    }
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

            if(chunkObj.error_information) {
              errorMsg = chunkObj.error_information.err_msg;
            }

            console.error('Error: ', errorMsg);

            res.write(
              `data: ${JSON.stringify({ error: {
                  error: "Unexpected response from Coze API.",
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
    } 
    // 处理非流式响应
    else {
      resp
        .json()
        .then((data) => {
          if (data.code === 0 && data.msg === "success") {
            const messages = data.messages;
            const answerMessage = messages.find(
              (message) =>
                message.role === "assistant" && 
                (message.type === "answer" || message.content_type === "image")
            );

            if (answerMessage) {
              let result = answerMessage.content;
              let contentType = answerMessage.content_type || "text";
              
              // 处理图片响应（直接使用返回的image数据）
              if (contentType === "image" && answerMessage.image) {
                result = {
                  content: "[图片]",
                  image: {
                    data: answerMessage.image.data,
                    type: answerMessage.image.type || "image/jpeg"
                  }
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
                      content: contentType === "text" ? result : JSON.stringify(result)
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
              res.status(500).json({ error: "No answer message found." });
            }
          } else {
            console.error("Error:", data.msg);
            res
              .status(500)
              .json({ error: {
                    error: "Unexpected response from Coze API.",
                    message: data.msg
                }
              });
          }
        })
        .catch((error) => {
          console.error("Error parsing JSON:", error);
          res.status(500).json({ error: "Error parsing JSON response." });
        });
    }
  } catch (error) {
    console.error("处理请求时出错:", error);
    res.status(500).json({ error: "服务器内部错误" });
  }
});

const server = app.listen(process.env.PORT || 3000, function () {
  let port = server.address().port;
  console.log('Ready! Listening all IP, port: %s. Example: at http://localhost:%s', port, port);
});

// 优雅关闭服务器
process.on('SIGINT', () => {
  console.log('收到关闭信号，正在优雅关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});
