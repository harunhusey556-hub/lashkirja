const req = fetch('http://localhost:3000/api/ai/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Cookie': 'session=dummy'
  },
  body: JSON.stringify({ message: "Mikä on ripsienpidennysten ALV-kanta?" })
}).then(res => res.text().then(text => console.log('STATUS:', res.status, 'BODY:', text))).catch(console.error);
