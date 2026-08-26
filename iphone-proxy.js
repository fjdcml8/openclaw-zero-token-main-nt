/**
 * iPhone 快捷指令代理服务器
 * 将 HTTP 请求转发到 Gateway WebSocket
 * 
 * 启动: node iphone-proxy.js
 * 访问: http://你的电脑IP:9999/chat?q=你好
 */

import { WebSocket } from 'ws';
import http from 'http';
import url from 'url';

const GATEWAY_URL = 'ws://localhost:3000';
const PORT = 9999;

let ws = null;
let messageQueue = [];
let pendingRequests = {};
let requestId = 0;

function connectGateway() {
  ws = new WebSocket(GATEWAY_URL);

  ws.on('open', () => {
    console.log('✅ 已连接到 Gateway');
    // 发送队列中的消息
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      ws.send(JSON.stringify(msg));
    }
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('📩 收到:', msg);
      
      // 如果是响应，返回给等待的 HTTP 请求
      if (msg.type === 'response' && msg.id && pendingRequests[msg.id]) {
        const res = pendingRequests[msg.id];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(msg));
        delete pendingRequests[msg.id];
      }
    } catch (e) {
      console.error('解析消息失败:', e);
    }
  });

  ws.on('close', () => {
    console.log('⚠️ Gateway 断开，5秒后重连...');
    setTimeout(connectGateway, 5000);
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket 错误:', err.message);
  });
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  
  // CORS 头（允许快捷指令访问）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 心跳检测
  if (parsed.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ws: ws ? ws.readyState === 1 : false }));
    return;
  }

  // 聊天接口
  if (parsed.pathname === '/chat' && req.method === 'GET') {
    const q = parsed.query.q || parsed.query.query || '';
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请提供 q 参数，如 ?q=你好' }));
      return;
    }

    if (!ws || ws.readyState !== 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gateway 未连接，请先启动 Gateway' }));
      return;
    }

    const id = ++requestId;
    pendingRequests[id] = res;

    const msg = {
      id: String(id),
      type: 'request',
      method: 'chat',
      params: {
        messages: [{ role: 'user', content: q }],
        stream: false
      }
    };

    ws.send(JSON.stringify(msg));
    console.log(`📤 发送请求 #${id}: ${q.slice(0, 30)}...`);

    // 超时处理
    setTimeout(() => {
      if (pendingRequests[id]) {
        const res = pendingRequests[id];
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求超时' }));
        delete pendingRequests[id];
      }
    }, 30000);
    return;
  }

  // POST 方式（更灵活）
  if (parsed.pathname === '/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const q = data.q || data.query || data.message || '';
        if (!q) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '请提供 q 参数' }));
          return;
        }
        // 复用上面的逻辑
        if (!ws || ws.readyState !== 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Gateway 未连接' }));
          return;
        }
        const id = ++requestId;
        pendingRequests[id] = res;
        const msg = {
          id: String(id),
          type: 'request',
          method: 'chat',
          params: {
            messages: [{ role: 'user', content: q }],
            stream: false
          }
        };
        ws.send(JSON.stringify(msg));
        console.log(`📤 POST 请求 #${id}: ${q.slice(0, 30)}...`);
        setTimeout(() => {
          if (pendingRequests[id]) {
            const res = pendingRequests[id];
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '请求超时' }));
            delete pendingRequests[id];
          }
        }, 30000);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'JSON 格式错误' }));
      }
    });
    return;
  }

  // 首页
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <h1>📱 iPhone 快捷指令代理</h1>
    <p>状态: ${ws && ws.readyState === 1 ? '✅ 已连接 Gateway' : '❌ 未连接'}</p>
    <p>使用方法:</p>
    <pre>
      GET http://localhost:9999/chat?q=你好
      POST http://localhost:9999/chat  { "q": "你好" }
    </pre>
  `);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════╗
║  📱 iPhone 快捷指令代理已启动        ║
║  端口: ${PORT}                         ║
║  地址: http://0.0.0.0:${PORT}/chat     ║
║  状态: 等待连接 Gateway...            ║
╚═══════════════════════════════════════╝
  `);
  connectGateway();
});
