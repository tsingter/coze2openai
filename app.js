const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const { AbortController } = require('abort-controller');

const app = express();
const PORT = 3000;

// Ensure the 'uploads' directory exists
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);


// --- Multer Configuration ---
// Configure multer storage engine and upload directory
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir); // Ensure this directory exists and is writable
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// Create the upload middleware with corrected limits
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB file size limit
    fields: 10,                 // Max number of non-file fields
    files: 1                    // MODIFICATION: Corrected 'fileCount' to 'files' for max file count
  }
});


// --- Middleware Configuration ---
// MODIFICATION: Replaced deprecated `body-parser` with modern Express built-in middleware.
// This is the primary fix for the "PayloadTooLargeError" as these parsers
// handle content types more gracefully and avoid conflicts with multer.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files to allow access to uploaded images
app.use('/uploads', express.static(uploadsDir));


// --- Non-Streaming Chat Endpoint ---
app.post('/v1/chat/completions', upload.single('image'), async (req, res) => {
  console.log('Received request for /v1/chat/completions');

  try {
    // Validate Authorization header
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('Invalid authorization format');
      return res.status(401).json({ error: 'Invalid authorization format. Expected: Bearer <token>' });
    }
    const token = authHeader.split(' ')[1];

    // Validate file upload
    if (!req.file) {
      console.log('No image file was uploaded');
      return res.status(400).json({ error: 'No image file was uploaded' });
    }
    console.log('Uploaded file:', req.file.originalname, `(${req.file.size} bytes)`);

    // Construct the image URL
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    console.log('Generated image URL:', imageUrl);

    // Build the request body for Coze v3 API
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

    console.log('Calling Coze v3 API...');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30-second timeout

    try {
      // Call Coze v3 API
      const cozeResponse = await fetch('https://api.coze.cn/v3/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      console.log('Coze API response status:', cozeResponse.status);
      if (!cozeResponse.ok) {
        const errorBody = await cozeResponse.text();
        console.error('Coze API returned an error:', errorBody);
        return res.status(cozeResponse.status).json({
          error: 'Coze API call failed',
          details: errorBody
        });
      }

      // Process and return response
      const responseData = await cozeResponse.json();
      console.log('Successfully received response from Coze API.');
      res.json(responseData);

    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('Coze API request timed out');
        return res.status(504).json({ error: 'Coze API request timed out' });
      }
      console.error('Exception while calling Coze API:', error);
      return res.status(500).json({
        error: 'Failed to call Coze API',
        details: error.message
      });
    } finally {
      clearTimeout(timeoutId);
      // Asynchronously delete the temporary file after response is sent
      try {
        await fs.unlink(req.file.path);
        console.log('Deleted temporary file:', req.file.path);
      } catch (err) {
        console.error('Failed to delete temporary file:', err);
      }
    }

  } catch (error) {
    console.error('An exception occurred while processing the request:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      details: error.message
    });
  }
});


// --- Streaming Chat Endpoint (with fixes) ---
app.post('/v3/chat/stream', upload.single('image'), async (req, res) => {
    console.log('Received request for /v3/chat/stream');

    // FIX: This entire block of logic was missing from the stream route.
    // It is required to authenticate, process the file, and build the request.
    let tempFilePath = null;
    try {
        const authHeader = req.headers['authorization'] || req.headers['Authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('Invalid authorization format');
            return res.status(401).json({ error: 'Invalid authorization format. Expected: Bearer <token>' });
        }
        const token = authHeader.split(' ')[1];

        if (!req.file) {
            console.log('No image file was uploaded');
            return res.status(400).json({ error: 'No image file was uploaded' });
        }
        tempFilePath = req.file.path; // Store path for cleanup
        console.log('Uploaded file:', req.file.originalname, `(${req.file.size} bytes)`);
        
        const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        console.log('Generated image URL:', imageUrl);

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
            stream: true // Enable streaming
        };
        // END OF FIXED BLOCK

        console.log('Calling Coze v3 Stream API...');
        const cozeStreamResponse = await fetch('https://api.coze.cn/v3/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!cozeStreamResponse.ok) {
            const errorBody = await cozeStreamResponse.text();
            console.error('Coze Stream API returned an error:', errorBody);
            res.status(cozeStreamResponse.status).json({ error: 'Coze API call failed', details: errorBody });
            return;
        }

        // Set headers for Server-Sent Events (SSE)
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Pipe the response from Coze directly to the client
        cozeStreamResponse.body.pipe(res);

        // FIX: Added cleanup for the uploaded file on stream completion.
        req.on('close', async () => {
            console.log('Client disconnected, cleaning up resources for stream.');
            if (tempFilePath) {
                try {
                    await fs.unlink(tempFilePath);
                    console.log('Deleted temporary file for stream:', tempFilePath);
                } catch (err) {
                    console.error('Failed to delete temporary file for stream:', err);
                }
            }
        });

    } catch (error) {
        console.error('An exception occurred while processing the stream request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Internal Server Error',
                details: error.message
            });
        } else {
            res.end();
        }
        // Cleanup file on error as well
        if (tempFilePath) {
            try {
                await fs.unlink(tempFilePath);
                console.log('Deleted temporary file after stream error:', tempFilePath);
            } catch (err) {
                console.error('Failed to delete temporary file after stream error:', err);
            }
        }
    }
});


// Start the server
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
