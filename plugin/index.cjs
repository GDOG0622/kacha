'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');

const info = { id: 'kacha', name: '咔嚓', description: 'Image generation for SillyTavern' };
const maxImage = 8 * 1024 * 1024;
const maxReferences = 8;
const writes = new Map();

async function updateFile(file, fallback, update) {
    const next = (writes.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
        const value = update(await readJson(file, fallback));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await atomicWrite(file, JSON.stringify(value));
        return value;
    });
    writes.set(file, next);
    try {
        return await next;
    } finally {
        if (writes.get(file) === next) writes.delete(file);
    }
}

function imageBytes(value) {
    const match = typeof value === 'string' && value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length > Math.ceil(maxImage / 3) * 4) throw new Error('参考图格式或大小不支持');
    return { mime: 'image/' + match[1], bytes: Buffer.from(match[2], 'base64') };
}

async function atomicWrite(file, data) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
        await fs.writeFile(temporary, data, { mode: 0o600 });
        await fs.rename(temporary, file);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw error;
    }
}

async function fetchUpstream(url, options = {}) {
    const result = await fetch(url, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(120_000),
    });
    if (!result.ok) {
        await result.body?.cancel();
        throw new Error('服务返回 HTTP ' + result.status);
    }
    return result;
}

async function readLimited(response, limit) {
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
        total += chunk.length;
        if (total > limit) throw new Error('服务返回的数据过大');
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function apiBase(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('请输入有效的 API 基础地址');
    }
    return url.href.replace(/\/+$/, '');
}

function firstPng(zip) {
    const end = zip.lastIndexOf(Buffer.from('504b0506', 'hex'));
    if (end < 0 || end + 22 > zip.length) throw new Error('NovelAI 返回的压缩包无效');
    let entry = zip.readUInt32LE(end + 16);
    for (let count = zip.readUInt16LE(end + 10); count > 0 && entry + 46 <= end; count--) {
        if (zip.readUInt32LE(entry) !== 0x02014b50) break;
        const nameLength = zip.readUInt16LE(entry + 28);
        const name = zip.toString('utf8', entry + 46, entry + 46 + nameLength);
        if (name.toLowerCase().endsWith('.png')) {
            const local = zip.readUInt32LE(entry + 42);
            if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) break;
            const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
            const length = zip.readUInt32LE(entry + 20);
            const method = zip.readUInt16LE(entry + 10);
            if (start + length > zip.length || zip.readUInt32LE(entry + 24) > maxImage) break;
            const data = zip.subarray(start, start + length);
            if (method === 0) return data;
            if (method === 8) return inflateRawSync(data, { maxOutputLength: maxImage });
            break;
        }
        entry += 46 + nameLength + zip.readUInt16LE(entry + 30) + zip.readUInt16LE(entry + 32);
    }
    throw new Error('NovelAI 未返回可读取的 PNG');
}

async function generateNovel(key, prompt, references) {
    const parameters = {
        params_version: 3, width: 832, height: 1216, steps: 28, scale: 5,
        sampler: 'k_euler_ancestral', noise_schedule: 'native', n_samples: 1,
        seed: randomInt(0x100000000), negative_prompt: '', ucPreset: 0, qualityToggle: false,
        reference_image_multiple: references.map(image => image.bytes.toString('base64')),
        reference_information_extracted_multiple: references.map(() => 1),
        reference_strength_multiple: references.map(() => 0.6 / references.length),
    };
    const result = await fetchUpstream('https://image.novelai.net/ai/generate-image', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', model: 'nai-diffusion-3', input: prompt, parameters }),
    });
    return { mime: 'image/png', bytes: firstPng(await readLimited(result, maxImage + 1024 * 1024)) };
}

async function generateCustom(config, prompt, references) {
    const headers = { Authorization: 'Bearer ' + config.key };
    let endpoint = '/images/generations';
    let body = JSON.stringify({ model: config.model, prompt, n: 1 });
    if (references.length) {
        endpoint = '/images/edits';
        body = new FormData();
        body.set('model', config.model);
        body.set('prompt', prompt);
        for (const [index, image] of references.entries()) {
            body.append(references.length === 1 ? 'image' : 'image[]',
                new Blob([image.bytes], { type: image.mime }), 'reference-' + index + '.' + image.mime.split('/')[1]);
        }
    } else {
        headers['Content-Type'] = 'application/json';
    }
    const result = await fetchUpstream(config.url + endpoint, { method: 'POST', headers, body });
    const image = JSON.parse(await readLimited(result, maxImage * 2)).data?.[0];
    if (image?.b64_json) return imageBytes('data:image/png;base64,' + image.b64_json);
    if (image?.url) {
        const url = new URL(image.url);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('图片链接必须使用 HTTPS');
        const download = await fetchUpstream(url);
        const mime = download.headers.get('content-type')?.split(';')[0];
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('服务返回了不支持的图片格式');
        return { mime, bytes: await readLimited(download, maxImage) };
    }
    throw new Error('服务未返回图片');
}

function init(router) {
    // Custom upstream addresses are a server administrator capability.
    const route = (method, endpoint, handler, admin = false) => router[method](endpoint, async (req, res) => {
        const directories = req.user?.directories;
        if (!directories?.root || (admin && !req.user.profile?.admin)) {
            return res.status(403).json({ error: '此操作需要酒馆管理员权限' });
        }
        const dir = path.join(directories.root, 'kacha');
        res.set('Cache-Control', 'no-store');
        try {
            await handler(req, res, dir);
        } catch (error) {
            res.status(400).json({ error: error.code ? '无法读取或保存数据' : error.message });
        }
    });

    route('get', '/library', async (_req, res, dir) => {
        res.json(await readJson(path.join(dir, 'library.json'), { presets: [], looks: {} }));
    });
    route('put', '/library', async (req, res, dir) => {
        const { presets, looks, revision } = req.body ?? {};
        if (!Array.isArray(presets) || !looks || typeof looks !== 'object' || Array.isArray(looks)) {
            throw new Error('预设数据无效');
        }
        if (JSON.stringify({ presets, looks }).length > 40 * 1024 * 1024) throw new Error('预设库空间不足');
        for (const item of [...presets, ...Object.values(looks)]) {
            if (!item || typeof item.prompt !== 'string' || !Array.isArray(item.images) || item.images.length > maxReferences) {
                throw new Error('预设内容无效');
            }
            for (const image of item.images) imageBytes(image);
        }
        const saved = await updateFile(path.join(dir, 'library.json'), {}, current => {
            if (revision !== current.revision) throw new Error('预设库已在其他页面更新，请关闭并重新打开面板');
            return { presets, looks, revision: randomUUID() };
        });
        res.json(saved);
    });
    route('get', '/config', async (_req, res, dir) => {
        const config = await readJson(path.join(dir, 'config.json'), {});
        res.json({
            novelReady: Boolean(config.novel?.key),
            custom: { url: config.custom?.url, model: config.custom?.model, ready: Boolean(config.custom?.key) },
        });
    });
    route('put', '/novel', async (req, res, dir) => {
        const key = req.body?.key?.trim();
        if (!key) throw new Error('请输入 NovelAI Key');
        const file = path.join(dir, 'config.json');
        await updateFile(file, {}, config => ({ ...config, novel: { key } }));
        res.json({ ok: true });
    });
    route('post', '/models', async (req, res, dir) => {
        const config = await readJson(path.join(dir, 'config.json'), {});
        const url = apiBase(req.body?.url);
        const key = req.body?.key?.trim() || (url === config.custom?.url ? config.custom.key : '');
        if (!key) throw new Error('请输入 API Key');
        const result = await fetchUpstream(url + '/models', { headers: { Authorization: 'Bearer ' + key } });
        const data = JSON.parse(await readLimited(result, 4 * 1024 * 1024)).data;
        if (!Array.isArray(data)) throw new Error('服务未返回 OpenAI 兼容的模型列表');
        res.json({ models: [...new Set(data.map(item => item?.id).filter(id => typeof id === 'string' && id))] });
    }, true);
    route('put', '/custom', async (req, res, dir) => {
        const file = path.join(dir, 'config.json');
        const url = apiBase(req.body?.url);
        const model = req.body?.model?.trim();
        await updateFile(file, {}, config => {
            const key = req.body?.key?.trim() || (url === config.custom?.url ? config.custom.key : '');
            if (!key || !model) throw new Error('请连接服务并选择模型');
            return { ...config, custom: { url, key, model } };
        });
        res.json({ ok: true });
    }, true);
    route('post', '/generate', async (req, res, dir) => {
        const { service, prompt, images = [] } = req.body ?? {};
        if (!['novel', 'custom'].includes(service) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) {
            throw new Error('请输入有效的提示词');
        }
        if (service === 'custom' && !req.user.profile?.admin) throw new Error('自定义服务需要酒馆管理员权限');
        if (!Array.isArray(images) || images.length > maxReferences) throw new Error('最多同时使用 8 张参考图');
        const config = (await readJson(path.join(dir, 'config.json'), {}))[service];
        if (!config?.key) throw new Error('请先配置生图服务');
        const references = images.map(imageBytes);
        const image = service === 'novel'
            ? await generateNovel(config.key, prompt, references)
            : await generateCustom(config, prompt, references);
        res.json({ image: 'data:' + image.mime + ';base64,' + image.bytes.toString('base64') });
    });
}

module.exports = { init, info };
