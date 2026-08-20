import http from 'http';

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/ai/chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const req = http.request(options, res => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => console.log('STATUS:', res.statusCode, 'BODY:', data));
});
req.on('error', e => console.error(e));
req.write(JSON.stringify({ message: "Mikä on ripsienpidennysten ALV-kanta?" }));
req.end();
