export const novelModels = [
    ['nai-diffusion-3', 'Anime V3'],
    ['nai-diffusion-furry-3', 'Furry V3'],
    ['nai-diffusion-4-full', 'V4 Full'],
    ['nai-diffusion-4-curated-preview', 'V4 Curated'],
    ['nai-diffusion-4-5-full', 'V4.5 Full'],
    ['nai-diffusion-4-5-curated', 'V4.5 Curated'],
    ['nai-diffusion-5-full', 'V5 Full'],
    ['nai-diffusion-5-curated', 'V5 Curated'],
];

const novelBase = 'https://image.novelai.net/ai';
const maxImage = 8 * 1024 * 1024;
const vibes = new Map();

export function apiBase(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('请输入有效的 API 基础地址');
    }
    return url.href.replace(/\/+$/, '');
}

export function toBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
}

function fileData(image) {
    const [header, data] = image.split(',');
    return { mime: header.slice(5, -7), data };
}

async function request(url, options = {}) {
    let response;
    try {
        response = await fetch(url, {
            ...options, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(120000),
        });
    } catch (error) {
        if (error.name === 'TimeoutError') throw new Error('生图服务请求超时');
        throw new Error('无法连接服务，请检查地址、网络及服务的跨域设置');
    }
    if (!response.ok) throw new Error('服务返回 HTTP ' + response.status);
    return response;
}

function authorization(key) {
    return { Authorization: 'Bearer ' + key };
}

function jsonRequest(url, key, payload) {
    return request(url, {
        method: 'POST',
        headers: { ...authorization(key), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

export async function listModels(url, key) {
    const response = await request(url + '/models', { headers: authorization(key) });
    const { data } = await response.json();
    if (!Array.isArray(data)) throw new Error('服务未返回 OpenAI 兼容的模型列表');
    return [...new Set(data.map(item => item?.id).filter(id => typeof id === 'string' && id))];
}

export async function generateCustom({ url, model, key }, prompt, images) {
    if (!url || !model || !key) throw new Error('请先连接自定义服务并选择模型');
    let response;
    if (images.length) {
        const body = new FormData();
        body.set('model', model);
        body.set('prompt', prompt);
        for (const [index, image] of images.entries()) {
            const { mime, data } = fileData(image);
            const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
            body.append(images.length === 1 ? 'image' : 'image[]',
                new Blob([bytes], { type: mime }), 'reference-' + index + '.' + mime.split('/')[1]);
        }
        response = await request(url + '/images/edits', { method: 'POST', headers: authorization(key), body });
    } else {
        response = await jsonRequest(url + '/images/generations', key, { model, prompt, n: 1 });
    }
    const image = (await response.json()).data?.[0];
    if (image?.b64_json) return 'data:image/png;base64,' + image.b64_json;
    if (!image?.url) throw new Error('服务未返回图片');
    const link = new URL(image.url);
    if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password) throw new Error('服务返回的图片地址无效');
    const download = await request(link.href);
    const blob = await download.blob();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || blob.size > maxImage) {
        throw new Error('服务返回的图片格式或大小不支持');
    }
    return 'data:' + blob.type + ';base64,' + toBase64(new Uint8Array(await blob.arrayBuffer()));
}

async function pngFromZip(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const from = Math.max(0, bytes.length - 65557);
    let end = bytes.length - 22;
    while (end >= from && (view.getUint32(end, true) !== 0x06054b50
        || end + 22 + view.getUint16(end + 20, true) !== bytes.length)) end--;
    if (end < from) throw new Error('NovelAI 返回的压缩包无效');
    let entry = view.getUint32(end + 16, true);
    for (let count = view.getUint16(end + 10, true); count > 0 && entry + 46 <= end; count--) {
        if (view.getUint32(entry, true) !== 0x02014b50) break;
        const nameLength = view.getUint16(entry + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(entry + 46, entry + 46 + nameLength));
        if (name.toLowerCase().endsWith('.png')) {
            const local = view.getUint32(entry + 42, true);
            const size = view.getUint32(entry + 24, true);
            if (local + 30 > entry || view.getUint32(local, true) !== 0x04034b50 || size > maxImage) break;
            const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
            const length = view.getUint32(entry + 20, true);
            if (start + length > entry) break;
            const data = bytes.subarray(start, start + length);
            const method = view.getUint16(entry + 10, true);
            if (method === 0 && size === data.length) return data;
            if (method !== 8) break;
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            const reader = stream.getReader();
            const result = new Uint8Array(size);
            let offset = 0;
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (offset + value.length > size) {
                    await reader.cancel();
                    throw new Error('NovelAI 返回的图片大小无效');
                }
                result.set(value, offset);
                offset += value.length;
            }
            if (offset === size) return result;
            break;
        }
        entry += 46 + nameLength + view.getUint16(entry + 30, true) + view.getUint16(entry + 32, true);
    }
    throw new Error('NovelAI 未返回可读取的 PNG');
}

async function encodeVibe(key, model, image) {
    const cacheKey = model + ':' + image;
    if (vibes.has(cacheKey)) return vibes.get(cacheKey);
    const response = await jsonRequest(novelBase + '/encode-vibe', key, {
        model, image: fileData(image).data, information_extracted: 1,
    });
    const encoded = toBase64(new Uint8Array(await response.arrayBuffer()));
    if (!encoded) throw new Error('NovelAI 未返回参考图编码');
    if (vibes.size >= 16) vibes.delete(vibes.keys().next().value);
    vibes.set(cacheKey, encoded);
    return encoded;
}

export async function generateNovel({ key, model }, prompt, images) {
    if (!key) throw new Error('请先保存 NovelAI Key');
    const v5 = model.startsWith('nai-diffusion-5-');
    const modern = v5 || model.startsWith('nai-diffusion-4');
    const references = [];
    for (const image of images) {
        references.push(modern ? await encodeVibe(key, model, image) : fileData(image).data);
    }
    const parameters = {
        params_version: v5 ? 4 : 3,
        width: 832, height: 1216, steps: 28, scale: 5,
        sampler: 'k_euler_ancestral', noise_schedule: v5 ? 'karras' : 'native',
        n_samples: 1, seed: crypto.getRandomValues(new Uint32Array(1))[0],
        negative_prompt: '', ucPreset: 0, qualityToggle: false,
        reference_image_multiple: references,
        reference_information_extracted_multiple: references.map(() => 1),
        reference_strength_multiple: references.map(() => 0.6 / references.length),
    };
    if (modern) {
        parameters.v4_prompt = { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true };
        parameters.v4_negative_prompt = { caption: { base_caption: '', char_captions: [] } };
        parameters.characterPrompts = [];
    }
    const response = await jsonRequest(novelBase + '/generate-image', key, { action: 'generate', model, input: prompt, parameters });
    const result = await pngFromZip(await response.arrayBuffer());
    return 'data:image/png;base64,' + toBase64(result);
}
