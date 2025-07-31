const { chromium, devices } = require('playwright');
      (async () => {
        const preset = "Desktop Chrome";
        const url = "https://translate.google.com/";
        const dev = devices[preset];
        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext(dev ? { ...dev } : {});
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(12000);
        await context.tracing.stop({ path: "tests/sessions/1753927438951/trace.zip" });
        await browser.close();
      })().catch(e => { console.error(e); process.exit(1); });
      