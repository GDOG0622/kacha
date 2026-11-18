import { generateRaw, getRequestHeaders, user_avatar } from '/script.js';
import { getContext } from '/scripts/extensions.js';

import { apiBase, generateCustom, generateNovel, listModels, novelModels, toBase64 } from './providers.js';

const libraryFile = 'kacha-library-v1.json';
const configKey = 'kacha:service-config:v1';
const defaultNovelModel = 'nai-diffusion-3';
const historyKey = 'kacha:images:v1';
const servicesKey = 'kacha:service';
const validImage = value => typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
const newId = () => globalThis.crypto.randomUUID?.() ?? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
const dialog = document.createElement('dialog');
dialog.className = 'kacha';
dialog.setAttribute('aria-label', '咔嚓');
dialog.innerHTML = `
    <header class="kacha-row">
        <strong>咔嚓</strong>
        <nav aria-label="咔嚓">
            <button type="button" data-tab="generate">生图</button>
            <button type="button" data-tab="presets">预设</button>
            <button type="button" data-tab="looks">样貌</button>
            <button type="button" data-tab="history">记录</button>
            <button type="button" data-tab="settings">设置</button>
        </nav>
        <button type="button" data-close aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
    </header>
    <main>
        <section data-view="generate">
            <div class="kacha-row">
                <select id="kacha-service" aria-label="服务"><option value="custom">自定义</option><option value="novel">NovelAI</option></select>
                <select id="kacha-preset" aria-label="预设"></select>
            </div>
            <textarea id="kacha-prompt" placeholder="提示词" aria-label="提示词"></textarea>
            <div data-images="draft"></div>
            <div class="kacha-row kacha-toggles">
                <label><input type="checkbox" id="kacha-floor">参考本楼层</label>
                <label><input type="checkbox" id="kacha-char">Char</label>
                <label><input type="checkbox" id="kacha-user">User</label>
                <button type="button" id="kacha-generate">生成</button>
            </div>
            <div id="kacha-result"></div>
        </section>
        <section data-view="presets" hidden>
            <div class="kacha-row">
                <select id="kacha-edit-preset" aria-label="编辑预设"></select>
                <button type="button" id="kacha-import">导入</button>
                <input type="file" id="kacha-import-file" accept=".json,application/json" hidden>
            </div>
            <input id="kacha-preset-name" placeholder="预设名称" aria-label="预设名称" maxlength="80">
            <textarea id="kacha-preset-prompt" placeholder="提示词" aria-label="预设提示词"></textarea>
            <div data-images="preset"></div>
            <div class="kacha-row">
                <button type="button" id="kacha-save-preset">保存</button>
                <button type="button" id="kacha-export">导出</button>
                <button type="button" id="kacha-delete-preset">删除</button>
            </div>
        </section>
        <section data-view="looks" hidden>
            <select id="kacha-look-type" aria-label="样貌对象"><option value="char">Char</option><option value="user">User</option></select>
            <div id="kacha-look-name"></div>
            <textarea id="kacha-look-prompt" placeholder="样貌描述" aria-label="样貌描述"></textarea>
            <div data-images="look"></div>
            <button type="button" id="kacha-save-look">保存</button>
        </section>
        <section data-view="history" hidden><div id="kacha-history"></div></section>
        <section data-view="settings" hidden>
            <select id="kacha-settings-service" aria-label="配置服务"><option value="custom">自定义</option><option value="novel">NovelAI</option></select>
            <form id="kacha-custom">
                <label>API URL<input id="kacha-url" type="url" placeholder="https://example.com/v1" required></label>
                <label>API Key<input id="kacha-key" type="password" autocomplete="off"></label>
                <div class="kacha-row"><button type="submit">连接</button><select id="kacha-model" aria-label="模型" disabled></select></div>
            </form>
            <form id="kacha-novel" hidden>
                <label>NovelAI Key<input id="kacha-novel-key" type="password" autocomplete="off"></label>
                <div class="kacha-row">
                    <select id="kacha-novel-model" aria-label="NovelAI 模型"></select>
                    <button type="submit">保存</button>
                </div>
            </form>
        </section>
    </main>
    <footer id="kacha-status" role="status"></footer>`;
const $ = selector => dialog.querySelector(selector);
const images = { draft: [], preset: [], look: [] };
let library = { presets: [], looks: {} };
let libraryReady = false;
let config = {};
let target = {};
let activeTab;
let connected;
let generationId = 0;

function loadConfig() {
    try {
        return JSON.parse(localStorage.getItem(configKey)) || {};
    } catch {
        return {};
    }
}

function saveConfig(service, value) {
    const next = { ...loadConfig(), [service]: value };
    try {
        localStorage.setItem(configKey, JSON.stringify(next));
    } catch {
        throw new Error('浏览器无法保存服务设置');
    }
    config = next;
}

async function loadLibrary() {
    const response = await fetch('/user/files/' + libraryFile, { cache: 'no-store' });
    if (response.status === 404) return { presets: [], looks: {} };
    if (!response.ok) throw new Error('无法读取酒馆预设库');
    const data = await response.json();
    if (!Array.isArray(data?.presets) || !data.looks || typeof data.looks !== 'object') throw new Error('酒馆预设库格式有误');
    return data;
}

function status(message = '') {
    $('#kacha-status').textContent = message;
}

function tab(name) {
    activeTab = name;
    for (const section of dialog.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== name;
    for (const button of dialog.querySelectorAll('[data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === name));
    status();
    if (name === 'history') showHistory();
}

function withAction(element, eventName, action) {
    element.addEventListener(eventName, async event => {
        if (eventName === 'submit') event.preventDefault();
        if (element.dataset.busy) return;
        element.dataset.busy = 'true';
        if (element instanceof HTMLButtonElement) element.disabled = true;
        status();
        try {
            await action(event);
        } catch (error) {
            status(error.message);
        } finally {
            delete element.dataset.busy;
            if (element instanceof HTMLButtonElement) element.disabled = false;
        }
    });
}

function setOptions(select, choices, placeholder, selected) {
    select.replaceChildren(new Option(placeholder, ''), ...choices.map(({ id, name }) => new Option(name, id)));
    select.value = selected || '';
    if (select.selectedIndex < 0) select.selectedIndex = 0;
}

function renderPresets(selected = '') {
    const preset = $('#kacha-preset');
    setOptions(preset, library.presets, '预设', preset.value);
    const editor = $('#kacha-edit-preset');
    setOptions(editor, library.presets, '新建预设', selected);
    editPreset();
}

function editPreset() {
    const preset = library.presets.find(item => item.id === $('#kacha-edit-preset').value);
    $('#kacha-preset-name').value = preset?.name || '';
    $('#kacha-preset-prompt').value = preset?.prompt || '';
    images.preset = [...(preset?.images || [])];
    $('#kacha-export').disabled = $('#kacha-delete-preset').disabled = !preset;
    renderImages('preset');
}

function lookKey(type) {
    const id = target[type]?.id;
    return id ? type + ':' + id : null;
}

function renderLook() {
    const type = $('#kacha-look-type').value;
    const key = lookKey(type);
    const look = library.looks[key];
    $('#kacha-look-name').textContent = target[type]?.name || '当前没有可用对象';
    $('#kacha-look-prompt').value = look?.prompt || '';
    $('#kacha-save-look').disabled = !key;
    images.look = [...(look?.images || [])];
    renderImages('look');
}

const viewer = document.createElement('dialog');
viewer.className = 'kacha kacha-viewer';
viewer.setAttribute('aria-label', '图片预览');
const zoomed = document.createElement('img');
zoomed.alt = '图片预览';
viewer.append(zoomed);
viewer.addEventListener('click', () => viewer.close());
viewer.addEventListener('close', () => zoomed.removeAttribute('src'));
function preview(src) {
    zoomed.src = src;
    viewer.showModal();
}

function thumbnail(src, onDelete) {
    const wrap = document.createElement('div');
    wrap.className = 'kacha-thumb';
    const button = document.createElement('button');
    button.type = 'button';
    button.title = '查看图片';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '查看图片';
    button.append(img);
    button.addEventListener('click', () => preview(src));
    wrap.append(button);
    if (onDelete) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'kacha-remove';
        remove.setAttribute('aria-label', '移除图片');
        remove.textContent = '×';
        remove.addEventListener('click', onDelete);
        wrap.append(remove);
    }
    return wrap;
}

async function addImages(kind, files) {
    if (images[kind].length + files.length > 8) throw new Error('最多添加 8 张参考图');
    const added = await Promise.all(files.map(file => new Promise((resolve, reject) => {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
            reject(new Error('请选择 8 MB 以内的 PNG、JPEG 或 WebP 图片'));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
    })));
    if (images[kind].length + added.length > 8) throw new Error('最多添加 8 张参考图');
    images[kind].push(...added);
    renderImages(kind);
}

function renderImages(kind) {
    const wrap = $('[data-images="' + kind + '"]');
    wrap.className = 'kacha-images';
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '＋ 参考图';
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/png,image/jpeg,image/webp';
    input.hidden = true;
    add.addEventListener('click', () => input.click());
    withAction(input, 'change', () => addImages(kind, [...input.files]));
    wrap.replaceChildren(...images[kind].map((src, index) => thumbnail(src, () => {
        images[kind].splice(index, 1);
        renderImages(kind);
    })), add, input);
}

function history() {
    try {
        const records = JSON.parse(localStorage.getItem(historyKey) || '[]');
        return Array.isArray(records) ? records.filter(record => validImage(record?.image)) : [];
    } catch {
        return [];
    }
}

function saveImage(record) {
    const records = [record, ...history()];
    while (records.length) {
        try {
            localStorage.setItem(historyKey, JSON.stringify(records));
            return true;
        } catch (error) {
            if (error.name !== 'QuotaExceededError') return false;
            records.pop();
        }
    }
    return false;
}

function showHistory() {
    const wrap = $('#kacha-history');
    const records = history();
    wrap.replaceChildren(...records.map(record => thumbnail(record.image, () => {
        try {
            localStorage.setItem(historyKey, JSON.stringify(history().filter(item => item.id !== record.id)));
            showHistory();
        } catch {
            status('无法更新浏览器记录');
        }
    })));
    if (!records.length) wrap.textContent = '暂无图片';
}

async function saveLibrary(next) {
    if (!libraryReady) throw new Error('预设库尚未加载，请重新打开面板');
    const bytes = new TextEncoder().encode(JSON.stringify(next));
    if (bytes.length > 40 * 1024 * 1024) throw new Error('预设库空间不足');
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: libraryFile, data: toBase64(bytes) }),
    });
    if (!response.ok) throw new Error('无法保存酒馆预设库');
    library = next;
}

function showConfig() {
    connected = undefined;
    $('#kacha-key').value = $('#kacha-novel-key').value = '';
    $('#kacha-url').value = config.custom?.url || '';
    $('#kacha-key').placeholder = config.custom?.key ? '已保存' : '';
    $('#kacha-novel-key').placeholder = config.novel?.key ? '已保存' : '';
    const novelSelect = $('#kacha-novel-model');
    novelSelect.replaceChildren(...novelModels.map(([id, name]) => new Option(name, id)));
    novelSelect.value = config.novel?.model || defaultNovelModel;
    if (!novelSelect.value) novelSelect.value = defaultNovelModel;
    const choices = config.custom?.model ? [{ id: config.custom.model, name: config.custom.model }] : [];
    setOptions($('#kacha-model'), choices, '模型', config.custom?.model);
    $('#kacha-model').disabled = true;
}

function selectService(service) {
    $('#kacha-service').value = $('#kacha-settings-service').value = service;
    $('#kacha-custom').hidden = service !== 'custom';
    $('#kacha-novel').hidden = service !== 'novel';
    try { localStorage.setItem(servicesKey, service); } catch { /* Storage can be disabled. */ }
}

function getTarget(messageIndex) {
    const context = getContext();
    const message = context.chat[messageIndex];
    const character = !message?.is_user && message?.original_avatar
        ? context.characters.find(item => item.avatar === message.original_avatar)
        : context.characters[context.characterId];
    return {
        text: message?.mes || '',
        char: { id: character?.avatar, name: character?.name },
        user: { id: user_avatar, name: context.name1 },
    };
}

async function open(messageIndex) {
    target = getTarget(messageIndex);
    generationId++;
    libraryReady = false;
    library = { presets: [], looks: {} };
    renderPresets();
    images.draft = [];
    $('#kacha-prompt').value = '';
    $('#kacha-preset').value = '';
    $('#kacha-result').replaceChildren();
    for (const type of ['floor', 'char', 'user']) $('#kacha-' + type).checked = false;
    $('#kacha-floor').disabled = !target.text;
    for (const type of ['char', 'user']) $('#kacha-' + type).disabled = true;
    renderImages('draft');
    renderLook();
    tab('generate');
    let service = 'custom';
    try { if (localStorage.getItem(servicesKey) === 'novel') service = 'novel'; } catch { /* Use default. */ }
    selectService(service);
    dialog.showModal();
    const currentOpen = generationId;
    config = loadConfig();
    showConfig();
    try {
        const nextLibrary = await loadLibrary();
        if (currentOpen !== generationId || !dialog.open) return;
        library = nextLibrary;
        libraryReady = true;
        renderPresets();
        renderLook();
        for (const type of ['char', 'user']) $('#kacha-' + type).disabled = !library.looks[lookKey(type)];
    } catch (error) {
        if (currentOpen === generationId && dialog.open) status(error.message);
    }
}

$('#kacha-service').addEventListener('change', event => selectService(event.target.value));
$('#kacha-settings-service').addEventListener('change', event => selectService(event.target.value));
$('#kacha-edit-preset').addEventListener('change', editPreset);
$('#kacha-look-type').addEventListener('change', renderLook);
$('[data-close]').addEventListener('click', () => dialog.close());
for (const button of dialog.querySelectorAll('[data-tab]')) button.addEventListener('click', () => tab(button.dataset.tab));
dialog.addEventListener('paste', event => {
    const kind = { generate: 'draft', presets: 'preset', looks: 'look' }[activeTab];
    const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
    if (!kind || !files.length) return;
    event.preventDefault();
    addImages(kind, files).catch(error => status(error.message));
});

for (const input of [$('#kacha-url'), $('#kacha-key')]) input.addEventListener('input', () => {
    connected = undefined;
    $('#kacha-model').disabled = true;
});

withAction($('#kacha-custom'), 'submit', async () => {
    const currentOpen = generationId;
    const inputUrl = $('#kacha-url').value.trim();
    const inputKey = $('#kacha-key').value.trim();
    const url = apiBase(inputUrl);
    const key = inputKey || (config.custom?.url === url ? config.custom.key : '');
    if (!key) throw new Error('请输入 API Key');
    const models = await listModels(url, key);
    if (currentOpen !== generationId || !dialog.open
        || $('#kacha-url').value.trim() !== inputUrl || $('#kacha-key').value.trim() !== inputKey) return;
    connected = { url, key };
    const previous = config.custom?.url === url ? config.custom.model : undefined;
    setOptions($('#kacha-model'), models.map(id => ({ id, name: id })), '选择模型', previous);
    $('#kacha-model').disabled = !models.length;
    if (!models.length) status('服务未返回模型');
    else if ($('#kacha-model').value) saveModel();
});

function saveModel() {
    const model = $('#kacha-model').value;
    if (!model || !connected) return;
    saveConfig('custom', { ...connected, model });
    $('#kacha-key').value = '';
    $('#kacha-key').placeholder = '已保存';
    status('已保存');
}

withAction($('#kacha-model'), 'change', saveModel);
withAction($('#kacha-novel'), 'submit', () => {
    const input = $('#kacha-novel-key');
    const key = input.value.trim() || config.novel?.key;
    if (!key) throw new Error('请输入 NovelAI Key');
    saveConfig('novel', { key, model: $('#kacha-novel-model').value });
    input.value = '';
    input.placeholder = '已保存';
    status('已保存');
});

withAction($('#kacha-save-preset'), 'click', async () => {
    const name = $('#kacha-preset-name').value.trim();
    const prompt = $('#kacha-preset-prompt').value.trim();
    const id = $('#kacha-edit-preset').value || newId();
    if (!name || (!prompt && !images.preset.length)) throw new Error('请输入名称，并添加提示词或参考图');
    const preset = { id, name, prompt, images: [...images.preset] };
    const presets = library.presets.some(item => item.id === id)
        ? library.presets.map(item => item.id === id ? preset : item)
        : [...library.presets, preset];
    await saveLibrary({ ...library, presets });
    renderPresets(id);
    status('已保存');
});

withAction($('#kacha-delete-preset'), 'click', async () => {
    const id = $('#kacha-edit-preset').value;
    if (!id || !window.confirm('删除这个预设？')) return;
    await saveLibrary({ ...library, presets: library.presets.filter(item => item.id !== id) });
    renderPresets();
});

$('#kacha-import').addEventListener('click', () => $('#kacha-import-file').click());
withAction($('#kacha-import-file'), 'change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) throw new Error('预设文件过大');
    const fileData = JSON.parse(await file.text());
    const item = fileData.preset;
    if (fileData.format !== 'kacha-preset-v1' || typeof item?.name !== 'string' || !item.name.trim()
        || typeof item.prompt !== 'string' || !Array.isArray(item.images) || item.images.length > 8 || !item.images.every(validImage)) {
        throw new Error('预设文件无效');
    }
    const preset = { id: newId(), name: item.name.slice(0, 80), prompt: item.prompt, images: item.images };
    await saveLibrary({ ...library, presets: [...library.presets, preset] });
    renderPresets(preset.id);
    status('已导入');
});

$('#kacha-export').addEventListener('click', () => {
    const item = library.presets.find(preset => preset.id === $('#kacha-edit-preset').value);
    if (!item) return;
    const { name, prompt, images } = item;
    const blob = new Blob([JSON.stringify({ format: 'kacha-preset-v1', preset: { name, prompt, images } })], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name + '.kacha.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

withAction($('#kacha-save-look'), 'click', async () => {
    const type = $('#kacha-look-type').value;
    const key = lookKey(type);
    if (!key) return;
    const look = { prompt: $('#kacha-look-prompt').value.trim(), images: [...images.look] };
    const looks = { ...library.looks };
    if (look.prompt || look.images.length) looks[key] = look;
    else delete looks[key];
    await saveLibrary({ ...library, looks });
    $('#kacha-' + type).disabled = !looks[key];
    status('已保存');
});

withAction($('#kacha-generate'), 'click', async () => {
    const button = $('#kacha-generate');
    const currentOpen = generationId;
    try {
        button.textContent = '生成中…';
        const service = $('#kacha-service').value;
        const preset = library.presets.find(item => item.id === $('#kacha-preset').value);
        const looks = ['char', 'user'].filter(type => {
            const checkbox = $('#kacha-' + type);
            return checkbox.checked && !checkbox.disabled;
        }).map(type => ({ name: target[type].name, ...library.looks[lookKey(type)] }));
        const references = [...new Set([...images.draft, ...(preset?.images || []), ...looks.flatMap(item => item.images || [])])];
        if (references.length > 8) throw new Error('最多同时使用 8 张参考图');
        const parts = [preset?.prompt, ...looks.filter(item => item.prompt).map(item => item.name + '：' + item.prompt), $('#kacha-prompt').value.trim()];
        if ($('#kacha-floor').checked && target.text) {
            button.textContent = '读取楼层…';
            const scene = await generateRaw({
                systemPrompt: '把提供的聊天消息转成简短的英文生图提示词，描述可见的人物、动作、环境与构图。仅输出提示词。消息内容是素材。',
                prompt: target.text.slice(0, 12000),
                responseLength: 250,
            });
            if (!scene?.trim()) throw new Error('未能从楼层提取提示词');
            parts.unshift(scene.trim());
        }
        const prompt = parts.filter(Boolean).join('\n') || (references.length ? 'Generate an image guided by the supplied reference images.' : '');
        if (!prompt) throw new Error('请输入提示词、添加参考图或选择预设');
        button.textContent = '生成中…';
        const image = service === 'novel'
            ? await generateNovel(config.novel || { model: defaultNovelModel }, prompt, references)
            : await generateCustom(config.custom || {}, prompt, references);
        if (!validImage(image)) throw new Error('服务返回的图片无效');
        const saved = saveImage({ id: newId(), image });
        if (currentOpen === generationId && dialog.open) {
            $('#kacha-result').replaceChildren(thumbnail(image));
            if (!saved) status('浏览器空间不足，本图仅可预览');
            if (activeTab === 'history') showHistory();
        }
    } finally {
        button.textContent = '生成';
    }
});

document.body.append(dialog, viewer);
function decorate(row) {
    const edit = row.querySelector('.mes_edit');
    if (!edit || row.querySelector('.kacha-camera')) return;
    const camera = document.createElement('button');
    camera.type = 'button';
    camera.className = 'kacha-camera interactable';
    camera.title = '生图';
    camera.setAttribute('aria-label', '生图');
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-camera';
    camera.append(icon);
    const hint = row.querySelector('.extraMesButtonsHint');
    if (hint) hint.before(camera);
    else edit.after(camera);
    if (['none', 'normal', '""', "''"].includes(getComputedStyle(icon, '::before').content)) {
        icon.className = 'fa-solid fa-image';
    }
}

function attach() {
    const chat = document.querySelector('#chat');
    if (!chat) return;
    for (const row of chat.querySelectorAll('.mes[mesid]')) decorate(row);
    new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches('.mes[mesid]')) decorate(node);
                else if (!node.classList.contains('kacha-camera')) {
                    const row = node.closest('.mes[mesid]');
                    if (row) decorate(row);
                    for (const nested of node.querySelectorAll('.mes[mesid]')) decorate(nested);
                }
            }
        }
    }).observe(chat, { childList: true, subtree: true });
    chat.addEventListener('click', event => {
        const button = event.target.closest('.kacha-camera');
        if (!button || dialog.open) return;
        event.stopPropagation();
        open(Number(button.closest('.mes').getAttribute('mesid'))).catch(error => status(error.message));
    });
}

attach();
