import { expect, test } from '@playwright/test';

test.skip(process.env.BANK_E2E_LIVE!=="1", "Live bank consent is explicitly opt-in.");

// Opt-in only: a real bank grants access. Never automate credentials or consent.
test('real bank consent returns to the app with an active owned connection',async({page})=>{
 test.skip(process.env.BANK_E2E_LIVE!=='1','Live bank consent is explicitly opt-in.');
 const email=process.env.BANK_E2E_EMAIL, password=process.env.BANK_E2E_PASSWORD;
 expect(process.env.PLAYWRIGHT_BASE_URL,'Use an already configured application server').toBeTruthy();
 expect(email,'Dedicated bank-test account required').toBeTruthy();expect(password).toBeTruthy();
 await page.goto('/login');
 await page.locator('input[name=email]').fill(email!);await page.locator('input[name=password]').fill(password!);
 await page.locator('button[type=submit]').click();await page.waitForURL('**/dashboard');
 const beforeResponse=await page.request.get('/api/bank/connections');expect(beforeResponse.ok()).toBe(true);
 const before=await beforeResponse.json();
 test.skip(!before.enabled||!before.ready,'Real Enable Banking configuration is not ready.');
 const ids=new Set(before.connections.map((c:{id:string})=>c.id));
 await page.goto('/kirjanpito/pankkitilit?connect=1');await expect(page.getByRole('dialog')).toBeVisible();
 // In the Inspector, choose the bank and approve in its own site. Resume
 // only after the bank redirects back. No passwords are recorded by this suite.
 await page.pause();
 await page.waitForURL('**/kirjanpito/pankkitilit*');
 await expect.poll(async()=>{
  const response=await page.request.get('/api/bank/connections');if(!response.ok())return false;
  const data=await response.json();
  return data.connections.some((c:{id:string;status:string;accounts:unknown[]})=>!ids.has(c.id)&&c.status==='active'&&c.accounts.length>0);
 },{timeout:60_000}).toBe(true);
});
