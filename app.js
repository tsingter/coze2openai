const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = 3000;

// 配置multer存储引擎和上传目录
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // 确保此目录存在且可写
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// 创建上传中间件
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB限制
    fields: 10, // 限制表单字段数量
    fileCount: 1 // 限制文件数量
  }
});

// 解析JSON请求体（增加大小限制）
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// 静态文件服务，用于访问上传的图片
app.use('/uploads', express.static('uploads'));

// 处理聊天完成请求 - Coze v3 版本
app.post('/v1/chat/completions', upload.single('image'), async (req, res) => {
  console.log('收到请求:', req.method, req.path);
  
  try {
    // 验证请求头中的Authorization字段
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('无效的认证格式');
      return res.status(401).json({ error: '无效的认证格式' });
    }
    
    // 提取token
    const token = authHeader.split(' ')[1];
    console.log('提取的token:', token.slice(0, 10) + '...');
    
    // 验证文件上传
    if (!req.file) {
      console.log('未上传图片文件');
      return res.status(400).json({ error: '未上传图片文件' });
    }
    
    console.log('上传的文件:', req.file.originalname, req.file.size, '字节');
    
    // 构建图片URL
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    console.log('生成的图片URL:', imageUrl);
    
    // 构建符合Coze v3的请求体
    const requestBody = {
      model: 'coze-8b', // 使用Coze v3推荐的模型
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请分析这张图片' },
            { type: 'image_url', image_url: { url: imageUrl } } // Coze v3格式
          ]
        }
      ],
      temperature: 0.7,
      stream: false // 暂时禁用流式响应，简化处理
    };
    
    console.log('准备调用Coze v3 API...');
    
    // 设置请求超时（30秒）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    try {
      // 调用Coze v3 API
      const cozeResponse = await fetch('https://api.coze.cn/v3/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      
      console.log('Coze API响应状态:', cozeResponse.status);
      
      if (!cozeResponse.ok) {
        const errorBody = await cozeResponse.text();
        console.error('Coze API返回错误:', errorBody);
        return res.status(cozeResponse.status).json({ 
          error: 'Coze API调用失败',
          details: errorBody
        });
      }
      
      // 处理Coze v3响应
      const responseData = await cozeResponse.json();
      console.log('成功获取Coze API响应');
      
      // 异步删除临时文件（不影响响应返回）
      setTimeout(async () => {
        try {
          await fs.unlink(req.file.path);
          console.log('已删除临时文件:', req.file.path);
        } catch (err) {
          console.error('删除临时文件失败:', err);
        }
      }, 30000); // 30秒后删除
      
      // 返回Coze API响应
      res.json({
        // 转换为OpenAI兼容格式（如果需要）
        id: responseData.id || 'coze-chat-' + Date.now(),
        object: 'chat.completion',
        model: responseData.model,
        choices: responseData.choices || [{
          message: {
            role: 'assistant',
            content: responseData.content || 'No response'
          }
        }]
      });
      
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('Coze API请求超时');
        return res.status(504).json({ error: 'Coze API请求超时' });
      }
      
      console.error('调用Coze API时发生异常:', error);
      return res.status(500).json({ 
        error: '调用Coze API失败',
        details: error.message
      });
    } finally {
      clearTimeout(timeoutId);
    }
    
  } catch (error) {
    console.error('处理请求时发生异常:', error);
    res.status(500).json({ 
      error: '服务器内部错误',
      details: error.message
    });
  }
});

// 流式响应版本的接口（可选）
app.post('/v3/chat/stream', upload.single('image'), async (req, res) => {
  console.log('收到流式请求:', req.method, req.path);
  
  try {
    // 验证请求头和文件（代码与上面相同，此处省略）
    // ...
    
    // 设置响应头为流式
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    // 构建带stream=true的请求体
    const streamRequestBody = { ...requestBody, stream: true };
    
    // 调用Coze v3流式API
    const cozeStreamResponse = await fetch('https://api.coze.cn/v3/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(streamRequestBody)
    });
    
    if (!cozeStreamResponse.ok) {
      const errorBody = await cozeStreamResponse.text();
      console.error('Coze API返回错误:', errorBody);
      res.write(`data: ${JSON.stringify({ error: 'Coze API调用失败', details: errorBody })}\n\n`);
      return res.end();
    }
    
    // 处理流式响应
    const reader = cozeStreamResponse.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        console.log('流式响应结束');
        res.write('data: [DONE]\n\n');
        res.end();
        break;
      }
      
      // 解码并转发数据
      const chunk = decoder.decode(value);
      res.write(chunk);
    }
    
  } catch (error) {
    console.error('处理流式请求时发生异常:', error);
    res.write(`data: ${JSON.stringify({ error: '服务器内部错误', details: error.message })}\n\n`);
    res.end();
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
