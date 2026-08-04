import { extractReceipt } from '../src/lib/ai';

async function run() {
  console.log("Testing Pb lashlift kuitti.pdf...");
  try {
    const res1 = await extractReceipt('../data/Pb lashlift kuitti.pdf', 'application/pdf');
    console.log('PDF 1:', res1);
  } catch (e) { console.error('PDF 1 failed:', e); }

  console.log("Testing Lasku varma työeläke.HEIC...");
  try {
    const res2 = await extractReceipt('../data/Lasku varma työeläke.HEIC', 'image/heic');
    console.log('HEIC:', res2);
  } catch (e) { console.error('HEIC failed:', e); }
}

run();
