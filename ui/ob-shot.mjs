import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
	executablePath: '/usr/bin/google-chrome',
	headless: 'new',
	args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=2']
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 800 });

await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.removeItem('token-horizon.onboarded'));
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1200));

const clickButton = async (label) => {
	const ok = await page.evaluate((text) => {
		const btn = [...document.querySelectorAll('.ob-card button')].find(
			(b) => b.textContent.trim() === text && !b.disabled
		);
		if (btn) { btn.click(); return true; }
		return false;
	}, label);
	if (!ok) throw new Error(`button not found/disabled: ${label}`);
	await new Promise((r) => setTimeout(r, 450));
};

await page.screenshot({ path: '/tmp/ob-step0.png' });
await clickButton('Set up');
await page.screenshot({ path: '/tmp/ob-step1.png' });
await clickButton('Continue');
await page.screenshot({ path: '/tmp/ob-step2.png' });
await clickButton('Continue');
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: '/tmp/ob-step3.png' });

await browser.close();
console.log('screenshots written');
