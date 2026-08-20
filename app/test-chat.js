import http from 'http';

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/ai/chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Cookie': 'session=' + process.env.TEST_SESSION_COOKIE // we need a valid cookie
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('STATUS:', res.statusCode, 'BODY:', data));
});
req.write(JSON.stringify({ message: "Mikä on ripsienpidennysten ALV-kanta?" }));
req.end();
