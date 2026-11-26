const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Optional browser test dependency. */ }
const executablePath = process.env.KACHA_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

test('panels reload saved presets and looks across floors and devices', {
    skip: !chromium || !fs.existsSync(executablePath),
}, async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    const files = new Map();
    let failReads = false;
    let delayReads = false;
    const root = path.resolve(__dirname, '..');
    async function newDevice() {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.route('http://kacha.test/**', async route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<style>.kacha-camera{display:inline-block;width:20px;height:20px}</style><div id="chat"><div class="mes" mesid="0"><div class="mes_edit"></div></div><div class="mes" mesid="1"><div class="mes_edit"></div></div></div><script type="module" src="/index.js"></script>' });
            if (url.pathname === '/script.js') return route.fulfill({ contentType: 'application/javascript', body: "export const user_avatar='user.png'; export const generateRaw=()=>{}; export const getRequestHeaders=()=>({'Content-Type':'application/json'}); export const substituteParams=x=>x;" });
            if (url.pathname === '/scripts/extensions.js') return route.fulfill({ contentType: 'application/javascript', body: "export const extension_settings={}; export const getContext=()=>({chat:[{mes:'one'},{mes:'two'}],characters:[{avatar:'char.png',name:'Char'}],characterId:0,name1:'User'});" });
            if (url.pathname.startsWith('/user/files/')) {
                if (delayReads) await new Promise(resolve => setTimeout(resolve, 250));
                if (failReads) return route.fulfill({ status: 500 });
                const file = files.get(url.pathname.split('/').pop());
                return file ? route.fulfill({ contentType: 'application/json', body: file }) : route.fulfill({ status: 404 });
            }
            if (url.pathname === '/api/files/upload') {
                const body = request.postDataJSON();
                files.set(body.name, Buffer.from(body.data, 'base64').toString());
                return route.fulfill({ contentType: 'application/json', body: '{}' });
            }
            const file = path.join(root, url.pathname.slice(1));
            if (fs.existsSync(file)) return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(file) });
            return route.fulfill({ status: 404 });
        });
        await page.goto('http://kacha.test/');
        return { page, context };
    }
    try {
        const first = await newDevice();
        delayReads = true;
        await first.page.locator('.kacha-camera').first().click();
        await first.page.getByText('正在读取预设、样貌和 API 组合…').waitFor();
        assert.equal(await first.page.locator('.kacha main').evaluate(el => el.inert), true);
        await first.page.getByText('正在读取预设、样貌和 API 组合…').waitFor({ state: 'hidden' });
        delayReads = false;
        await first.page.locator('[data-tab="presets"]').click();
        await first.page.locator('#kacha-preset-name').fill('测试画风');
        await first.page.locator('#kacha-preset-prompt').fill('blue sky');
        await first.page.locator('#kacha-save-preset').click();
        await first.page.getByText('已保存', { exact: true }).waitFor();
        await first.page.locator('[data-tab="looks"]').click();
        await first.page.locator('#kacha-look-prompt').fill('黑发');
        await first.page.locator('#kacha-save-look').click();
        await first.page.getByText('已保存', { exact: true }).waitFor();
        await first.page.locator('[data-tab="settings"]').click();
        await first.page.locator('#kacha-profile-name').fill('测试 API');
        await first.page.locator('#kacha-settings-service').selectOption('novel');
        await first.page.locator('#kacha-novel-key').fill('test-key');
        await first.page.locator('#kacha-save-profile').click();
        await first.page.getByText('已保存', { exact: true }).waitFor();
        await first.page.locator('[data-close]').click();
        await first.page.locator('.kacha-camera').nth(1).click();
        await first.page.getByText('正在读取预设、样貌和 API 组合…').waitFor({ state: 'hidden' });
        assert.equal(await first.page.locator('#kacha-preset option').count(), 2);
        const second = await newDevice();
        await second.page.locator('.kacha-camera').first().click();
        await second.page.getByText('正在读取预设、样貌和 API 组合…').waitFor({ state: 'hidden' });
        assert.equal(await second.page.locator('#kacha-preset option').count(), 2);
        assert.equal(await second.page.locator('#kacha-service option').first().textContent(), '测试 API');
        await second.page.locator('[data-tab="looks"]').click();
        assert.equal(await second.page.locator('#kacha-look-prompt').inputValue(), '黑发');
        await second.page.locator('[data-close]').click();
        failReads = true;
        await second.page.locator('.kacha-camera').first().click();
        await second.page.locator('#kacha-retry').waitFor({ state: 'visible' });
        assert.equal(await second.page.locator('.kacha main').evaluate(el => el.inert), true);
        failReads = false;
        await second.page.locator('#kacha-retry').click();
        await second.page.locator('#kacha-retry').waitFor({ state: 'hidden' });
        assert.equal(await second.page.locator('#kacha-preset option').count(), 2);
        await first.context.close();
        await second.context.close();
    } finally {
        await browser.close();
    }
});
