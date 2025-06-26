const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

// 确保上传目录存在
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true })
  .then(() => console.log(`上传目录已创建: ${uploadsDir}`))
  .catch(err => console.error(`创建上传目录失败: ${err.message}`));

// 配置日志
app.use(morgan('dev')); // 记录基本请求信息

// 自定义中间件：记录完整请求信息
app.use((req, res, next) => {
  const requestId = uuidv4(); // 生成唯一请求ID
  req.requestId = requestId;
  
  console.log(`[${requestId}] 收到请求: ${req.method} ${req.url}`);
  console.log(`[${requestId}] 请求来源: ${req.ip}`);
  console.log(`[${requestId}] 请求头:`, req.headers);
  
  // 记录请求体（非文件部分）
  if (req.method === 'POST' || req.method === 'PUT') {
    console.log(`[${requestId}] 请求体类型: ${req.headers['content-type'] || '未知'}`);
    
    // 对于非文件请求，记录请求体内容
    if (!req.headers['content-type']?.startsWith('multipart/form-data')) {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const jsonBody = JSON.parse(body);
          console.log(`[${requestId}] 请求体内容:`, jsonBody);
        } catch (e) {
          console.log(`[${requestId}] 请求体内容:`, body);
        }
      });
    }
  }
  
  // 记录响应完成事件
  res.on('finish', () => {
    console.log(`[${requestId}] 响应完成: ${res.statusCode} ${res.statusMessage}`);
  });
  
  next();
});

// --- Multer 配置 ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    console.log(`[${req.requestId}] 文件存储目录: ${uploadsDir}`);
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const filename = `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`;
    console.log(`[${req.requestId}] 生成文件名: ${filename}`);
    cb(null, filename);
  }
});

// 创建上传中间件
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB 文件大小限制
    fields: 10,                 // 最大非文件字段数
    files: 1                    // 最大文件数
  },
  fileFilter: (req, file, cb) => {
    console.log(`[${req.requestId}] 文件筛选: ${file.originalname} (${file.mimetype})`);
    
    // 允许的文件类型
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      console.log(`[${req.requestId}] 文件类型允许: ${file.mimetype}`);
      cb(null, true);
    } else {
      console.log(`[${req.requestId}] 文件类型拒绝: ${file.mimetype}`);
      cb(new Error('文件类型不支持。允许的类型: jpeg, png, gif'));
    }
  }
});

// 仅对需要文件上传的路由使用 multer
app.post('/v1/chat/completions', upload.single('image'), async (req, res) => {
  console.log(`[${req.requestId}] 开始处理 /v1/chat/completions 请求`);
  
  try {
    // 验证授权头
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log(`[${req.requestId}] 授权格式无效`);
      return res.status(401).json({ error: '授权格式无效。预期: Bearer <token>' });
    }
    const token = authHeader.split(' ')[1];
    console.log(`[${req.requestId}] 授权验证通过`);
    
    // 验证文件上传
    if (!req.file) {
      console.log(`[${req.requestId}] 未上传图片文件`);
      return res.status(400).json({ error: '未上传图片文件' });
    }
    
    console.log(`[${req.requestId}] 上传的文件: ${req.file.originalname} (${req.file.size} 字节)`);
    console.log(`[${req.requestId}] 文件路径: ${req.file.path}`);
    console.log(`[${req.requestId}] 文件类型: ${req.file.mimetype}`);
    
    // 构建图片URL
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    console.log(`[${req.requestId}] 生成的图片URL: ${imageUrl}`);
    
    // 构建请求体
    const requestBody = {
      model: 'coze-8b',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请分析这张图片' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ],
      temperature: 0.7,
      stream: false
    };
    
    console.log(`[${req.requestId}] 调用 Coze v3 API...`);
    console.log(`[${req.requestId}] API 请求体:`, requestBody);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时
    
    try {
      // 调用 Coze API
      const cozeResponse = await fetch('https://api.coze.cn/v3/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      
      console.log(`[${req.requestId}] Coze API 响应状态: ${cozeResponse.status}`);
      
      if (!cozeResponse.ok) {
        const errorBody = await cozeResponse.text();
        console.error(`[${req.requestId}] Coze API 返回错误: ${errorBody}`);
        return res.status(cozeResponse.status).json({
          error: 'Coze API 调用失败',
          details: errorBody
        });
      }
      
      // 处理并返回响应
      const responseData = await cozeResponse.json();
      console.log(`[${req.requestId}] 成功从 Coze API 接收响应`);
      console.log(`[${req.requestId}] API 响应内容:`, responseData);
      
      res.json(responseData);
      
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(`[${req.requestId}] Coze API 请求超时`);
        return res.status(504).json({ error: 'Coze API 请求超时' });
      }
      console.error(`[${req.requestId}] 调用 Coze API 时发生异常:`, error);
      return res.status(500).json({
        error: '调用 Coze API 失败',
        details: error.message
      });
    } finally {
      clearTimeout(timeoutId);
      
      // 异步删除临时文件
      try {
        await fs.unlink(req.file.path);
        console.log(`[${req.requestId}] 删除临时文件: ${req.file.path}`);
      } catch (err) {
        console.error(`[${req.requestId}] 删除临时文件失败:`, err);
      }
    }
    
  } catch (error) {
    console.error(`[${req.requestId}] 处理请求时发生异常:`, error);
    res.status(500).json({
      error: '内部服务器错误',
      details: error.message
    });
  }
});

// --- 流式聊天端点 ---
app.post('/v3/chat/stream', upload.single('image'), async (req, res) => {
  console.log(`[${req.requestId}] 开始处理 /v3/chat/stream 请求`);
  
  try {
    // 身份验证和文件处理
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log(`[${req.requestId}] 授权格式无效`);
      return res.status(401).json({ error: '授权格式无效。预期: Bearer <token>' });
    }
    const token = authHeader.split(' ')[1];
    console.log(`[${req.requestId}] 授权验证通过`);
    
    if (!req.file) {
      console.log(`[${req.requestId}] 未上传图片文件`);
      return res.status(400).json({ error: '未上传图片文件' });
    }
    
    console.log(`[${req.requestId}] 上传的文件: ${req.file.originalname} (${req.file.size} 字节)`);
    console.log(`[${req.requestId}] 文件路径: ${req.file.path}`);
    console.log(`[${req.requestId}] 文件类型: ${req.file.mimetype}`);
    
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    console.log(`[${req.requestId}] 生成的图片URL: ${imageUrl}`);
    
    // 构建请求体
    const requestBody = {
      model: 'coze-8b',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请分析这张图片' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ],
      temperature: 0.7,
      stream: true // 启用流式响应
    };
    
    console.log(`[${req.requestId}] 调用 Coze v3 流式 API...`);
    console.log(`[${req.requestId}] API 请求体:`, requestBody);
    
    const cozeResponse = await fetch('https://api.coze.cn/v3/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!cozeResponse.ok) {
      const errorBody = await cozeResponse.text();
      console.error(`[${req.requestId}] Coze 流式 API 返回错误:`, errorBody);
      res.status(cozeResponse.status).json({ error: 'Coze API 调用失败', details: errorBody });
      return;
    }
    
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    console.log(`[${req.requestId}] 开始流式响应`);
    
    // 管道流式响应到客户端
    cozeResponse.body.on('data', chunk => {
      console.log(`[${req.requestId}] 流式数据块: ${chunk.toString().substring(0, 100)}...`);
      res.write(chunk);
    });
    
    cozeResponse.body.on('end', () => {
      console.log(`[${req.requestId}] 流式响应完成`);
      res.end();
    });
    
    cozeResponse.body.on('error', error => {
      console.error(`[${req.requestId}] 流式响应错误:`, error);
      res.end();
    });
    
    // 客户端断开连接时清理资源
    req.on('close', async () => {
      console.log(`[${req.requestId}] 客户端断开连接，清理资源`);
      
      try {
        await fs.unlink(req.file.path);
        console.log(`[${req.requestId}] 删除流式请求的临时文件: ${req.file.path}`);
      } catch (err) {
        console.error(`[${req.requestId}] 删除流式请求的临时文件失败:`, err);
      }
    });
    
  } catch (error) {
    console.error(`[${req.requestId}] 处理流式请求时发生异常:`, error);
    
    if (!res.headersSent) {
      res.status(500).json({
        error: '内部服务器错误',
        details: error.message
      });
    } else {
      res.end();
    }
    
    // 出错时清理文件
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
        console.log(`[${req.requestId}] 错误发生后删除临时文件: ${req.file.path}`);
      } catch (err) {
        console.error(`[${req.requestId}] 错误发生后删除临时文件失败:`, err);
      }
    }
  }
});

// 静态文件服务，用于访问上传的图片
app.use('/uploads', express.static(uploadsDir));

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error(`[${req.requestId}] 全局错误处理:`, err);
  
  // 处理 Multer 错误
  if (err instanceof multer.MulterError) {
    console.log(`[${req.requestId}] Multer 错误: ${err.message}`);
    return res.status(400).json({ error: `文件上传错误: ${err.message}` });
  }
  
  res.status(500).json({ error: '内部服务器错误', details: err.message });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`上传目录: ${uploadsDir}`);
});
